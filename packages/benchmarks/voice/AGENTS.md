# Voice Pipeline Benchmark — Agent Guide

Stress-tests the native voice stack: TTS synthesis (OmniVoice + Kokoro), speaker
diarization (pyannote-3 GGUF), speaker encoder/re-ID (WeSpeaker ResNet34-LM), ASR
(eliza-1 FFI), should-respond detection, and owner-voice security. Not registered
in the suite orchestrator — run scripts directly with Bun.

## Run

```bash
# End-to-end: 3 real voices (2 human + agent), full pipeline with real models
ELIZA_VOICE_CLASSIFIER_LIB=<repo-root>/build-darwin/libvoice_classifier.dylib \
  bun packages/benchmarks/voice/three-voice-e2e-real.mjs

# Three-voice scenario with synthetic fixtures (no real TTS models needed)
bun packages/benchmarks/voice/three-voice-scenario.mjs [--bundle <path>]

# Owner-voice enrollment, recognition, rejection, and prompt-injection defense
bun packages/benchmarks/voice/owner-voice-first-run.mjs

# Diarizer smoke test (falls back to pure-JS if native lib not built)
bun packages/benchmarks/voice/test-diarizer.mjs [--bundle <path>]

# Speaker encoder smoke test (falls back to pure-JS if native lib not built)
bun packages/benchmarks/voice/test-speaker-encoder.mjs

# Kokoro agent voice + ASR roundtrip
bun packages/benchmarks/voice/verify-kokoro-agent-voice.mjs

# Real-WAV speaker separation via WeSpeaker encoder
bun packages/benchmarks/voice/verify-real-voice-separation.mjs

# Real diarization on a live OmniVoice-generated stream
bun packages/benchmarks/voice/verify-real-diarization.mjs

# Enrollment attribution pipeline
bun packages/benchmarks/voice/verify-enrollment-attribution.mjs

# GGML native library availability check
bun packages/benchmarks/voice/verify-native-ggml.mjs
```

## Smoke test (no TTS/ASR models)

`owner-voice-first-run.mjs` and `test-speaker-encoder.mjs` both use a pure-JS
synthetic voice generator and fall back automatically when the native
`libvoice_classifier.dylib` is not built. They pass without any model bundle:

```bash
bun packages/benchmarks/voice/owner-voice-first-run.mjs
bun packages/benchmarks/voice/test-speaker-encoder.mjs
bun packages/benchmarks/voice/test-diarizer.mjs
```

## Test the harness

No dedicated test suite — the scripts themselves are the verification. Exit code 0
means pass, non-zero means failure. `owner-voice-first-run.mjs` reports a check
count and exits 1 on any failure.

## Layout

| Path | Role |
| --- | --- |
| `three-voice-e2e-real.mjs` | Full E2E: OmniVoice TTS, Kokoro agent voice, pyannote diarizer, WeSpeaker encoder, eliza-1 ASR, should-respond |
| `three-voice-scenario.mjs` | Same scenario with synthetic-fixture PCM (no real TTS) |
| `owner-voice-first-run.mjs` | Owner enrollment, recognition, rejection, injection-attack defense (pure-JS, self-contained) |
| `test-diarizer.mjs` | Diarizer GGUF smoke test; falls back to pure-JS classifyFramesToSegments |
| `test-speaker-encoder.mjs` | WeSpeaker encoder smoke test; falls back to pure-JS cosine pipeline |
| `verify-kokoro-agent-voice.mjs` | Kokoro ONNX TTS + ASR roundtrip |
| `verify-real-voice-separation.mjs` | Real encoder on OmniVoice WAVs — same-voice vs cross-voice cosine |
| `verify-real-diarization.mjs` | Real pyannote diarization on a live OmniVoice-generated stream |
| `verify-enrollment-attribution.mjs` | Enrollment + nearest-centroid re-ID pipeline |
| `verify-native-ggml.mjs` | Checks that libvoice_classifier.dylib is loadable |
| `reports/` | JSON + Markdown reports written by scripts at runtime (not committed) |

## Notes

- Full E2E requires the eliza-1-0_8b.bundle at `~/.eliza/local-inference/models/`
  and the compiled `libvoice_classifier.dylib` + `omnivoice-tts` binary.
- Reports write to `packages/benchmarks/voice/reports/` at runtime (not in git).
- Not registered in `registry/commands.py` — no orchestrator `--benchmarks` ID.
- The pure-JS fallback paths in `test-diarizer.mjs` and `test-speaker-encoder.mjs`
  are intentional and documented; they exercise the JS segmentation logic without
  the native library.
