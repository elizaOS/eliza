# elizaos/eliza-1-voice-diarizer

**Eliza-1 Voice Diarizer** — Pyannote-segmentation-3.0 ONNX for local speaker-activity segmentation.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Pyannote-segmentation-3.0 (powerset) |
| Max local speakers | 3 |
| Window | 5s, 293 frames/window, 7 output classes |
| Quantization | ONNX INT8 (primary), ONNX FP32 (reference) |
| Runtime | onnxruntime-node |
| License | MIT |
| Input | 16 kHz mono |
| AMI-headset DER | 12.4% |

## Parent Model

ONNX conversion of [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) via [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0).

## Eval Baselines

| Benchmark | Score |
|-----------|-------|
| AMI-headset DER | 12.4% |

## Intended Use

Per-frame speaker-activity segmentation for the Eliza-1 voice pipeline. Powers `SegmentDiarizer` (energy-VAD + agglomerative clustering) in multi-speaker sessions. Combined with the speaker encoder (`elizaos/eliza-1-voice-speaker`) for full attribution.

**Not intended for:** large-scale broadcast diarization (>3 simultaneous speakers), forensic speaker attribution.

## Files

| File | Role | Size |
|------|------|------|
| `pyannote-segmentation-3.0-int8.onnx` | Primary (INT8) | ~1.5 MB |
| `pyannote-segmentation-3.0-fp32.onnx` | FP32 reference | ~6 MB |
| `manifest.json` | Machine-readable metadata | — |

## License

MIT.
