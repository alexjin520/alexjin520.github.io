---
layout: post
title: Sharing One Debug UART Between Linux and RISC-V with RPMsg
date: 2026-08-06 10:30:00 +0800
description: How I replaced cross-core UART contention with a buffered RPMsg log relay, a host-ready handshake, and a race-free startup sequence.
tags: [Embedded Linux, RISC-V, RPMsg, Linux Kernel]
categories: [Technical Notes]
featured: true
---

I recently brought up the RISC-V auxiliary core on an Ingenic X2600 board. Linux runs on the main core, while a small FreeRTOS firmware image runs on the RISC-V core. Both sides had useful debug output, but they also tried to use the same physical UART.

That made an otherwise simple logging problem surprisingly difficult. A line from Linux could be interrupted halfway through by a line from RISC-V. Boot messages were sometimes missing, shell escape sequences leaked into the output, and the result depended on which core reached the UART first.

The solution was not a more complicated UART lock. I gave Linux exclusive ownership of the UART and turned the small core's output into messages:

```text
RISC-V printf -> ring buffer -> RPMsg -> Linux driver -> printk -> UART
```

This article describes the complete path, including the two startup races that only appeared during cold boot.

## 1. One peripheral needs one owner

The initial design effectively looked like this:

```text
Linux printk ---------------------> UART
RISC-V printf --------------------> UART
```

The two cores do not share a scheduler, and an ordinary mutex on one core cannot serialize code running on the other. A hardware spinlock or a custom shared-memory lock could protect individual writes, but it would introduce several new questions:

- What happens if one core crashes while holding the lock?
- Can an interrupt handler wait for it safely?
- How are clocks, pin configuration, and baud-rate changes coordinated?
- How are messages distinguished after they reach the terminal?

The cleaner rule is:

> Linux owns the debug UART. RISC-V produces log records, not UART transactions.

This moves serialization to one place and keeps all board-level UART configuration under Linux control.

## 2. The resulting data path

I reused the board's existing RPMsg transport. Endpoint 1 is reserved for RISC-V logs, while other endpoints remain available for their original console or application traffic.

```text
RISC-V / FreeRTOS                         Linux

printf / prom_printk
        |
        v
    _write()
        |
        v
rtos_console_write()
        |
        v
8 KiB circular buffer
        |
        v
log forwarding task
        |
        v
riscv_log_send()
        |
        +------ RPMsg endpoint 1 ------> receive callback
                                              |
                                              v
                                        bounded skb queue
                                              |
                                              v
                                           worker
                                              |
                                              v
                                      printk("[RISCV] ...")
                                              |
                                              v
                                             UART
```

There are two important boundaries in this diagram. The circular buffer separates log producers from RPMsg availability on the small core. The Linux queue and worker separate the RPMsg receive callback from text formatting and console output.

## 3. Redirecting the small-core output

The firmware already had a newlib-style `_write()` hook used by `printf()`. Instead of sending bytes to a UART, `_write()` now passes them to `rtos_console_write()`, which appends them to an 8 KiB circular buffer.

The same path also handles low-level firmware printing. I added relay implementations of `prom_printk()`, `prom_putchar()`, and `prom_putstr()` so code below the C library does not bypass the new ownership rule.

Conceptually, every producer now ends at the same function:

```c
int rtos_console_write(char *data, int len)
{
    int written = circ_buffer_write(&log_buffer, data, len);

    if (log_task_ready)
        wake_log_task();

    return written;
}
```

The real implementation also chooses the interrupt-safe semaphore operation when called from interrupt context.

A dedicated FreeRTOS task drains the buffer in RPMsg-sized chunks. Application code therefore continues to use normal calls such as:

```c
printf("sensor task started\n");
```

There is no need to call `riscv_log_send()` from each feature. Keeping that transport detail below `printf()` makes the mechanism easy to adopt and difficult to bypass accidentally.

The RISC-V firmware build also excludes its direct serial implementation. Redirection is only reliable if no second code path can silently reclaim the UART.

## 4. Preserving early boot messages

Buffering solves a scheduling problem, but it does not by itself solve startup ordering.

The small core may start before Linux has probed the RPMsg device and installed its receive callback. If the forwarding task drains immediately, RPMsg can accept or discard data before a Linux consumer exists. The most valuable boot messages then disappear.

I added a tiny ready protocol:

```text
RISC-V creates endpoint 1 and buffers logs
                    |
                    v
Linux probes endpoint 1 and installs callback
                    |
                    v
Linux sends "RISC-V-LOG-READY"
                    |
                    v
RISC-V marks host_ready = true
                    |
                    v
RISC-V drains all buffered startup logs
```

Until this exact message arrives, `riscv_log_send()` refuses to transmit and the log task leaves the circular buffer intact. Once the handshake is received, the task wakes and flushes both early and current output in order.

The marker is deliberately a protocol message instead of a fixed delay. A 100 ms delay may work on one image and fail on another; “the receiver has installed its callback” is the state the sender actually needs to know.

## 5. The name-service race: retrying is not waiting

The first handshake implementation still failed intermittently during a cold boot. Linux reported that the RPMsg host was online, but it never created the named channels. Endpoint 1 did not appear, so Linux never had a device on which to send the ready message.

The problem was in endpoint announcement. The helper attempted `rpmsg_ns_announce()` repeatedly while it returned `RL_NOT_READY`. It performed 65,535 tight retries, which sounds generous. In practice, all those iterations could finish before Linux brought up the remote virtio/RPMsg link.

