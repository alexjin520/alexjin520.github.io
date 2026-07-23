---
layout: post
title: Crossing Thread Boundaries Safely in libevent
date: 2026-07-23 15:12:00 +0800
description: How I connected a BlueZ GATT thread to a libevent main loop using an eventfd, a protected job queue, and a socketpair response channel.
tags: [Linux, libevent, Bluetooth, Embedded Systems]
categories: [Technical Notes]
featured: true
---

In my previous article, I described the basic event-loop model: register file descriptors, keep callbacks short, and let the kernel wake the application when work is ready.

That model becomes more interesting when a library already owns another thread and another main loop.

I encountered exactly this problem while integrating a Bluetooth GATT server into an embedded fNIRS acquisition program. The application used **libevent** for CAN, UART, timers, and sampling state machines, while the GATT server used the **BlueZ** mainloop in a separate thread.

Both sides needed to access the same device state:

```text
GATT thread                              libevent main thread
-----------                              --------------------
receives a phone command                 owns CAN communication
parses the GATT payload                  owns sampling state
must return a GATT response              owns most fNIRS business state
```

Calling the business functions directly from the GATT thread would have reintroduced the races that the event-driven refactor was intended to remove. The solution was a small cross-thread dispatch layer built from three pieces:

- a mutex-protected job queue,
- an `eventfd` that wakes the libevent loop,
- and one `socketpair` per request for returning the result.

This article explains the design, the mistakes made along the way, and the boundary between safe cross-thread dispatch and a truly asynchronous protocol.

## 1. The thread-ownership rule

The most important design decision was not an API. It was an ownership rule:

> CAN state, sampling state, and fNIRS business state are modified on the libevent main thread.

The GATT thread may receive and decode a command, but it does not execute the command against shared device state. Instead, it describes the requested work and sends that description to the owner thread.

For example, a request can be represented as a job:

```c
struct ble_job {
    uint8_t command;
    uint16_t payload_length;
    uint8_t payload[512];
    int response_fd;
    struct ble_job *next;
};
```

Copying the payload into the job is deliberate. A GATT callback's input buffer may no longer be valid when the main thread eventually processes the request. The queued job therefore owns all request data needed after the callback returns.

The complete request path looks like this:

```text
phone writes a GATT characteristic
                |
                v
BlueZ invokes a callback on the GATT thread
                |
                v
create job + create socketpair
                |
                v
lock queue -> enqueue job -> unlock queue
                |
                v
write to eventfd
                |
                v
libevent wakes and runs the queue callback
                |
                v
main thread executes the fNIRS command
                |
                v
write response through socketpair
                |
                v
GATT thread returns the result to the phone
```

Only the short queue operation is protected by a mutex. The business command itself runs after the job has been removed from the queue, so a slow command does not hold the queue lock.

## 2. Why a queue is not enough

A worker thread can safely append an item to a queue, but the event loop does not automatically know that the queue changed.

The main loop might currently be sleeping inside `epoll_wait()`, waiting for CAN, UART, or timer events. It needs a file descriptor that becomes readable when another thread submits work.

Linux `eventfd` is a good fit:

```c
int notify_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);

struct event *notify_event = event_new(
    base,
    notify_fd,
    EV_READ | EV_PERSIST,
    run_queued_jobs,
    NULL
);

event_add(notify_event, NULL);
```

The GATT thread wakes the loop by writing an unsigned 64-bit value:

```c
uint64_t one = 1;
write(notify_fd, &one, sizeof(one));
```

The descriptor becomes readable, so libevent schedules `run_queued_jobs()` on the main thread. The callback drains the counter and then consumes the queue:

```c
static void run_queued_jobs(evutil_socket_t fd, short events, void *arg)
{
    uint64_t value;

    while (read(fd, &value, sizeof(value)) == sizeof(value))
        ;

    for (;;) {
        struct ble_job *job = dequeue_job();

        if (job == NULL)
            break;

        process_ble_job(job);
        free(job);
    }
}
```

`eventfd` stores a counter rather than a stream of individual messages. That is fine because the queue contains the actual jobs. The notification only means:

> The queue may contain work; check it.

This separation is useful. The queue carries data, while `eventfd` carries readiness.

## 3. Returning a result with socketpair

