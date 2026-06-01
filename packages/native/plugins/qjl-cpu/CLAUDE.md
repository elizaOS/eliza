# qjl-cpu — AGENTS

Standalone C library for the **QJL** 1-bit Johnson–Lindenstrauss
K-cache compressor. The fork-side ggml type is
`GGML_TYPE_QJL1_256=46`. Sibling of `polarquant-cpu` (V-cache + Q4
weights) and `turboquant-cpu` (TBQ V-cache / W-cache).

The combined fork that ships QJL + Q4_POLAR + TBQ is
**`elizaOS/llama.cpp @ v0.1.0-eliza`**, vendored at
`plugins/plugin-local-inference/native/llama.cpp/`. See
`README.md` for the algorithm and bit-parity contract.

## Source of truth

| File | Contains |
|---|---|
| `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`            | `GGML_TYPE_QJL1_256=46` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`         | `block_qjl1_256` (34 B) |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/qjl/quants-qjl.c` | fork CPU implementation |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/fused-attn-qjl-tbq.c` | `GGML_OP_FUSED_ATTN_QJL_TBQ` (QJL K + TBQ3 V) |

This standalone library is the user-space mirror; user-space tools
(parity tests, GGUF inspectors, off-llama.cpp benchmarks) link
`libqjl.a` directly.

## Current tier coverage (W3 quant-matrix — 2026-05-14)

QJL is the **K-cache default for every shipping Eliza-1 tier** — see
`packages/shared/src/local-inference/catalog.ts::runtimeForTier`
(`kvCache.typeK = "qjl1_256"`, all tiers).

| Tier              | QJL1_256 K-cache (default) |
|-------------------|---------------------------:|
| eliza-1-0_8b      | shipped (default) |
| eliza-1-2b        | shipped (default) |
| eliza-1-4b        | shipped (default) |
| eliza-1-9b        | shipped (default) |
| eliza-1-27b       | shipped (default) |
| eliza-1-27b-256k  | shipped (default; pairs with TBQ3_TCQ K extension at ≥64k ctx) |

The full tier × quant-type matrix (rows = tier, columns = QJL-K +
PolarQuant-V + TurboQuant-W variants) lives at
`packages/training/reports/eliza1-quant-matrix-2026-05-14.md`.

## Tests + parity

- `qjl_bench --parity <fixture.bin>` — bit-exact vs the Python QJL
  reference at `packages/training/scripts/quantization/qjl/`.
- `qjl_bench --throughput` — scalar vs AVX2 µs/vec.
- `qjl_fork_parity` — dlopen the fork's `libggml-cpu.so` and assert
  `quantize_row_qjl1_256` matches the standalone scalar ref over 100
  random vectors.
- `make -C plugins/plugin-local-inference/native/verify kernel-contract`
  is the cross-package gate; it lists `qjl` and `qjl_full` in
  `manifestKernelNames` / `requiredRuntimeCapabilityKeys` and reads
  the fixture this library generates.