This is a useful embedded-systems lesson:

```text
many immediate retries != waiting for a state transition
```

The fix was to wait on the condition represented by the transport itself:

```c
rpmsg_lite_wait_for_link_up(rpmsg_instance);

ret = rpmsg_ns_announce(rpmsg_instance,
                        rpmsg_endpoint,
                        endpoint_name,
                        0);
```

After the link-up wait returns, one announcement is enough. Linux then creates the `ingenic_rpmsg` channels for endpoints 1, 2, and 3 consistently.

This race was easy to misdiagnose because the remote processor itself was already shown as `running`. That state only means the firmware is executing. It does not prove that the RPMsg link is up, name service completed, a Linux driver bound, or the log handshake succeeded.

## 6. Keeping the Linux receive callback short

On Linux, I extended the existing Ingenic RPMsg driver so that one configured endpoint is consumed by the kernel log relay. Other endpoints retain the original character-device behavior.

The receive callback executes in a context where blocking console work is undesirable. It therefore performs only bounded operations:

1. Allocate an `sk_buff` with `GFP_ATOMIC`.
2. Copy the incoming RPMsg payload.
3. Append it to a spinlock-protected queue.
4. Schedule a work item.
5. Return.

The worker drains the queue later and emits the text with `pr_info()`.

I also bounded both memory and output behavior:

- The queue holds at most 128 RPMsg log messages.
- A rendered line is limited to 512 bytes.
- Carriage returns are removed.
- Unexpected control characters become `.` instead of reaching the terminal.
- Overflow increments a drop counter and produces a warning.

Every relayed line receives an explicit prefix:

```text
[RISCV] riscv start
[RISCV] RISC-V printer log relay ready
```

Linux's own messages keep their normal format. The prefix makes the origin visible even though both cores now share the same final UART.

Endpoint 1 becomes a single-consumer channel once the kernel relay is enabled, so userspace opening that character device receives `-EBUSY`. This prevents a userspace reader and the kernel worker from competing for the same log records.

## 7. Boot integration matters too

On this board, U-Boot may start an RISC-V image before Linux boots. The Linux remoteproc state can therefore already say `running`, and the firmware name can already be `console.elf`.

That still does not guarantee that the running bytes match the firmware installed in the current root filesystem. An older image with the same filename may lack the ready-handshake implementation and wait forever or lose early logs.

The init script consequently reloads `console.elf` once per Linux boot:

```text
first start in this Linux boot
    -> stop an already-running image if necessary
    -> select console.elf
    -> start remoteproc
    -> create a volatile marker under /run

later duplicate start
    -> firmware is running, endpoint exists, marker exists
    -> do nothing
```

The marker prevents unnecessary resets during the same boot, while its location under `/run` makes it disappear on reboot. It records that the Linux init script performed its reload; it is not a substitute for the RPMsg ready handshake.

This small distinction is important. A process marker, remoteproc state, link state, channel state, and application readiness are five different facts.

## 8. Verifying the complete chain

I tested the feature as a chain of observable states rather than relying on one “running” flag.

First, confirm that the intended firmware is running:

```sh
cat /sys/class/remoteproc/remoteproc0/firmware
cat /sys/class/remoteproc/remoteproc0/state
```

Expected values are `console.elf` and `running`.

Next, confirm that name service produced the endpoints:

```sh
ls -l /sys/class/ingenic_rpmsg/
```

The result should include `rpmsg-1`, `rpmsg-2`, and `rpmsg-3`. Endpoint 1 proves that Linux saw the log-channel announcement.

Finally, inspect the kernel ring buffer:

```sh
dmesg | grep -E 'forwarding RISC-V|ready handshake|\[RISCV\]'
```

A successful cold boot contains all three stages:

```text
forwarding RISC-V endpoint 1 to kernel console
RISC-V log ready handshake sent
[RISCV] riscv start
[RISCV] RISC-V printer log relay ready
```

The BusyBox version of `dmesg` on this target does not support `dmesg -w`, so repeated snapshots or the serial console itself are more portable ways to watch new output.

For an active test, any RISC-V task can call `printf("printer relay test\n")`. Seeing `[RISCV] printer relay test` in the Linux log confirms the full path from the C library, through the FreeRTOS buffer and RPMsg, to the Linux worker and UART.

## 9. What this design taught me

The final code is relatively small, but the design carries several reusable lessons.

**Prefer ownership over distributed locking.** When two processors want one peripheral, choose one owner and communicate with it. The resulting failure modes are much easier to reason about.

**Readiness is protocol state.** Processor running, link up, channel announced, callback installed, and application ready are not synonyms. If a sender depends on one of them, represent it explicitly.

**Retry based on time or state, not iteration count.** A huge tight loop may take less time than the device on the other side needs for one scheduling interval.

**Keep transport callbacks bounded.** Queue the data in the callback and do formatting, console output, and other potentially slow work in task or process context.

**Buffer at asynchronous boundaries.** The small-core ring buffer protects early logs and decouples producers from link timing. The Linux queue decouples RPMsg delivery from the console.

**Make observability part of the design.** The `[RISCV]` prefix, ready-handshake messages, endpoint sysfs entries, and drop warnings turned a multi-stage boot sequence into something that can be inspected one invariant at a time.

The most important outcome is not merely that two cores can print. It is that there is now one deterministic logging path, one UART owner, and a startup protocol that explains exactly when logs are safe to send.
