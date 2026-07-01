# #8848 — eliza-1 on-device Metal/GPU benchmark (Apple M4 Max, macOS 26.2)

Real on-device run of the eliza-1 0.8b GGUF (`pretrained_0_8b_128k.gguf`, 531 MB)
through the repo's llama.cpp Metal build (`.tmp/llama-mtp-build`), all layers on
GPU (`-ngl 99`).

## System
- **Apple M4 Max**, Metal 4, 16 cores (12 inference threads), unified memory.
- `system_info: MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | ARM_FMA = 1 | FP16_VA = 1 | DOTPROD = 1 | ACCELERATE = 1 | REPACK = 1` — Metal backend active alongside NEON/FP16/Accelerate.

## Performance
| Stage | Throughput | Detail |
|---|---|---|
| Load | — | 310 ms |
| **Prefill (prompt eval)** | **1044.87 tok/s** | 18 tok / 17.23 ms (0.96 ms/tok) |
| **Decode (eval)** | **250.76 tok/s** | 95 tok / 378.86 ms (3.99 ms/tok) |
| Total | — | 408 ms / 113 tok |

## Correctness
Prompt `"Q: Why is the sky blue? A:"` → coherent answer (Rayleigh scattering,
shorter blue wavelengths scattered more) with the eliza-1 `<think>` reasoning
envelope — the model loads, offloads to Metal, and generates correctly on-device.

## Notes
- The fused QJL/TBQ/Polar kernels (`packages/native/plugins/{turboquant,qjl,polarquant}-cpu`) target the **retired** eliza-1-0.8b's q-domain; the shipped Gemma-4 path uses stock f16/q8_0 KV through ggml-metal (verified earlier on #8848). This benchmark exercises that stock Metal path on real Apple-Silicon GPU.
