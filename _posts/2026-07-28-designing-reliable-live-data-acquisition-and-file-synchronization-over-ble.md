---
layout: post
title: Designing Reliable Live Data Acquisition and File Synchronization over BLE
date: 2026-07-28 15:00:00 +0800
description: How I separated live waveform preview from lossless file delivery, tailed a growing recording, and made Stop mean drain and verify instead of disconnect.
tags: [Bluetooth Low Energy, Embedded Linux, Data Integrity, Systems Design]
categories: [Technical Notes]
featured: true
---

I recently worked on an embedded physiological-sensing system with a deceptively simple requirement:

> Show live waveforms on a phone while recording, download the complete recording at the same time, and deliver whatever remains after the user presses Stop.

The device already supported the two endpoints independently. It could stream samples for a live chart, and it could generate a binary file and transfer that file later. Combining them changed the problem.

The file was no longer static while it was being downloaded. The producer could append data faster than BLE could transmit it, and stopping acquisition did not mean that the consumer had received the end of the file. A correct design therefore had to coordinate three timelines:

```text
sensor acquisition:  produces new samples
file writer:          appends encoded records
BLE synchronizer:     sends and acknowledges file bytes
```

This article explains the mental model and protocol that made the system reliable.

## 1. Live preview and complete delivery are different products

It is tempting to treat every byte sent over BLE as one stream, but a live waveform and a complete recording have different contracts.

A **live preview** is optimized for immediacy:

- New samples matter more than old samples.
- A bounded queue is necessary.
- Downsampling or compact encoding may be acceptable.
- If the phone falls behind, dropping stale preview data can be better than increasing latency forever.

A **recording transfer** is optimized for completeness:

- Every byte must arrive in order.
- Missing data must be retransmitted.
- Progress must survive temporary stalls or reconnects.
- Completion must be verified against a stable final file.

These paths may share a BLE connection, but they should not share semantics.

```text
                         ┌─> live preview queue ─> waveform notifications
sensor nodes ─> acquire ─┤
                         └─> append-only file ──> file synchronization
```

The live path answers, “What is happening now?” The file path answers, “Can I reconstruct the entire session exactly?”

## 2. A growing file does not have a normal EOF

Downloading a completed file is straightforward:

1. Read its size.
2. Send chunks until the offset reaches that size.
3. Verify the result.

A growing file breaks the first assumption. Reaching the current end of the file only means that the reader has caught up **for now**. More data may appear on the next acquisition cycle.

The transfer loop therefore needs to distinguish two cases:

```text
reader offset == currently available bytes
    + writer still active   -> wait for growth and continue
    + writer finalized      -> this is the real end of the file
```

I modeled the file as an append-only log. The writer owns the production offset, while the synchronizer owns the acknowledged offset:

```text
0                                                        produced_offset
|================ acknowledged ================|---- pending ----|
                                                ^
                                                acknowledged_offset
```

The sender never needs to load the entire recording into memory. It reads a bounded chunk from the acknowledged or next-send offset, transmits it, and retains only enough state to retry unacknowledged data.

If buffered standard I/O is used, the writer must flush application buffers before expecting another file descriptor to observe newly appended bytes. `fsync()` is a separate durability decision: it protects against storage or power failure, but it should not be confused with protocol-level delivery.

## 3. Use offsets as the source of truth

Packets can be duplicated, delayed, or lost. A transfer protocol becomes much easier to reason about when progress is represented by a byte offset rather than by a count of packets sent.

A data message can contain:

```text
session_id | file_offset | payload_length | payload
```

The phone responds with a cumulative acknowledgment:

```text
ACK next_expected_offset
```

If the phone acknowledges offset `65536`, it is confirming that every byte before `65536` is present. The device can discard any buffered chunks fully below that offset.

Cumulative acknowledgments provide useful properties:

- Repeating a chunk is harmless.
- Repeating an ACK is harmless.
- Lost ACKs do not corrupt progress.
- Reconnection can resume from a confirmed offset.
- Logs describe transfer state in bytes, independent of BLE packet sizing.

The key invariant is:

```text
0 <= acknowledged_offset <= sent_offset <= produced_offset
```

