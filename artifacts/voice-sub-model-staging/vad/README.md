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
| `silero-vad-int8.onnx` | Primary (ONNX INT8) | 639 KB |
| `silero-vad-v5.1.2.ggml.bin` | llama.cpp integrated path (GGML) | 885 KB |
| `manifest.json` | Machine-readable metadata | — |

## Usage

```python
import numpy as np, onnxruntime as ort
sess = ort.InferenceSession("silero-vad-int8.onnx", providers=["CPUExecutionProvider"])
audio = np.random.randn(1, 512).astype(np.float32) * 0.1  # 32 ms @ 16 kHz
state = np.zeros((2, 1, 128), dtype=np.float32)
prob, new_state = sess.run(None, {"input": audio, "sr": np.array(16000, dtype=np.int64), "state": state})
# prob[0, 0] is P(speech) in [0, 1]
```

## License

MIT. Upstream attribution: [snakers4/silero-vad](https://github.com/snakers4/silero-vad).
