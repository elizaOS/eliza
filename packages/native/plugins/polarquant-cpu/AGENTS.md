# `polarquant-cpu`

Standalone C reference and SIMD library for the Q4 PolarQuant block format.

## Role

This package owns user-space PolarQuant encoding, decoding, dot products, pre-Hadamard-query scoring, optional QJL residual handling, runtime CPU dispatch, and GGUF conversion. It stays independent of the full ggml runtime so parity harnesses and converters can link it directly.

PolarQuant is not the shipping Gemma KV-cache default. Current Gemma bundles use stock Q8_0/F16 KV; PolarQuant results apply to explicitly selected or legacy/non-Gemma routes. Backend readiness and allowed scope are defined in `plugins/plugin-local-inference/native/verify/kernel-contract.json`.

## Layout

```
include/polarquant/             public block/API contracts
src/polar_quantize_ref.c       scalar encoder
src/polar_dequantize_*.c       scalar, AVX2, NEON, and RVV decoders
src/polar_dot_*.c              scalar and SIMD dot products
src/polar_dot_preht_*.c        pre-Hadamard-query paths
src/polar_hadamard.c           Walsh-Hadamard transform
src/polar_qjl.c                optional residual sign sequence
src/polar_dispatch.c           runtime feature selection
scripts/polarquant_to_gguf.py  GGUF converter
scripts/test_converter.py      converter round trip
test/                          numerical and SIMD parity
fork-integration/              reference integration patches
```

The packed block size/layout, centroid table, transform normalization, sign seed, and residual semantics are ABI. Change them only with coordinated converter, fork, GPU shader, fixture, and manifest updates.

## Build and verification

```bash
cmake -B packages/native/plugins/polarquant-cpu/build -S packages/native/plugins/polarquant-cpu
cmake --build packages/native/plugins/polarquant-cpu/build -j
ctest --test-dir packages/native/plugins/polarquant-cpu/build --output-on-failure
python3 packages/native/plugins/polarquant-cpu/scripts/test_converter.py
make -C plugins/plugin-local-inference/native/verify kernel-contract
make -C plugins/plugin-local-inference/native/verify reference-test
```

Use `polar_bench` for throughput diagnosis. Standalone parity does not prove a backend graph route; run the relevant built-fork smoke on real hardware.

## Constraints

- Scalar math is the reference; every SIMD path must preserve its tolerance.
- Runtime dispatch must never execute unsupported instructions.
- Malformed blocks and converter metadata are errors, never zero-filled output.
- Keep the library independent of ggml and keep fork patches narrowly reviewable.
- Do not make tier-readiness claims here; use the kernel contract and actual artifact manifest.

Follow the repository-wide verification standard in the [root CLAUDE.md](../../../../CLAUDE.md). Review encoded bytes, round-trip error, dot-product diffs, dispatch selection, and hardware graph evidence.
