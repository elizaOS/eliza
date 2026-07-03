ggml_vulkan: Found 1 Vulkan devices:
ggml_vulkan: 0 = Mali-G78 (Mali-G78) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 16 | shared memory: 32768 | int dot: 0 | matrix cores: none
| model                          |       size |     params | backend    | ngl |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | --------------: | -------------------: |
| qwen35 2B Q4_K - Medium        |   1.17 GiB |     1.88 B | Vulkan     |  99 |           pp128 |          3.88 ± 0.27 |
| qwen35 2B Q4_K - Medium        |   1.17 GiB |     1.88 B | Vulkan     |  99 |           pp512 |          8.86 ± 0.01 |
| qwen35 2B Q4_K - Medium        |   1.17 GiB |     1.88 B | Vulkan     |  99 |           tg128 |          6.78 ± 0.02 |

build: ba598f562 (10043)

Notes:
- Run while `ai.elizaos.app` was force-stopped (no GPU contention from the app),
  against `/data/local/tmp/eliza-1-2b-q4.gguf` — md5-verified identical
  (41692e13a6998fdeefbeaabfd9bec00d) to the file the app serves from
  `files/.eliza/local-inference/models/text/`.
- Binary + Vulkan libs: `/data/local/tmp/eliza-9508/` (llama.cpp build ba598f562).
- CAVEAT: a separate quick diagnostic invocation (`-p 16 -n 8 -r 1`: pp16 = 0.51,
  tg8 = 7.32 t/s) overlapped part of the pp128 measurement window, so
  pp128 3.88 +/- 0.27 is contended; pp512 and tg128 ran uncontended.
- Prefill throughput scales strongly with batch size on Mali-G78
  (pp16 0.51 -> pp128 3.88 -> pp512 8.86 t/s): per-dispatch overhead dominates
  small batches. The 2026-07-02 #11352 baseline's pp32 = 2.6 t/s sits on the
  same curve.