Violating this invariant indicates a state-machine or bookkeeping bug, not a radio-quality problem.

## 4. Backpressure is unavoidable

Suppose the recording grows at rate \(R_p\) and BLE delivers file data at net rate \(R_t\).

If:

```text
R_t >= R_p
```

the synchronizer can eventually catch up while acquisition is still active.

If:

```text
R_t < R_p
```

the unsent backlog must grow. No retry strategy or thread optimization can change that conservation law.

After an acquisition lasting \(T\), the approximate backlog is:

\[
B \approx \max(0, R_p - R_t)T
\]

and the minimum drain time after Stop is:

\[
T\_{\text{drain}} \approx \frac{B}{R_t}
\]

Protocol overhead, retransmissions, connection intervals, and flash-read contention make the real time longer.

This observation changed the user-interface contract. “Stop acquisition” can happen immediately, but “file synchronization complete” may happen later. Those are separate events and should be displayed separately.

It also suggests several engineering choices:

- Keep preview traffic bounded so it cannot starve file transfer.
- Reduce redundant fields in the on-disk format.
- Batch payloads up to an effective BLE chunk size.
- Avoid per-packet logging on the critical path.
- Report both acquisition state and synchronization progress to the phone.

## 5. Stop is a transition, not global cleanup

The first failing design treated Stop as the end of the whole session:

```text
Stop pressed
    -> stop sensors
    -> close the file
    -> cancel transfer callbacks
    -> release BLE/session state
```

That sequence is attractive because it looks like simple cleanup. It is also wrong when file delivery is still active.

The acquisition producer should stop first, but the transfer consumer must remain alive until it has drained the finalized tail. I separated the lifecycle into explicit states:

```text
IDLE
  |
  v
COLLECTING_AND_SYNCING
  |
  | Stop requested
  v
STOPPING_PRODUCER
  |
  | writer flushed and final size captured
  v
DRAINING_TAIL
  |
  | acknowledged_offset == final_size
  v
VERIFYING
  |
  | size and CRC32 match
  v
COMPLETE
```

The important boundary is between `STOPPING_PRODUCER` and `DRAINING_TAIL`. Only after the writer has finished appending can the system capture a stable `final_size` and final CRC32.

In simplified pseudocode:

```c
void on_stop_requested(struct session *s)
{
    s->acquisition_state = ACQUISITION_STOPPING;
    stop_sensor_requests_async(s);
}

void on_writer_finalized(struct session *s,
                         uint64_t final_size,
                         uint32_t final_crc32)
{
    s->final_size = final_size;
    s->final_crc32 = final_crc32;
    s->transfer_state = TRANSFER_DRAINING;
    pump_transfer(s);
}

void on_cumulative_ack(struct session *s, uint64_t next_offset)
{
    advance_acknowledged_offset(s, next_offset);

    if (s->writer_finalized &&
        s->acknowledged_offset == s->final_size) {
        send_completion_metadata(s);
        s->transfer_state = TRANSFER_VERIFYING;
        return;
    }

    pump_transfer(s);
}
```

Nothing in the Stop handler waits synchronously for BLE. The event loop remains free to process acknowledgments, retransmission timers, disconnects, and finalization callbacks.

## 6. Asynchronous shutdown is a lifetime problem

The most difficult failure appeared only after Stop. Normal streaming could run for a long time, yet teardown occasionally stalled or disconnected.

The underlying lesson was broader than BLE: canceling an asynchronous operation does not necessarily erase every callback that has already been queued. A callback may still hold a pointer to session state after cleanup has started.

A dangerous sequence looks like this:

```text
callback becomes ready
        |
Stop begins teardown
        |
session resources are released
        |
previously ready callback executes
        |
stale state is accessed
```

The solution is to make ownership and callback lifetime explicit:

- Mark the session as closing before cancellation.
- Make callbacks check the current lifecycle state.
- Stop registering new work once closing begins.
- Cancel or close event-loop handles through their asynchronous APIs.
- Release the session only after all owned handles report completion.
- Keep transfer state alive during the drain phase.
- Make finalization idempotent so repeated errors or disconnect events cannot free the same resource twice.

An event-driven program often needs two forms of completion:

