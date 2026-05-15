# turboquant-cpu — AGENTS

Standalone C library for the **TurboQuant** weight/value-cache
quantization formats (`block_tbq3_0`, `block_tbq4_0`, and the future
`block_tbq3_tcq`). Sibling of `qjl-cpu` (K-cache) and
`polarquant-cpu` (V-cache + Q4 weights). The combined fork that ships
all three is **`elizaOS/llama.cpp @ v0.1.0-eliza`** (vendored at
`plugins/plugin-local-inference/native/llama.cpp/`).

## Source of truth

The fork's authoritative declarations live at:

| File | Contains |
|---|---|
| `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`        | `GGML_TYPE_TBQ3_0=44`, `GGML_TYPE_TBQ4_0=45`, `GGML_TYPE_TBQ3_TCQ=48` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`     | `block_tbq3_0` (14 B), `block_tbq4_0` (18 B) |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-quants.c`     | `quantize_row_tbq{3,4}_0`, `dequantize_row_tbq{3,4}_0` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/fused-attn-qjl-tbq.c` | `GGML_OP_FUSED_ATTN_QJL_TBQ` (QJL K + TBQ3 V kernel) |
| `plugins/plugin-local-inference/native/reference/turbo_kernels.{c,h}`        | bit-exact CPU reference (the math this library copies) |

This standalone library is the **user-space** mirror of those kernels:
GGUF converters, off-llama.cpp parity tests, and the fused-attn
verification harness link `libturboquant.a` directly so they don't
need to pull the full ggml dependency.

## Layout (mirrors qjl-cpu / polarquant-cpu exactly)

```
include/turboquant/turboquant.h    Public API: block layouts, codebooks, encode/decode.
src/tbq_block_ref.c                Scalar reference — bit-exact to the fork's
                                   ggml-quants.c::quantize_row_tbq*_0 and
                                   dequantize_row_tbq*_0.
test/turboquant_smoke.c            Block-encode/decode round-trip smoke test.
                                   Asserts sizeof(block_tbq3_0)==14, sizeof(block_tbq4_0)==18.
scripts/turboquant_to_gguf.py      GGUF converter skeleton (TBQ3_0=44 / TBQ4_0=45).
fork-integration/                  Reserved for in-fork drop-ins (not yet populated;
                                   the elizaOS fork already has TBQ baked in upstream
                                   of this directory, see the patches/README.md).
CMakeLists.txt                     Builds libturboquant.a + turboquant_smoke.
```

## Build + smoke

```bash
cd packages/native-plugins/turboquant-cpu
cmake -S . -B build
cmake --build build --target turboquant_smoke
./build/turboquant_smoke
```

The smoke test must print `[turboquant_smoke] PASS` and exit 0.

## Current tier coverage (W3 quant-matrix — 2026-05-14)

This library is the user-space half of TBQ3/TBQ4 V-cache support.
Every shipping Eliza-1 tier (`0_8b`, `2b`, `4b`, `9b`, `27b`,
`27b-256k`, `27b-1m`) defaults to QJL K + Q4_POLAR V at >8k context
and falls back to QJL K + TBQ3_0 V at ≤8k context (see
`packages/shared/src/local-inference/CONTEXT_SCALING.md` table 1 +
`packages/shared/src/local-inference/catalog.ts::runtimeForTier`).

The TBQ types themselves are **shipped in the fork**, not buildable
from this library yet:

| Tier         | TBQ3_0 V-cache | TBQ4_0 W-cache | TBQ3_TCQ K (≥64k ctx) |
|--------------|---------------:|---------------:|----------------------:|
| eliza-1-0_8b |          ✓ shipped | n/a (Q4_K_M weights default) | n/a |
| eliza-1-2b   |          ✓ shipped | n/a | n/a |
| eliza-1-4b   |          ✓ shipped | n/a | required ≥65k |
| eliza-1-9b   |          ✓ shipped | ✓ buildable via fused_turboquant_apply | required ≥65k |
| eliza-1-27b  |          ✓ shipped | ✓ buildable | required ≥65k |
| eliza-1-27b-256k | ✓ shipped | ✓ buildable | required (256k) |
| eliza-1-27b-1m   | ✓ shipped | ✓ buildable | required (1m) |

See `packages/training/reports/eliza1-quant-matrix-2026-05-14.md` for
the full tier × quant-type matrix and per-cell evidence (shipped
artifact paths, build commands, kernel-contract test references).

## What this library is not

- Not a llama.cpp integration. The fork already contains TBQ.
- Not a SIMD library yet — only the scalar reference is in place.
  AVX2 / NEON lanes will land beside `tbq_block_ref.c` following the
  qjl-cpu / polarquant-cpu per-arch dispatch pattern.
- Not the K-cache compressor. That's `qjl-cpu`. TBQ4_0 keys are an
  alternative path the fork supports for callers that want a stricter
  4-bit K format than QJL's 1-bit JL sketch.
