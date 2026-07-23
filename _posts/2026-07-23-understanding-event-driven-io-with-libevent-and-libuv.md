---
layout: post
title: Understanding Event-Driven I/O with libevent and libuv
date: 2026-07-23 14:00:00 +0800
description: What I learned about file descriptors, non-blocking I/O, event loops, callbacks, and the boundary between event-driven code and threads.
tags: [Linux, Programming, Embedded Systems]
categories: [Technical Notes]
featured: true
---

Over the past few days, I have been learning how **libevent** and **libuv** organize asynchronous I/O. The individual APIs are not the hardest part. The real challenge is building the right mental model:

- What exactly is a file descriptor?
- What does “non-blocking” mean?
- If an event loop has only one thread, how can it handle several devices?
- When multiple events arrive together, which callback runs?
- If threads can run in parallel, why use a single-threaded event loop at all?

This article records the answers that finally made the model clear to me.

## 1. Start with file descriptors

On Linux, a **file descriptor**, usually abbreviated as **fd**, is a small integer that identifies an open resource inside a process.

```text
fd 0  -> standard input
fd 1  -> standard output
fd 2  -> standard error
fd 4  -> a CAN socket
fd 5  -> a UART device
fd 6  -> a listening socket
```

The descriptor is not the resource itself. It is a handle that the process uses when asking the kernel to operate on that resource:

```c
read(fd, buffer, size);
write(fd, data, length);
close(fd);
```

This common interface is important because an event library can monitor many different resources in the same way. A TCP socket, a CAN socket, a pipe, a `timerfd`, and some device files can all participate in one event loop.

## 2. Why blocking I/O becomes a problem

Consider a normal blocking read:

```c
read(can_fd, buffer, sizeof(buffer));
```

If no CAN frame is available, the calling thread waits. While it is waiting, that thread cannot process a UART message, a Bluetooth request, or an expired timer.

A naive program might try to check every source repeatedly:

```c
while (running) {
    check_can();
    check_uart();
    check_bluetooth();
    check_timers();
}
```

This is polling. It can waste CPU time when nothing is happening, and it becomes awkward as the number of event sources grows.

Linux provides a better mechanism through facilities such as `epoll`: the application tells the kernel which descriptors it is interested in, and the kernel reports which ones are ready.

```text
CAN fd  -----\
UART fd ------> kernel waits for readiness ---> event loop wakes up
GATT fd -----/
timerfd -----/
```

The application does not wait on one device at a time. The kernel waits on all registered sources together.

## 3. The event loop model

At a high level, an event loop behaves like this:

```text
while the application is running:
    wait until one or more events are ready
    mark those events as active
    call the callback associated with each active event
```

With libevent, a read event may be registered like this:

```c
struct event *can_event = event_new(
    base,
    can_fd,
    EV_READ | EV_PERSIST,
    can_read_callback,
    context
);

event_add(can_event, NULL);
```

This says:

> Monitor `can_fd`. Whenever it becomes readable, call `can_read_callback`.

libuv expresses the same general architecture with different types and APIs. Both libraries connect operating-system event notification to application callbacks.

## 4. What happens when several events arrive?

Suppose the application has registered three callbacks:

```text
CAN fd  ready -> can_callback()
UART fd ready -> uart_callback()
GATT fd ready -> gatt_callback()
```

If all three descriptors become ready, the event loop activates all three events. In a single-threaded loop, the callbacks are normally executed one after another:

```text
can_callback()
uart_callback()
gatt_callback()
```

The order may vary unless explicit priorities are configured, so application correctness should not depend on an accidental ordering between events of equal priority.

Sequential execution is not the same as blocking. A callback that processes already-available data and returns quickly is simply taking its turn. Blocking occurs when the callback waits for something that has not happened yet.

For example, this is dangerous:

```c
static void can_callback(int fd, short events, void *arg)
{
    read(fd, buffer, sizeof(buffer));  /* current frame */
    read(fd, buffer, sizeof(buffer));  /* may wait for a future frame */
}
```

A common non-blocking pattern is to drain the data that is already available and stop when the kernel reports `EAGAIN`:

```c
static void can_callback(int fd, short events, void *arg)
{
    for (;;) {
        ssize_t n = read(fd, buffer, sizeof(buffer));

        if (n > 0) {
            process_frame(buffer, n);
            continue;
        }

        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            break;

        break;
    }
}
```

The callback then returns control to the event loop so that other ready events can run.

## 5. Asynchronous and non-blocking are related, but different

These two terms are often used together:

- **Non-blocking** describes an operation that returns immediately when it cannot make progress.
- **Asynchronous** describes a control flow in which work is started now and its completion is handled later.

For example:

```text
register interest in a socket
        |
        v
continue handling other work
        |
        v
kernel reports that the socket is readable
        |
        v
event loop invokes the read callback
```

The application expresses interest at one point in time and receives the result later through a callback. No thread has to remain blocked on that socket.

