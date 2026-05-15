# elizaos/eliza-1-voice-wakeword

**Eliza-1 Voice Wake-word** — "hey eliza" always-on wake-word detector.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | openWakeWord head (16 frames × 96-dim features → scalar) |
| Quantization | ONNX INT8 |
| Runtime | onnxruntime-node |
| License | Apache-2.0 (Milady-trained head) |
| Trigger phrase | "hey eliza" |
| Input | 16 kHz mono, 100 ms chunks (16-frame sliding window of 96-d embeddings) |
| Held-out true-accept rate | 99.63% |
| Held-out false-accept rate | 8.15% (270/270 split, threshold=0.5) |
| Target false-accept rate | ≤0.5/hour in quiet office |
| Training data | 1800 positives + 1800 negatives, OmniVoice-GGUF synthesized, 5× augmented, 100 epochs |
| CPU budget | <5% on modern ARM/x86 |

## Parent Model

[openWakeWord v0.5.1](https://github.com/dscripka/openWakeWord) front-end (melspectrogram + 96-d embedding extractor, Apache-2.0); custom Milady-trained "hey eliza" head on top.

## Eval Baselines

| Metric | Score | Condition |
|--------|-------|-----------|
| Held-out TAR | 99.63% | 270 positives, threshold=0.5 |
| Held-out FAR | 8.15% | 270 negatives, threshold=0.5 |
| Target false accept rate | ≤0.5/hour | Quiet office, integrated runtime |
| Latency | ~50 ms | From phrase end |

## Intended Use

Always-on local wake-word detection for the Eliza-1 voice pipeline. Designed to run continuously at minimal CPU cost before the heavier VAD and ASR models are activated.

**Not intended for:** security applications, authentication, deployment in high-noise environments without additional tuning.

## Files

| File | Role | Size |
|------|------|------|
| `hey-eliza-int8.onnx` | Wake-word head (INT8) | ~616 KB |
| `melspectrogram.onnx` | openWakeWord mel front-end (FP32) | ~1.0 MB |
| `embedding_model.onnx` | openWakeWord 96-d feature extractor (FP32) | ~1.3 MB |
| `hey-eliza.provenance.json` | Training provenance (TTS source, dataset sizes, held-out metrics) | — |
| `manifest.json` | Machine-readable metadata | — |

## Runtime contract

- `melspectrogram.onnx` input: `(B, samples)` float32 audio at 16 kHz.
- `embedding_model.onnx` input: `(B, 76, 32, 1)` mel chunks (rescaled `x/10 + 2`); output: `(B, T, 96)`.
- `hey-eliza-int8.onnx` input: `(B, 16, 96)` sliding window of 96-d features; output: scalar `P(wake) ∈ [0, 1]`.

## License

Apache-2.0.
