# elizaos/eliza-1-voice-emotion

**Eliza-1 Voice Emotion** — Wav2Small acoustic emotion classifier (distilled).

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Wav2Small (72K params) |
| Teacher | audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim (CC-BY-NC-SA-4.0, NOT bundled) |
| Output | Continuous valence / arousal / dominance (3 dims) |
| Quantization | ONNX INT8 (primary), ONNX FP32 (reference) |
| Runtime | onnxruntime-node |
| License | Apache-2.0 (student weights only) |
| Input | 16 kHz mono, 1–12 s window |

## Parent Model

Student distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`. The teacher model is CC-BY-NC-SA-4.0 and is **not** bundled here — only the Apache-2.0 student weights are distributed.

Architecture reference: Wagner et al., "Wav2Small: Distilling Wav2Vec2 to 72K Parameters for Low-Resource Speech Emotion Recognition" (arXiv:2408.13920).

## Eval Baselines (MSP-Podcast test set)

| Metric | Score |
|--------|-------|
| CCC Valence | 0.65 |
| CCC Arousal | 0.71 |
| CCC Dominance | 0.43 |

## Intended Use

Continuous acoustic emotion tagging for the Eliza-1 voice pipeline. Output V-A-D values are projected to 7-class `ExpressiveEmotion` tags (`neutral`, `happy`, `sad`, `angry`, `fearful`, `surprised`, `disgusted`) via the projection table in `plugin-local-inference/src/services/voice/emotion-map.ts`.

**Not intended for:** clinical emotion analysis, high-stakes decisions, or use with the CC-BY-NC-SA-4.0 teacher model outputs.

## Files

| File | Role | Size |
|------|------|------|
| `wav2small-msp-dim-int8.onnx` | Primary (INT8) | ~120 KB |
| `wav2small-msp-dim-fp32.onnx` | FP32 reference | ~480 KB |
| `manifest.json` | Machine-readable metadata | — |

## License

Apache-2.0 (student weights only). The teacher model (`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`) is CC-BY-NC-SA-4.0 and is not included.
