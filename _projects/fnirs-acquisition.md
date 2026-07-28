---
layout: page
title: Embedded fNIRS Acquisition System
description: An event-driven embedded Linux application coordinating Bluetooth, CAN, UART, timers, and a non-blocking sampling state machine.
importance: 1
category: embedded-systems
permalink: /projects/fnirs-acquisition/
---

This project is an embedded Linux acquisition application for a functional
near-infrared spectroscopy (fNIRS) device. It coordinates Bluetooth control,
CAN-connected measurement nodes, UART peripherals, and time-sensitive sampling
without allowing one slow operation to stall the rest of the system.

The main engineering goal was to replace long, blocking workflows with an
event-driven design whose ownership and timing are easier to reason about.

## System flow

<figure class="project-flow">
  <img
    src="{{ '/assets/img/fnirs-system-flow.svg' | relative_url }}"
    alt="Flowchart showing a phone command entering the BlueZ GATT thread, crossing a protected queue and eventfd into the libevent main loop, controlling CAN nodes through a sampling state machine, and returning a response through a socketpair."
  >
  <figcaption>
    Control requests cross into the state-owning event-loop thread; device I/O
    and sampling then progress as short, non-blocking steps.
  </figcaption>
</figure>

The Bluetooth and libevent runtimes operate in separate concurrency domains.
The BlueZ GATT thread receives commands from a phone, but it does not directly
modify acquisition state. Instead, it copies each request into a protected job
queue and writes to an `eventfd`, waking the libevent loop.

The main thread owns the CAN, UART, sampling, and device business state. It
processes the queued command and returns the result through a request-specific
`socketpair`. This keeps shared state serialized while still giving the
Bluetooth request a bounded response path.

## Architecture

- **Bluetooth control:** BlueZ GATT receives configuration, discovery, and
  acquisition commands from a client.
- **Cross-thread dispatch:** a protected queue carries request data, while
  `eventfd` transfers readiness to the event loop.
- **Main event loop:** libevent monitors CAN, UART, timers, and queued work on
  one state-owning thread.
- **Sampling state machine:** multi-step acquisition advances on timer ticks
  and CAN responses instead of blocking with sleeps.
- **Response channel:** a per-request `socketpair` returns status and payload to
  the GATT thread with a timeout.

## Engineering outcomes

- Established one clear owner for acquisition and device state.
- Kept callbacks short so CAN, UART, Bluetooth, and timer events remain
  responsive.
- Represented hardware delays as state plus deadlines rather than blocking
  sleeps.
- Added bounded waiting and explicit failure handling across the thread
  boundary.
- Diagnosed an event-loop starvation case in CAN node discovery and restored
  discovery of all 12 connected nodes.

## Technologies

`Embedded Linux` · `C` · `libevent` · `BlueZ` · `CAN` · `UART` · `eventfd` ·
`socketpair` · `POSIX threads`

## Related notes

- [Designing Reliable Live Data Acquisition and File Synchronization over BLE]({% post_url 2026-07-28-designing-reliable-live-data-acquisition-and-file-synchronization-over-ble %})
- [Understanding Event-Driven I/O with libevent and libuv]({% post_url 2026-07-23-understanding-event-driven-io-with-libevent-and-libuv %})
- [Crossing Thread Boundaries Safely in libevent]({% post_url 2026-07-23-crossing-thread-boundaries-in-libevent %})
