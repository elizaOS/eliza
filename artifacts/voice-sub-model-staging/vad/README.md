# elizaos/eliza-1-voice-vad

**Eliza-1 Voice VAD** — Silero VAD v5.1.2 for voice activity detection.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Silero VAD v5.1.2 |
| Quantization | ONNX INT8 (primary), GGML (llama.cpp path) |
| Runtime | onnxruntime-node / llama.cpp |
| License | MIT |
| Input | 16 kHz mono, 30ms chunks |
| False barge-in rate | ≤0.5/hour (quiet office) |

## Parent Model

[snakers4/silero-vad](https://github.com/snakers4/silero-vad) v5.1.2.

## Eval Baselines

| Metric | Score |
|--------|-------|
| False barge-in rate (quiet office) | ≤0.5/hour |
| Missed speech (MUSAN) | <2% |

## Intended Use

Speech/silence endpoint detection as the first stage of the Eliza-1 voice pipeline. Determines when the user has finished speaking before forwarding audio to ASR.

## Files

| File | Role | Size |
|------|------|------|
| `silero-vad-int8.onnx` | Primary (ONNX INT8) | ~1 MB |
| `silero-vad-v5.1.2.ggml.bin` | llama.cpp integrated path | ~2 MB |
| `manifest.json` | Machine-readable metadata | — |

## License

MIT.