## 6. A practical embedded example: CAN and sampling

This model became much clearer when I applied it to an embedded acquisition system containing CAN, UART, Bluetooth GATT, and a sampling state machine.

The design has two important event sources:

```text
CAN fd readable event  -> receive and parse CAN frames
1 ms timer event       -> advance the sampling state machine
```

Sampling is not implemented as one long blocking function. Instead, it is split into small phases:

```text
configure an LED over CAN
        |
wait until a deadline, without sleeping
        |
send a sampling command
        |
request data from a node
        |
return to the event loop
        |
CAN response arrives and activates the CAN callback
        |
store the response and mark the node as ready
        |
a later timer tick advances the state machine
```

The key point is that CAN reception and sampling are not two large tasks where one must finish completely before the other begins. They cooperate:

```text
sampling tick sends a CAN request
CAN callback receives the response
next sampling tick observes the response
sampling state machine continues
```

Waiting is represented as state plus a deadline, not as `sleep()`:

```c
state->deadline_ms = now_ms + 3;
state->phase = WAIT_FOR_LED;
return;
```

On later timer ticks:

```c
if (now_ms < state->deadline_ms)
    return;

state->phase = START_ADC;
```

During those three milliseconds, the main thread remains free to process CAN, UART, GATT, and other timers.

## 7. Why a single-threaded loop is still useful

At first, a single-threaded event loop can look inferior to multiple threads. Multiple threads can run on several CPU cores, while callbacks on one loop execute sequentially.

The missing detail is that I/O-driven programs usually spend much more time waiting than computing. The event loop lets the kernel wait for many I/O sources simultaneously, then performs only the short amount of work required for each ready event.

A single-threaded event loop provides several useful properties:

- Shared state is naturally serialized.
- Callback ordering is easier to reason about.
- Fewer mutexes are required.
- Deadlocks and data races are less likely.
- Thread stacks and context switches are reduced.
- Startup and shutdown become simpler.

In an embedded system, a Bluetooth command, a CAN response, and a sampling timer may all touch the same state. Running their small handlers on one thread often makes the system more deterministic than allowing three threads to modify that state concurrently.

This does not mean that threads are bad. They are valuable for:

- CPU-intensive signal processing
- Compression or encryption
- Blocking APIs that cannot be converted to event-driven I/O
- Long-running work that would delay other callbacks

The practical design is often hybrid:

```text
main event-loop thread
├── CAN
├── UART
├── GATT
├── timers
└── state machines

worker threads
├── expensive calculations
└── unavoidable blocking operations
```

The rule is simple: keep event-loop callbacks short, and move genuinely expensive or blocking work elsewhere.

## 8. How worker threads notify the event loop

A worker thread does not automatically become part of the main event loop. It needs a thread-safe notification mechanism.

libuv provides `uv_async_send()` for this purpose:

```text
worker thread
    |
    | uv_async_send()
    v
main event loop wakes up
    |
    v
async callback runs on the loop thread
```

With libevent on Linux, a similar mechanism can be built using an `eventfd`, pipe, or socket pair:

```text
worker thread
    |
    | enqueue result
    | write(eventfd)
    v
eventfd becomes readable
    |
    v
libevent invokes its callback on the main thread
    |
    v
main thread consumes the queued result
```

The notification transfers control back to the event-loop thread. Shared data still needs a mutex, atomics, or a thread-safe queue.

## 9. libevent and libuv: the common idea

libevent and libuv differ in API design and scope, but the central model is similar:

| Concept | libevent | libuv |
|---|---|---|
| Event loop | `event_base` | `uv_loop_t` |
| I/O readiness | `event_new()` and callbacks | stream, poll, and handle callbacks |
| Timers | timer events | `uv_timer_t` |
| Cross-thread notification | commonly `eventfd`, pipe, or `event_active()` with configured threading | `uv_async_t` and `uv_async_send()` |
| Worker execution | application threads or external thread pools | `uv_queue_work()` and the libuv thread pool |

libuv offers a broader cross-platform abstraction for networking, files, processes, DNS, and threads. libevent focuses strongly on event notification, timers, and network-oriented building blocks. Choosing between them depends on the application, but understanding either one teaches the same fundamental lesson:

> Do not block while waiting for I/O. Register interest, return control to the loop, and react when the event becomes ready.

## 10. The mental model I will keep

My final mental model is:

1. An fd is a process-local handle for a kernel resource.
2. The kernel can monitor many fds at the same time.
3. The event loop maps each ready fd or timer to a callback.
4. Several active callbacks normally run sequentially on the loop thread.
5. Sequential does not mean blocking.
6. A callback blocks the loop only when it waits or performs excessive work.
7. Long workflows should be split into short state-machine steps.
8. Threads are useful for real parallel work, but they must notify the main loop explicitly.

Once I stopped imagining the event loop as “one thread waiting on one device,” the architecture made sense. It is one thread coordinating many sources of readiness, while the operating system performs the waiting efficiently.
