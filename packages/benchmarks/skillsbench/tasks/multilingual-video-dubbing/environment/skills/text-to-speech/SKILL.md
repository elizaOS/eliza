---

name: "TTS Audio Mastering"
description: "Practical mastering steps for TTS audio: cleanup, loudness normalization, alignment, and delivery specs."
---

# SKILL: TTS Audio Mastering

This skill focuses on producing clean, consistent, and delivery-ready TTS audio for video tasks. It covers speech cleanup, loudness normalization, segment boundaries, and export specs.

## 1. TTS Engine & Output Basics

Choose a TTS engine based on deployment constraints and quality needs:

* **Neural offline** (e.g., Kokoro): stable, high quality, no network dependency.
* **Cloud TTS** (e.g., Edge-TTS / OpenAI TTS): convenient, higher naturalness but network-dependent.
* **Formant TTS** (e.g., espeak-ng): for prototyping only; often less natural.

**Key rule:** Always confirm the **native sample rate** of the generated audio before resampling for video delivery.

---

## 2. Speech Cleanup (Per Segment)

Apply lightweight processing to avoid common artifacts:

* **Rumble/DC removal:** high-pass filter around **20 Hz**
* **Harshness control:** optional low-pass around **16 kHz** (helps remove digital fizz)
* **Click/pop prevention:** short fades at boundaries (e.g., **50 ms** fade-in and fade-out)

Recommended FFmpeg pattern (example):

* Add filters in a single chain, and keep them consistent across segments.

---

## 3. Loudness Normalization

Target loudness depends on the benchmark/task spec. A common target is ITU-R BS.1770 loudness measurement:

* **Integrated loudness:** **-23 LUFS**
* **True peak:** around **-1.5 dBTP**
* **LRA:** around **11** (optional)

Recommended workflow:

1. **Measure loudness** using FFmpeg `ebur128` (or equivalent meter).
2. **Apply normalization** (e.g., `loudnorm`) as the final step after cleanup and timing edits.
3. If you adjust tempo/duration after normalization, re-normalize again.

---

## 4. Timing & Segment Boundary Handling

When stitching segment-level TTS into a full track:

* Match each segment to its target window as closely as possible.
* If a segment is shorter than its window, pad with silence.
* If a segment is longer, use gentle duration control (small speed change) or truncate carefully.
* Always apply boundary fades after padding/trimming to avoid clicks.

**Sync guideline:** keep end-to-end drift small (e.g., **<= 0.2s**) unless the task states otherwise.
