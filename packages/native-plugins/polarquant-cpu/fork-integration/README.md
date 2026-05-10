# PolarQuant Q4 — `Apothic-AI/llama.cpp-1bit-turboquant` integration

This directory holds the patch set + drop-in source files that register
`block_q4_polar` (`GGML_TYPE_Q4_POLAR = 45`) inside the Apothic
llama.cpp fork.  The standalone reference library in the parent
directory is the source of truth for the kernels; the files here are
the in-fork shim that makes those kernels available through llama.cpp's
type-traits dispatch.

## Files

| File | Drop into | Purpose |
|---|---|---|
| `ggml-common.h.patch`  | `ggml/src/ggml-common.h`            | adds `block_q4_polar` struct + the `#define QK_POLAR 128` constant. |
| `ggml.h.patch`         | `ggml/include/ggml.h`               | adds `GGML_TYPE_Q4_POLAR = 45` to the `ggml_type` enum. |
| `quants-polar.c`       | `ggml/src/ggml-cpu/quants-polar.c`  | new TU: scalar + AVX2 + NEON quantize / dequantize / dot. |
| `ggml-cpu.c.patch`     | `ggml/src/ggml-cpu/ggml-cpu.c`      | adds the `type_traits[GGML_TYPE_Q4_POLAR]` row. |
| `ggml-quants.c.patch`  | `ggml/src/ggml-quants.c`            | adds the `case GGML_TYPE_Q4_POLAR` in `ggml_quantize_chunk`. |
| `CMakeLists.patch`     | `ggml/src/ggml-cpu/CMakeLists.txt`  | adds `quants-polar.c` to the per-arch SIMD source list (mirrors the `quants.c` registration). |

## Why a separate TU and not append to `quants.c`

`quants.c` is already ~10 kLOC; adding 600 more LOC for one new quant
type makes review noisy and merge-conflict-prone against upstream.
The fork's TBQ port made the same call (`quants-tbq.c` is the convention
the fork already uses), and PolarQuant follows that pattern.

## Wiring vs the standalone library

The standalone `polarquant-cpu` static lib in the parent directory
ships:

  - the locked block layout (`include/polarquant/polar_block.h`),
  - the Lloyd-Max centroid LUT (`include/polarquant/polar_centroids.h`),
  - the scalar / AVX2 / NEON kernels under `src/`.

`quants-polar.c` here is *not* a textual copy of those files — it is a
transcription that uses llama.cpp's existing typedefs (`ggml_fp16_t`,
`block_q8_0`) instead of the standalone library's mirror typedefs
(`polar_fp16_t`, `polarquant.h::block_q8_0`).  The math is identical;
only the type names differ.  The standalone library remains the
behavioral source of truth (it has the unit tests + parity gates), and
`quants-polar.c` here is what compiles into `libggml-cpu.so`.

When a kernel changes, update both:

  1. the standalone library file (so the unit tests keep gating it),
  2. the matching block in `quants-polar.c` here (so the in-fork build
     picks up the change).

A future cleanup could collapse this duplication by `#include`-ing the
standalone library headers directly inside `quants-polar.c`, but that
requires a tighter ABI agreement on `ggml_fp16_t` <-> `polar_fp16_t`
than the fork currently exposes.

## Verification gate before vendor PR

After applying the patches and dropping `quants-polar.c`, run:

```
cd <fork-checkout>
cmake -B build -S . -DGGML_NATIVE=ON -DLLAMA_BUILD_TESTS=ON
cmake --build build -j --target test-quantize-fns
./build/bin/test-quantize-fns Q4_POLAR
```

`test-quantize-fns` is the upstream llama.cpp regression that exercises
quantize + dequantize roundtrip + dot product against a synthetic
input.  The PPL-on-Wikitext-2 gate in
`docs/porting/on-device-quantization-porting-plan.md` runs separately
through `llama-perplexity` once a real Q4_POLAR model GGUF is built.

## Pinning the integrated commit

When the fork's `polarquant-q4-cpu` branch lands and is pushed, update
`packages/app-core/scripts/aosp/compile-libllama.mjs`:

```
export const LLAMA_CPP_TAG    = "polarquant-q4-cpu-<short-sha>";
export const LLAMA_CPP_COMMIT = "<full-sha>";
```

The compile-libllama cache is keyed off `LLAMA_CPP_COMMIT`, so bumping
the pin transparently invalidates the cached checkout and triggers a
rebuild on the next `bun run aosp:llama` invocation.
