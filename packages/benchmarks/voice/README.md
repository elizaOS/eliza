# Voice Pipeline Benchmark

End-to-end stress tests for the native elizaOS voice stack. Covers TTS synthesis
(OmniVoice CLI and Kokoro v1.0 ONNX), pyannote-3 speaker diarization, WeSpeaker
ResNet34-LM encoder and enrollment-based re-ID, eliza-1 ASR via FFI, should-respond
detection, and owner-voice security (enrollment, recognition, rejection, and
prompt-injection defense). Scripts run with Bun and produce JSON + Markdown reports
in `reports/`.

## Quick Start

```bash
# Full E2E with real models (requires eliza-1-0_8b.bundle + libvoice_classifier.dylib)
ELIZA_VOICE_CLASSIFIER_LIB=<repo>/build-darwin/libvoice_classifier.dylib \
  bun packages/benchmarks/voice/three-voice-e2e-real.mjs

# Pure-JS smoke test — no model bundle required
bun packages/benchmarks/voice/owner-voice-first-run.mjs
bun packages/benchmarks/voice/test-diarizer.mjs
```

See [AGENTS.md](AGENTS.md) for the full script inventory, per-script run commands,
and native dependency notes.
