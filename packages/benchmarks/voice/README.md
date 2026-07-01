# Voice Pipeline Benchmark

End-to-end stress tests for the native elizaOS voice stack. Covers TTS synthesis
(OmniVoice CLI and Kokoro v1.0 ONNX), pyannote-3 speaker diarization, WeSpeaker
ResNet34-LM encoder and enrollment-based re-ID, eliza-1 ASR via FFI, should-respond
detection, and owner-voice security (enrollment, recognition, rejection, and
prompt-injection defense). Scripts run with Bun and produce JSON + Markdown reports
in `reports/`.

## Quick Start

```bash
# Local real-acoustic eval: real pyannote diarizer + WeSpeaker encoder on real
# audio (Apple Silicon Metal, no GPU runner / no ElevenLabs)
ELIZA_INFERENCE_LIBRARY=<repo>/libelizainference.dylib ELIZA_BUNDLE_DIR=<bundle> \
ELIZA_PYANNOTE_GGUF=<pyannote.gguf> ELIZA_WESPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_SPK_A_WAV=<a.wav> ELIZA_SPK_B_WAV=<b.wav> \
  bun packages/benchmarks/voice/local-acoustic-eval.mjs

# Provisioned CI real matrix: fused lib + GGUFs + generated speech.
# Writes DER/WER/echo-rejection/owner-security JSON + Markdown reports.
ELIZA_ASR_BUNDLE=<bundle> \
ELIZA_INFERENCE_LIBRARY=<libelizainference> \
ELIZA_SPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_DIARIZ_GGUF=<pyannote.gguf> \
ELEVENLABS_API_KEY=<key> \
  bun packages/benchmarks/voice/voice-real-ci-matrix.mjs

# Pure-JS smoke test — no model bundle required
bun packages/benchmarks/voice/owner-voice-first-run.mjs
bun packages/benchmarks/voice/test-diarizer.mjs
```

See [AGENTS.md](AGENTS.md) for the full script inventory, per-script run commands,
and native dependency notes.
