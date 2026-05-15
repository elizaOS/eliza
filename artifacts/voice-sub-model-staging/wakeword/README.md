# elizaos/eliza-1-voice-wakeword

**Eliza-1 Voice Wake-word** — "hey eliza" always-on wake-word detector.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | hey-eliza ONNX head (hey_jarvis architecture) |
| Quantization | ONNX INT8 |
| Runtime | onnxruntime-node |
| License | Apache-2.0 |
| Trigger phrase | "hey eliza" |
| Input | 16 kHz mono, 100ms chunks |
| False accept rate | ≤0.5/hour (quiet office) |
| False reject rate | ~2% |
| CPU budget | <5% on modern ARM/x86 |

## Parent Model

hey_jarvis open wake-word architecture, fine-tuned for the "hey eliza" trigger phrase.

## Eval Baselines

| Metric | Score | Condition |
|--------|-------|-----------|
| False accept rate | ≤0.5/hour | Quiet office |
| False reject rate | ~2% | Normal speech |
| Latency | ~50ms | From phrase end |

## Intended Use

Always-on local wake-word detection for the Eliza-1 voice pipeline. Designed to run continuously at minimal CPU cost before the heavier VAD and ASR models are activated.

**Not intended for:** security applications, authentication, deployment in high-noise environments without additional tuning.

## Files

| File | Role | Size |
|------|------|------|
| `hey-eliza-int8.onnx` | Primary (INT8) | ~1 MB |
| `manifest.json` | Machine-readable metadata | — |

## License

Apache-2.0.
