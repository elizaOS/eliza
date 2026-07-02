# #9583 — macOS speaker→mic acoustic-loop AEC evidence (real physical loop)

Captured 2026-07-02 on this M4 Max MacBook (built-in speakers → built-in mic),
worktree `feat/ui-mobile-gap-burndown` @ develop `5471346e7a6`. No mocks of the
subject anywhere: real `say` speech, real `afplay` playback at **modest volume
(output volume 45, restored afterwards)**, real `sox` mic capture, and the
PRODUCTION voice modules (`live-diarization-route.ts`, `EchoReferenceBuffer`,
`NlmsEchoCanceller`, `estimateEchoDelaySamples`, `computeErle`) plus the real
fused `libelizainference.dylib` (VAD + WeSpeaker + pyannote ABIs all probed
supported at runtime).

## What #9583 asked for vs. what is proven here

1. **`echoReference` wiring on the live path** — Phase B boots an HTTP server
   mounting the production `handleLiveDiarizationRoute` and streams the far-end
   PCM to `POST /api/voice/playback-frames` (the live playback-reference
   producer) interleaved in capture-clock order with the physically recorded
   mic PCM to `POST /api/voice/audio-frames` (base64 LE-s16 16 kHz mono, 20 ms
   frames, real-time paced in 200 ms blocks — the device wire shape).
   `GET /api/voice/audio-frames/status` after the run reports
   **`aec.echoReferenceWired: true`**, `framesReceived: 1100`,
   `framesDropped: 0`, `turnsObserved: 4` (see `aec-loop-report.json`).
2. **Playback→mic delay calibration on a real device** — the session's own
   self-calibration (`estimateEchoDelaySamples`, #9586) converged on the
   physical loop to **`echoDelaySamples: 1088` (68.0 ms) at confidence 0.61**;
   an independent offline pass of the same production estimator over the whole
   active window recovered **1089 samples (68.1 ms)** — agreement within one
   sample between the streaming self-calibration and the batch estimate.
3. **Measured ERLE on the physical loop** (Phase C, production
   `EchoReferenceBuffer` + `NlmsEchoCanceller` + `computeErle`, delay = the
   self-calibrated 1088):
   - linear NLMS: overall **−17.30 dB**, converged-half **−3.29 dB**
     (822 cancelled frames, 278 far-end-silence passthrough frames);
   - with residual suppression: overall **−14.05 dB**, converged-half
     **+1.63 dB**, late-window seconds reaching **+4…+10 dB**
     (per-second series in `aec-loop-report.json`).

## Harness validity control (why the negative ERLE is real, not a bug)

`aec-synth-control.ts` pushes a synthetic echo (known delay 1088, gain 0.1,
−40 dB noise floor, same 1204 ms play offset) through the IDENTICAL
buffer/canceller/metric path: **+12.77 dB overall, +24.34 dB converged-half**
(`aec-synth-control-output.txt`) — consistent with the ~29 dB echo-only ERLE
from the #9575 unit suite. The measurement plumbing is therefore sound; the
physical-loop numbers are a genuine finding:

> On a real room path (speaker distortion at modest volume, reverb tail,
> time-varying acoustics, mic processing), the linear NLMS canceller initially
> DIVERGES (−24 dB in the first seconds) and only converges to ≈0…+1 dB
> linear / +4…+10 dB with residual suppression late in a ~20 s utterance. The
> conservative DTD-freeze keeps it stable but slow. This quantifies exactly why
> the issue's third checkbox (AEC3-class residual echo suppression / robust
> adaptation) matters on-device: the residual-suppression path is the only one
> that reaches usable positive ERLE on real acoustics within the utterance.

## Files

- `aec-acoustic-loop-harness.ts` — the 3-phase harness (run command in header).
- `aec-loop-run.log` — stdout of the evidence run (port 36521).
- `aec-loop-report.json` — machine-readable report: capture timing, both delay
  estimates, live-route status DTOs before/after, ERLE series.
- `farend-16k.wav` / `farend-say.aiff` — far-end reference speech (`say`).
- `mic-capture-16k.wav` — the REAL mic capture (22 s; RMS 0.015, peak 0.106 —
  listen to it: the speaker playback is audibly present with room tone).
- `capture-timing.json` — play-start offset in the mic capture clock (1204 ms).
- `aec-synth-control.ts` / `aec-synth-control-output.txt` — harness-validity
  control (synthetic echo through the same production path).

## Reproduce

```bash
ELIZA_INFERENCE_LIBRARY=~/.local/state/eliza/local-inference/lib/libelizainference.dylib \
ELIZA_VOICE_MODEL_DIR=<bundle root with vad/ speaker/ diariz/ ggufs> \
bun .github/issue-evidence/9583-aec-macos/aec-acoustic-loop-harness.ts --port 36520
```

Bundle-root layout gotcha (learned during this run): the fused native runtime
resolves models from `<root>/vad/silero-vad-v5.1.2.ggml.bin`,
`<root>/speaker/*.gguf`, `<root>/diariz/*.gguf` — `speaker-encoder/` and
`diarizer/` directory names are NOT found (speaker_open/diariz_open return a
structured "no GGUF found under …/speaker" diagnostic).
