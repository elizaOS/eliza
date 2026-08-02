# `qjl-cpu`

Standalone C reference and SIMD library for QJL 1-bit Johnson–Lindenstrauss key-cache compression.

## Role

This package provides projection, quantization, scoring, runtime CPU dispatch, benchmarks, and fork-parity tooling without linking the full ggml runtime. It is a reference/tooling surface for QJL block and numerical contracts.

QJL is not the shipping Gemma KV-cache default. The current managed Gemma path uses stock Q8_0/F16 KV with Gemma-compatible flash attention. QJL capability results apply only to the legacy/non-Gemma or explicitly selected routes declared in `plugins/plugin-local-inference/native/verify/kernel-contract.json`.

## Layout

```
include/qjl/             public API
src/qjl_block.h          packed QJL block contract
src/qjl_projection.c     deterministic JL projection
src/qjl_quantize_*.c     scalar, AVX2, NEON, and RVV encoders
src/qjl_score_*.c        scalar and architecture-specific scoring
src/qjl_dispatch.c       runtime feature selection
test/qjl_bench.c         parity and throughput harness
test/qjl_*_smoke.c       focused SIMD/int8 checks
test/qjl_fork_parity.c   dynamic comparison with a built fork
scripts/gen_fixtures.py  deterministic fixture generation
```

The packed layout, projection seed/matrix rules, dimensions, and score normalization are ABI. Coordinate any change with the managed fork, GPU kernels, fixtures, and kernel contract.

## Build and verification

```bash
cmake -B packages/native/plugins/qjl-cpu/build -S packages/native/plugins/qjl-cpu
cmake --build packages/native/plugins/qjl-cpu/build -j
packages/native/plugins/qjl-cpu/build/qjl_int8_smoke
packages/native/plugins/qjl-cpu/build/qjl_avxvnni_smoke
make -C plugins/plugin-local-inference/native/verify kernel-contract
make -C plugins/plugin-local-inference/native/verify reference-test
```

Use `qjl_bench` for scalar/SIMD parity and throughput. Run `qjl_fork_parity` against the exact built fork under test; a successful standalone test does not prove graph dispatch.

## Constraints

- Scalar output is the numerical reference. SIMD lanes must match it within the declared tolerance.
- CPU feature detection must never execute an unsupported instruction.
- Missing fork libraries or unsupported hardware make parity unavailable, not successful.
- Keep this package independent of ggml so converters and inspection tools can use it directly.
- Do not make tier-readiness claims here; update and consult `kernel-contract.json`.

Follow the repository-wide verification standard in the [root CLAUDE.md](../../../../CLAUDE.md). Review packed bytes, score diffs, selected SIMD lane, and built-fork graph evidence.
