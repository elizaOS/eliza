# M7 — Gemma 4 CPU verification evidence (#9033)

Host: linux-x64, 24 threads. Fork build `3e81729da (10027)` = elizaOS/llama.cpp
with the cherry-picked SWA KV-checkpoint RAM fix (PR #27 / upstream #23981).
All runs are the **stock-kernel** Gemma path (stock q8_0 KV — Gemma KV is already
minimal via MQA + windowed-SWA + shared-KV, so the legacy QJL/Polar head_dim=128
kernels are not used, per the M6 decision).

## Text generation (llama-bench)

| Model | Size | pp (t/s) | tg (t/s) |
|---|---|---|---|
| gemma-4-E2B-it Q8_0 | 4.61 GiB / 4.65B | pp64 56.6 | tg32 5.84 |
| gemma-4-E2B-it Q8_0 (12 threads) | — | — | tg16 14.75 |
| gemma-4-E4B-it Q8_0 | 7.46 GiB / 7.52B | — | tg32 4.56 |

Both shipped local tiers (E2B→eliza-1-2b, E4B→eliza-1-4b) load + generate through
the fork unmodified.

## Vision (multimodal mmproj, llama-mtmd-cli)

`gemma-4-E2B-it` + `mmproj-gemma-4-E2B-it-Q8_0` with `--jinja`: the mmproj loads,
the input image is encoded, and the model performs multimodal reasoning over it
(acknowledges + analyzes the provided image). The mmproj also advertises **audio**
input (experimental) — Gemma 4 is natively vision+audio. (Without `--jinja` the C++
chat-template parser throws on Gemma 4's embedded jinja template — a known flag
requirement, not a model defect; the runtime uses jinja.)

## Assembled bundle

`assemble_local_gemma_bundle.py` produced `/tmp/eliza-1-2b.bundle`
(text/vision/mtp-sentinel/checksums + Gemma manifest: tokenizer gemma4 / vocab
262144 / kv stock-q8_0 / mtp separate-drafter / base-v1-candidate /
defaultEligible false). The staged text GGUF loads + generates through the fork
(tg16 14.75 t/s) — the bundle is loadable.

## Not covered here (hardware-gated)

- CUDA: RTX 5080 is sm_120 (Blackwell); host nvcc is 12.0, sm_120 needs CUDA 13.x
  — a host-toolkit gap, not a code issue.
- Metal / CoreML / MLX: needs Apple Silicon.
- Vulkan-Mali + LiteRT-NPU: needs a Pixel/Android device.