Waking the main loop solves only half of the problem. A GATT request often needs a status code and a response payload before the Bluetooth callback can finish.

For each request, the dispatcher creates a local Unix-domain socket pair:

```c
int pair[2];

if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0)
    return -1;
```

The two descriptors are connected:

```text
pair[0] <==============================> pair[1]
job/main-thread side                     GATT-thread side
```

`pair[0]` is stored in the job. The GATT thread keeps `pair[1]`, enqueues the job, wakes the main loop, and then waits for a bounded amount of time:

```c
struct pollfd pfd = {
    .fd = pair[1],
    .events = POLLIN,
};

if (poll(&pfd, 1, timeout_ms) <= 0) {
    /* cancel or mark the operation as failed */
    close(pair[1]);
    return -1;
}

read_response(pair[1], &status, response, &response_length);
```

The main thread executes the command and writes a framed response to `pair[0]`:

```text
+---------+---------+---------+--------+------------+---------+
| magic 0 | magic 1 | command | status | length (2) | payload |
+---------+---------+---------+--------+------------+---------+
```

Framing matters because `SOCK_STREAM` preserves byte order but not application message boundaries. The receiver first reads and validates the fixed-size header, obtains the payload length, and then reads that many bytes.

The response descriptor also gives each request its own completion channel. There is no need to match a result from one shared response queue to the original GATT request.

## 4. Why use both eventfd and socketpair?

At first, using two IPC mechanisms inside one process can look unnecessary. They serve different directions and different lifetimes:

| Mechanism | Direction | Lifetime | Purpose |
|---|---|---|---|
| protected queue | GATT → main | process lifetime | stores jobs |
| `eventfd` | GATT → main | process lifetime | wakes libevent |
| `socketpair` | main → GATT | one request | returns status and payload |

The persistent `eventfd` avoids creating a new libevent registration for every request. The per-request socket pair makes response ownership and cleanup explicit.

An `eventfd` could also be used for completion if the response data lived in shared memory. A condition variable could wake the waiting thread. A future or promise abstraction could wrap the same idea. I used `socketpair` because the response was already naturally expressed as bytes and could be handled with normal `poll()`, `read()`, and `write()` calls.

## 5. Ordering initialization correctly

The dispatch layer must be ready before the GATT server can accept a request.

The startup order is therefore:

```text
create libevent base
        |
initialize job queue, mutex, and eventfd
        |
register eventfd with libevent
        |
start the GATT thread
        |
enter event_base_dispatch()
```

Starting GATT first creates a race: a phone may write a characteristic while the event base or notification descriptor is still uninitialized.

Shutdown needs the reverse discipline:

```text
stop accepting GATT requests
        |
stop and join the GATT thread
        |
remove the eventfd event
        |
close descriptors and reject pending jobs
        |
destroy the mutex and event base
```

Pending jobs need an explicit policy. Silently freeing a job while another thread waits on its response descriptor turns shutdown into a timeout. Closing or completing the response side lets the waiting thread fail promptly.

## 6. Thread checks are valuable diagnostics

The queue callback is intended to run only on the libevent thread. I recorded the main thread ID during initialization and checked it before processing jobs:

```c
if (!pthread_equal(pthread_self(), main_thread_id)) {
    log_error("job callback ran outside the main thread");
    return;
}
```

This check does not create thread safety by itself. It makes a broken assumption visible.

During development, it is easy to accidentally call an event-loop function from a foreign thread, or to process a job directly as a shortcut. A thread-ID assertion turns an intermittent race into a useful log message near the source of the problem.

In the final implementation, simple commands may run directly when the dispatcher is already on the main thread. Commands whose completion depends on future timer callbacks cannot use that optimization, because waiting for their result on the same thread would deadlock the loop.

## 7. Bounded waiting and cancellation

The GATT side still waits synchronously for the main-thread result. It must never wait forever.

Different commands have different expected durations:

```text
ordinary control command     -> short timeout
stream startup               -> longer timeout
node scan                    -> longest timeout
```

When a timeout occurs, the implementation records the command and descriptor in a trace file, cancels any active asynchronous operation, closes its response side, and reports failure to GATT.

Useful trace messages include:

```text
dispatch cmd=0x01
run_jobs_cb on main loop
process job cmd=0x01 fd=17
dispatch cmd=0x01 ok
```