```text
logical completion:  the operation should no longer produce new work
physical completion: no callback can reference its resources again
```

Confusing them is a common source of stop-path bugs.

## 7. Completion requires verification

Reaching `final_size` on the sender is not enough. The phone must confirm that its local file has the same length and content.

The completion exchange can include:

```text
session_id | final_size | final_crc32
```

The phone then:

1. Flushes and closes its local file.
2. Checks the local size.
3. Computes CRC32 over the completed file.
4. Reports success or requests recovery from a known offset.

CRC32 is not a cryptographic integrity mechanism, but it is appropriate for detecting accidental corruption in a transport and storage pipeline. The important point is that verification covers the completed artifact, not only individual BLE messages.

This produces a clear definition of success:

```text
phone_size == device_final_size
    &&
phone_crc32 == device_final_crc32
```

Only then should the UI display “synchronized.”

## 8. Logging the state, not just the error

Timing-dependent failures are hard to diagnose from messages such as “BLE disconnected” or “timeout.” Those are consequences, not causes.

I found it more useful to log a compact snapshot whenever the lifecycle changes:

```text
session=17
acquisition=stopped
writer=finalized
transfer=draining
produced=1824768
sent=491520
acked=475136
pending_chunks=4
connected=true
```

The most valuable fields were:

- Session identifier
- Acquisition state
- Writer state
- Transfer state
- Produced, sent, and acknowledged offsets
- Stable final size, when available
- Number of in-flight chunks
- Retry count
- Connection and callback-lifetime state

With those values, “the download froze” becomes a narrower question:

- Did the writer finalize?
- Did the produced offset stop changing?
- Is the sender waiting for an ACK?
- Did the phone acknowledge beyond what was sent?
- Is a retry timer still registered?
- Was the transfer session released too early?

## 9. Test the transitions that normal use hides

The happy path is not enough for a synchronization protocol. I used transition-focused tests:

- Stop immediately after starting.
- Stop while a chunk is in flight.
- Stop when the reader is exactly at the current file end.
- Slow acknowledgments until the backlog becomes large.
- Drop an ACK and verify idempotent retransmission.
- Disconnect during collection and resume from the last confirmed offset.
- Disconnect during the drain phase.
- Repeat Stop and disconnect notifications.
- Compare device and phone CRC32 values after every completed run.

Randomizing the Stop time was especially effective because it exercised different relationships between file writes, BLE notifications, timers, and callbacks.

For each test, the same invariants should hold:

```text
acknowledged_offset never moves backward
acknowledged_offset never exceeds sent_offset
sent_offset never exceeds available file data
final_size becomes immutable after writer finalization
session memory outlives every callback that can reference it
COMPLETE is reached only after end-to-end verification
```

## 10. What I learned

The final architecture was not one clever BLE optimization. It was a separation of responsibilities:

```text
acquisition controls when data production stops
the writer defines when the file becomes final
the transfer state machine controls reliable delivery
the phone verifies the completed artifact
the event loop coordinates transitions without blocking
```

The most important lessons were:

1. Live display and lossless recording need different policies.
2. Temporary EOF is not completion when a file is still growing.
3. Byte offsets and cumulative acknowledgments make retries idempotent.
4. If production is faster than transport, Stop must be followed by a drain phase.
5. Asynchronous shutdown is fundamentally about ownership and callback lifetime.
6. Completion means that both endpoints agree on size and integrity.
7. State snapshots and invariants are more useful than generic timeout logs.

What looked at first like a Bluetooth transfer feature became a systems problem spanning acquisition timing, storage visibility, protocol design, event-driven control flow, and resource lifetime. That is exactly why I found it valuable: reliable embedded systems are built at the boundaries between components, where individually reasonable behaviors can combine into an incorrect whole.

## Related notes

- [Embedded fNIRS Acquisition System]({{ '/projects/fnirs-acquisition/' | relative_url }})
- [Understanding Event-Driven I/O with libevent and libuv]({% post_url 2026-07-23-understanding-event-driven-io-with-libevent-and-libuv %})
- [Crossing Thread Boundaries Safely in libevent]({% post_url 2026-07-23-crossing-thread-boundaries-in-libevent %})
