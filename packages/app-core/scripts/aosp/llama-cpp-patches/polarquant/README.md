# `polarquant/` — DEPRECATED archival patch series

> **Superseded by `elizaOS/llama.cpp @ v0.1.0-eliza`.** These patches
> are no longer applied; PolarQuant Q4 is baked into the fork at
> `plugins/plugin-local-inference/native/llama.cpp/`. See the parent
> `../README.md` for the migration story and rollback path.

## Historical content (frozen)

Four patches that added `GGML_TYPE_Q4_POLAR = 45` to
`apothic/llama.cpp-1bit-turboquant` @ `b2b5273`:

| Patch | Effect |
|---|---|
| `0001-...` | Registers `GGML_TYPE_Q4_POLAR = 45` + `block_q4_polar` layout. |
| `0002-...` | Vendors the PolarQuant reference kernels into ggml-base. |
| `0003-...` | `tests/test-quantize-fns` coverage; fixes a latent buffer overflow. |
| `0004-...` | Gates the QJL residual on a runtime flag (default off). |

Now landed on `elizaOS/llama.cpp` branch `eliza/polarquant` —
**slot bumped from 45 to 47** so QJL (46) and Polar (47) coexist
without colliding with TBQ4_0 at slot 45 (which the fork's TBQ port
took during the consolidation).

## Where the live code is

- Fork enum: `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`
  (`GGML_TYPE_Q4_POLAR = 47`).
- Fork block layout: `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`
  (`block_q4_polar`).
- Fork CPU implementation:
  `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/quants.{c,h}`.
- Standalone user-space library:
  `packages/native-plugins/polarquant-cpu/` (this is what
  `polarquant_to_gguf.py` and off-llama.cpp parity tests link).
- Tier coverage matrix:
  `packages/training/reports/eliza1-quant-matrix-2026-05-14.md`.
