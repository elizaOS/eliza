# elizaos/eliza-1-voice-speaker

**Eliza-1 Voice Speaker Encoder** — WeSpeaker ResNet34-LM, 256-dim speaker embeddings.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | WeSpeaker ResNet34-LM (VoxCeleb-trained) |
| Embedding dim | 256 (L2-normalized) |
| Quantization | ONNX (single asset, FP16 weights) |
| Runtime | onnxruntime-node |
| License | CC-BY-4.0 |
| Input | 16 kHz mono → 80-dim fbank, T frames |
| VoxCeleb1-O EER | 0.72% |

## Parent Model

[WeSpeaker/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM) (CC-BY-4.0).

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
| `wespeaker-resnet34-lm.onnx` | Primary weights (ONNX) | ~26 MB |
| `manifest.json` | Machine-readable metadata | — |

## Usage

```python
import onnxruntime as ort
import numpy as np

sess = ort.InferenceSession("wespeaker-resnet34-lm.onnx", providers=["CPUExecutionProvider"])
# Input: 80-dim fbank features at 16 kHz, shape (1, T, 80)
fbank = np.random.randn(1, 300, 80).astype(np.float32)  # ~3 seconds
emb = sess.run(None, {sess.get_inputs()[0].name: fbank})[0]
# emb.shape == (1, 256)
```

## License

CC-BY-4.0. Attribution: WeSpeaker team at the Westlake University Audio, Speech and Language Processing Group.
