# elizaos/eliza-1-voice-speaker

**Eliza-1 Voice Speaker Encoder** — WeSpeaker ECAPA-TDNN distilled, 256-dim speaker embeddings.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | ECAPA-TDNN distilled from WeSpeaker ResNet34-LM |
| Embedding dim | 256 (L2-normalized) |
| Quantization | ONNX INT8 (primary), ONNX FP32 (reference) |
| Runtime | onnxruntime-node |
| License | CC-BY-4.0 |
| Input | 16 kHz mono |
| VoxCeleb1-O EER | 0.72% |

## Parent Model

Distilled from [WeSpeaker/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM) (CC-BY-4.0).

## Eval Baselines

| Benchmark | Score |
|-----------|-------|
| VoxCeleb1-O EER | 0.72% |

## Intended Use

Real-time speaker embedding for the Eliza-1 voice pipeline. Powers:
- `InMemoryVoiceProfileStore` (LRU cache + cosine similarity matching)
- `VoiceAttributionPipeline` (W3-1 implementation)
- Multi-speaker turn attribution in family/group conversation scenarios

**Not intended for:** surveillance, identity verification in security contexts, or biometric profiling without explicit user consent.

## Files

| File | Role | Size |
|------|------|------|
| `wespeaker-ecapa-tdnn-256-int8.onnx` | Primary (INT8) | ~7 MB |
| `wespeaker-ecapa-tdnn-256-fp32.onnx` | FP32 reference | ~25 MB |
| `manifest.json` | Machine-readable metadata | — |

## License

CC-BY-4.0. Attribution: WeSpeaker team at the Westlake University Audio, Speech and Language Processing Group.
