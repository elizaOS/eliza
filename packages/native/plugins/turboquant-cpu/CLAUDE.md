# `turboquant-cpu`

Standalone C reference and runtime-dispatch library for TurboQuant TBQ3, TBQ4, and TBQ3-TCQ block formats.

## Role

This package provides user-space block encode/decode, architecture dispatch, smoke/parity tests, and a metadata converter. It is a mirror used by tooling and native verification, not the llama.cpp integration itself.

The managed fork and `plugins/plugin-local-inference/native/verify/kernel-contract.json` define production capabilities. Current Gemma bundles use TurboQuant Q4 weights but stock Q8_0/F16 KV; older QJL/TBQ cache combinations must not be generalized into Gemma readiness claims.

## Layout

```
include/turboquant/             public block/API contracts
src/tbq_block_ref.c            scalar encode/decode reference
src/tbq_dispatch.c             runtime CPU feature selection
src/tbq_encode_rvv.c           RVV encoder
src/tbq_decode_rvv.c           RVV decoder
test/turboquant_smoke.c        block layout and round-trip checks
test/turboquant_simd_parity.c  scalar/selected-lane parity
scripts/turboquant_to_gguf.py  metadata/GGUF tooling
```

x86_64 and arm64 currently select the scalar implementation in this standalone package; RVV is the implemented SIMD lane. Do not claim AVX2 or NEON coverage until their translation units and dispatch tests exist.

Block sizes, bit packing, centroids/codebooks, transform rules, and TCQ state are ABI. Coordinate changes with the managed fork, CUDA/Metal/Vulkan implementations, fixture generator, and model manifests.

## Build and verification

```bash
cmake -B packages/native/plugins/turboquant-cpu/build -S packages/native/plugins/turboquant-cpu
cmake --build packages/native/plugins/turboquant-cpu/build -j
ctest --test-dir packages/native/plugins/turboquant-cpu/build --output-on-failure
make -C plugins/plugin-local-inference/native/verify kernel-contract
make -C plugins/plugin-local-inference/native/verify reference-test
```

For RVV work, run on real RVV hardware or a clearly identified emulator and record vector-length/toolchain details. Standalone tests do not prove built-fork graph dispatch.

## Constraints

- Scalar output is the reference.
- Runtime feature selection must fall back safely without executing unsupported instructions.
- Bad block lengths or metadata fail explicitly; do not fabricate decoded values.
- Keep this package independent of ggml.
- Do not encode tier matrices or transient release status here; use the kernel contract and artifact manifests.

Follow the repository-wide verification standard in the [root CLAUDE.md](../../../../CLAUDE.md). Review packed blocks, parity diffs, selected dispatch lane, converter output, and relevant real-hardware graph evidence.