or, when something goes wrong:

```text
poll timeout fd=18 waited=12000ms
```

Cross-thread systems are much easier to debug when a request has a visible path through enqueue, wake-up, execution, completion, and timeout.

One detail deserves special care: after the waiting side times out and closes its descriptor, a late response must not terminate the process with `SIGPIPE`. Production code should define the late-completion behavior explicitly, for example by ignoring `SIGPIPE`, using a no-signal send option where available, and treating `EPIPE` as cancellation.

## 8. A real failure: the scan returned 0 of 12 nodes

The hardest bug was not in the mutex, `eventfd`, or socket pair.

A Bluetooth SCAN command reached the main thread correctly, and the GATT thread received a valid response. However, the result reported zero nodes even though all 12 CAN nodes were connected.

The scan operation contained a loop that advanced the fNIRS discovery state. Because that loop ran inside a job callback, normal control had not yet returned to `event_base_dispatch()`. The CAN file descriptor could become readable, but its regular libevent callback did not get its normal opportunity to drain the frames.

The first attempted fix pumped only the higher-level hub state:

```text
advance scan state
process already-decoded hub messages
```

That was insufficient. The CAN frames were still waiting in the kernel receive queue.

The working pump had to perform the complete path:

```text
drain readable CAN frames
        |
decode frames into hub messages
        |
advance the scan state
        |
run pending non-blocking events
```

After the CAN drain was included, discovery returned all 12 nodes.

This produced an important lesson:

> Calling business logic is not equivalent to servicing its I/O source.

If a callback contains a nested wait or a long state transition, every dependency that would normally be serviced by the outer event loop must still make progress. The cleaner long-term solution is usually to split the operation into timer- and I/O-driven phases so that the callback returns. A nested pump can preserve legacy timing, but it increases reentrancy risk and should remain a carefully bounded exception.

## 9. This is dispatch, not full asynchrony

It is tempting to call the entire design asynchronous because the request crosses threads through a queue. That would hide an important limitation.

The main thread receives jobs asynchronously, but the GATT thread waits in `poll()` until a result arrives:

```text
GATT thread: enqueue -------------------------- wait
                         main thread: execute ------- respond
```

Therefore the current design is:

- asynchronous with respect to submitting work to the event loop,
- serialized with respect to shared fNIRS state,
- synchronous with respect to completing the GATT request.

This is a reasonable compromise when the GATT API expects an immediate response and only one Bluetooth control request is normally in flight. It is not ideal if the GATT thread must remain responsive to many concurrent operations.

A fully asynchronous protocol would acknowledge the command quickly, assign a request ID, and later deliver completion through a notification:

```text
phone sends command
        |
immediate "accepted" response + request ID
        |
main loop performs the operation
        |
GATT notification reports completion
```

That design changes the phone protocol and introduces request tracking, cancellation, and reconnect behavior. The extra complexity is worthwhile only when the product requirements need it.

## 10. General rules I would reuse

The implementation is specific to an embedded Bluetooth application, but the design rules apply more broadly:

1. Give mutable state a clear owner thread.
2. Send commands to the owner instead of sharing direct access.
3. Copy request data whose original lifetime is uncertain.
4. Hold the queue mutex only while changing the queue.
5. Use a file descriptor to wake a file-descriptor-based event loop.
6. Give each synchronous request an explicit response channel.
7. Bound every cross-thread wait with a timeout.
8. Define cancellation, late completion, and shutdown behavior.
9. Verify callback thread identity during development.
10. Do not hide blocking work inside an event-loop callback.
11. If a nested pump is unavoidable, service the real I/O source, not only the business state above it.
12. Describe hybrid designs honestly: safe dispatch and full asynchrony are not the same thing.

## Conclusion

Connecting two event systems is less about finding one magical API and more about preserving ownership.

In this design, BlueZ owns the GATT thread, libevent owns the fNIRS business state, a protected queue transfers commands, `eventfd` wakes the owner, and `socketpair` carries each result back. The components are ordinary Linux primitives, but together they create a clear boundary between two concurrency domains.

The most valuable outcome was not simply reducing data races. The request path became observable and explainable:

```text
receive -> enqueue -> wake -> execute -> respond
```

When concurrency has a visible path and every piece of state has an owner, embedded software becomes much easier to reason about.
