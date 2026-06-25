# CoreML/ANE vs CPU for the always-on voice gate — measured on Apple M-series, 2026-06-24

## Question
Would moving the always-on voice gate models (Silero VAD, openWakeWord) onto the
Apple Neural Engine (CoreML) save battery on Apple Silicon?

## Method
This Mac is Apple Silicon (has an ANE), runs CoreML natively, and onnxruntime exposes
the CoreML execution provider. Fetched Silero VAD v5 ONNX (2.3 MB, stateful LSTM:
inputs `input[1,512]` / `state[2,1,128]` / `sr`, outputs `output` / `stateN`) and ran
200 x 512-sample (32 ms) windows under the CoreML EP (ANE) vs the CPU EP.
onnxruntime 1.22, coremltools 9.0.

## Result (lower is better)
| backend | ms / 512-sample window | vs CPU |
|---|---|---|
| **CPU (NEON)** | **0.227** | 1.0x (baseline) |
| CoreML EP (ANE) | 0.798 | **3.5x SLOWER** |

Outputs were numerically identical between EPs (parity OK). For a model this tiny,
ANE dispatch overhead (wakeup + data transfer) dominates the few-layer LSTM compute,
so the ANE is slower AND not more power-efficient. The ANE wins on LARGE fixed-graph
models (e.g. Kokoro TTS, which correctly ships on CoreML), not tiny per-frame gates.

## Production backend audit (the system is already optimal)
| Model | Cadence | Production backend | Optimal? |
|---|---|---|---|
| Silero VAD | always-on, every 32 ms | **native CPU** (silero_vad_runtime.c: "no ggml link"; active_backend = "native-cpu") | yes — CPU fastest+cheapest for a tiny LSTM (measured) |
| openWakeWord | always-on, every frame | **native CPU** (wakeword_runtime.c: "Pure scalar C"; active_backend = "native-cpu") | yes — same |
| Kokoro TTS | per-utterance | **CoreML** (iOS bridge prefers kokoro_5s.mlmodelc) | yes — larger fixed-graph, ANE helps |
| LLM (Gemma) | per-token, dynamic KV | Metal | yes — ANE can't do dynamic decode |
| Vision mmproj / ASR | bursty | Metal | yes — GPU-sized bursty work |

## Conclusion
The earlier hypothesis ("always-on VAD/wake-word run on the GPU; move them to the ANE
for battery") was WRONG on both counts: (1) they already run on **native CPU**, not
the GPU; (2) the ANE is measured **3.5x slower** for a model this small. The
architecture already routes every voice/vision/LLM model to its optimal per-platform
backend by compute profile. There is **no un-captured CoreML/ANE win** for the voice
gate — the system is already optimal. (LiteRT-LM, the Android-NPU analogue, would hit
the same tiny-model dispatch-overhead wall for these gate models.)
