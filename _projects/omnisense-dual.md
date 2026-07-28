---
layout: page
title: OmniSense-Dual
description: A dual-wearable pedestrian safety and navigation system combining multi-sensor perception with spatial haptic feedback.
img: assets/img/projects/omnisense-dual/head-module-2.png
importance: 1
category: embedded-systems
permalink: /projects/omnisense-dual/
---

OmniSense-Dual is a two-module wearable designed to help pedestrians—especially
visually impaired users—navigate without depending on a screen or adding more
audio cues. It separates two kinds of information spatially: a head-worn ring
communicates nearby hazards, while a waist belt communicates turn-by-turn
navigation.

Built for **ECE 445 Senior Design at UIUC (Team 10, Spring 2026)** with Jiateng
Ma and Simon Xia, the system connects two ESP32-S3 wearables to a Python/Flask
host over Wi-Fi.

<div class="project-actions" aria-label="OmniSense-Dual project resources">
  <a class="project-action project-action-primary" href="{{ '/assets/pdf/omnisense-dual-final-report.pdf' | relative_url }}">
    Final Report (PDF)
  </a>
  <a class="project-action" href="{{ '/assets/pdf/omnisense-dual-presentation.pdf' | relative_url }}">
    Presentation (PDF)
  </a>
  <a class="project-action" href="https://github.com/alexjin520/lab-notebook-ece445-group10">
    Lab Notebook &amp; Source
  </a>
</div>

<figure class="project-hero">
  <img
    src="{{ '/assets/img/projects/omnisense-dual/head-module-2.png' | relative_url }}"
    alt="OmniSense-Dual head module assembled on a knit cap with sensor boards, ribbon cables, and haptic motors arranged around it."
  >
  <figcaption>
    The assembled head module places sensing and localized haptic feedback
    around the user's head.
  </figcaption>
</figure>

## System architecture

- **Head module — hazard awareness:** eight directional ToF channels, front and
  rear mmWave sensing, and IMU orientation data form an obstacle field. Eight
  head-mounted motors encode both direction and urgency.
- **Waist module — navigation:** GPS-backed Google Maps guidance is translated
  into directional cues on an eight-motor belt, keeping navigation physically
  distinct from hazard warnings.
- **Flask host — fusion and coordination:** both ESP32-S3 modules send JSON
  sensor packets over Wi-Fi. The host validates the readings, combines the
  latest head and waist observations, and returns module-specific haptic
  commands.

For each of eight compass directions, the fusion pipeline selects the closest
valid ToF or mmWave observation. It then merges the head- and waist-level
results using the same safety-first rule. IMU tilt compensation suppresses
ground-reflection false positives, and six distance zones are encoded through
motor intensity, pulse frequency, and temporal pattern.

## My contributions

My work centered on the software path that turns distributed sensor readings
into deterministic feedback:

- Developed the Flask service and JSON interfaces for sensor ingestion,
  navigation commands, device status, and the real-time dashboard.
- Implemented the dual-module sensor-fusion algorithm, hazard-zone
  classification, IMU compensation, and eight-direction haptic mapping.
- Built structured verification logging and automated tests that tie system
  behavior back to the requirements-and-verification plan.
- Designed ToF and power-subsystem tests and contributed to PCB bring-up,
  wearable assembly, and end-to-end integration.

## Verification results

The final prototype was evaluated through bench tests, automated tests, and two
recorded walking sessions.

| Metric                                |  Result |
| ------------------------------------- | ------: |
| Recorded sensor packets               |   1,986 |
| Malformed packets                     |       0 |
| Automated tests                       |     134 |
| Median server processing time         | 15.5 ms |
| p95 server processing time            |   33 ms |
| Worst ToF distance error from 0.5–2 m |    2.0% |

<aside class="project-note">
  <strong>Known limitation:</strong> the shared 2.4 GHz test network produced a
  290–300 ms median end-to-end latency against a 200 ms target and reduced the
  median packet rate to 4.2 Hz against a 10 Hz target. Server processing remained
  well within budget; the final report discusses network and power-delivery
  improvements for a production revision.
</aside>

## Prototype gallery

<div class="project-gallery">
  <figure>
    <img
      src="{{ '/assets/img/projects/omnisense-dual/head-module-1.png' | relative_url }}"
      alt="Front view of the OmniSense-Dual head module showing its breadboard, sensors, and directional wiring."
      loading="lazy"
    >
    <figcaption>Head module electronics and sensor placement.</figcaption>
  </figure>
  <figure>
    <img
      src="{{ '/assets/img/projects/omnisense-dual/head-module-2.png' | relative_url }}"
      alt="Side view of the assembled OmniSense-Dual head module in the electronics laboratory."
      loading="lazy"
    >
    <figcaption>Completed head-worn prototype.</figcaption>
  </figure>
  <figure>
    <img
      src="{{ '/assets/img/projects/omnisense-dual/waist-module-1.jpg' | relative_url }}"
      alt="Outside view of the OmniSense-Dual waist belt with sensors and ribbon cables secured around the fabric."
      loading="lazy"
    >
    <figcaption>Waist module sensor and haptic layout.</figcaption>
  </figure>
  <figure>
    <img
      src="{{ '/assets/img/projects/omnisense-dual/waist-module-2.jpg' | relative_url }}"
      alt="Inside view of the OmniSense-Dual waist module showing its controller boards and wiring."
      loading="lazy"
    >
    <figcaption>Waist module control electronics and wiring.</figcaption>
  </figure>
</div>

## Technologies

`ESP32-S3` · `Embedded C++` · `Python` · `Flask` · `Wi-Fi` · `JSON` ·
`VL53L1X ToF` · `24 GHz mmWave` · `IMU` · `GPS` · `Haptic feedback` · `pytest`
