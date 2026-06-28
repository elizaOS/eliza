# Voice Pipeline Benchmark — Agent Guide

Stress-tests the native voice stack: TTS synthesis (OmniVoice + Kokoro), speaker
diarization (pyannote-3 GGUF), speaker encoder/re-ID (WeSpeaker ResNet34-LM), ASR
(eliza-1 FFI), should-respond detection, and owner-voice security. Not registered
in the suite orchestrator — run scripts directly with Bun.

## Run

```bash
# Local real-acoustic eval: real pyannote diarizer + WeSpeaker encoder on real
# audio (Apple Silicon Metal, no GPU runner / no ElevenLabs)
ELIZA_INFERENCE_LIBRARY=<repo-root>/libelizainference.dylib ELIZA_BUNDLE_DIR=<bundle> \
ELIZA_PYANNOTE_GGUF=<pyannote.gguf> ELIZA_WESPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_SPK_A_WAV=<a.wav> ELIZA_SPK_B_WAV=<b.wav> \
  bun packages/benchmarks/voice/local-acoustic-eval.mjs

# Provisioned CI real matrix: fused lib + GGUFs + generated speech.
# Fails instead of skipping when any real dependency is absent.
ELIZA_ASR_BUNDLE=<bundle> \
ELIZA_INFERENCE_LIBRARY=<libelizainference> \
ELIZA_SPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_DIARIZ_GGUF=<pyannote.gguf> \
ELEVENLABS_API_KEY=<key> \
  bun packages/benchmarks/voice/voice-real-ci-matrix.mjs

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
| `local-acoustic-eval.mjs` | Local real-acoustic eval: real pyannote diarizer + WeSpeaker encoder on real audio (Apple Silicon Metal, no GPU runner / no ElevenLabs) — diarizer counts, DER proxy, WeSpeaker cosine |
| `voice-real-ci-matrix.mjs` | Provisioned CI real matrix: ElevenLabs owner/impostor speech + fused on-device agent TTS/ASR/diarizer/speaker encoder, producing DER/WER/echo-rejection/owner-security metrics |
| `three-voice-scenario.mjs` | Same scenario with synthetic-fixture PCM (no real TTS) |
| `owner-voice-first-run.mjs` | Owner enrollment, recognition, rejection, injection-attack defense (pure-JS, self-contained) |
| `test-diarizer.mjs` | Diarizer GGUF smoke test; falls back to pure-JS classifyFramesToSegments |
| `test-speaker-encoder.mjs` | WeSpeaker encoder smoke test; falls back to pure-JS cosine pipeline |
| `verify-kokoro-agent-voice.mjs` | Kokoro ONNX TTS + ASR roundtrip |
| `reports/` | JSON + Markdown reports written by scripts at runtime (not committed) |

## Notes

- The retired standalone `libvoice_classifier` scripts were removed after the
  direct GGML encoder/diarizer exports were retired. Use `local-acoustic-eval.mjs`
  for local real-audio diarizer/encoder checks, or `voice-real-ci-matrix.mjs`
  for the provisioned fused-library CI lane.
- Reports write to `packages/benchmarks/voice/reports/` at runtime (not in git).
- Not registered in `registry/commands.py` — no orchestrator `--benchmarks` ID.
- The pure-JS fallback paths in `test-diarizer.mjs` and `test-speaker-encoder.mjs`
  are intentional and documented; they exercise the JS segmentation logic without
  the native library.
