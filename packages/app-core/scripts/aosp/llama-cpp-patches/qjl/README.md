# `qjl/` — DEPRECATED archival patch series

> **Superseded by `elizaOS/llama.cpp @ v0.1.0-eliza`.** These patches
> are no longer applied; QJL is baked into the fork at
> `plugins/plugin-local-inference/native/llama.cpp/`. See the parent
> `../README.md` for the migration story and rollback path.

## Historical content (frozen)

Five patches that added `GGML_TYPE_QJL1_256 = 46` and
`GGML_OP_ATTN_SCORE_QJL` to `apothic/llama.cpp-1bit-turboquant`
@ `b2b5273`:

| Patch | Effect |
|---|---|
| `0001-...` | Adds the `GGML_TYPE_QJL1_256 = 46` enum + `GGML_OP_ATTN_SCORE_QJL`. |
| `0002-...` | Registers the type-traits + the score op (largest delta). |
| `0003-...` | Pins `block_qjl1_256.blck_size = head_dim = 128`. |
| `0004-...` | Test coverage for the cache + score path. |
| `0005-...` | Flips `block_qjl1_256` byte order to signs-then-norm. |

Now landed on `elizaOS/llama.cpp` branch `eliza/qjl` and merged into
`eliza/integration` (slot 46 unchanged).

## Where the live code is

- Fork enum: `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`
  (`GGML_TYPE_QJL1_256 = 46`).
- Fork block layout: `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`
  (`block_qjl1_256`).
- Fork CPU implementation:
  `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/qjl/quants-qjl.c`.
- Standalone user-space library:
  `packages/native-plugins/qjl-cpu/` (this is what GGUF tools and
  off-llama.cpp parity tests link).
- Tier coverage matrix:
  `packages/training/reports/eliza1-quant-matrix-2026-05-14.md`.
