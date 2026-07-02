# #10699 — voice-mode transcription button: on-device before/after

`ondevice-before-after.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`):

- **RESTING (no voice mode)** — the composer shows only the single mic control
  (unchanged).
- **VOICE MODE (#10699)** — a transcription start button (📄) appears immediately
  to the left of the active mic (🎙️, orange), so the record-only transcription
  session can be started with a tap.

Behavior is covered by the ContinuousChatOverlay suite (92/92): the button is
hidden when not in voice mode, present as "start transcription" in voice mode,
present as "stop transcription" while transcribing (with the status badge), and
a click calls `toggleTranscriptionMode`. A `VoiceModeTranscription` story adds
story-gate coverage.
