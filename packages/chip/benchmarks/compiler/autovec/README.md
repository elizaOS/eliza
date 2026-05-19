# RVV 1.0 autovec quality suite

Sixteen short kernels that exercise the kinds of loops where RVV autovec
typically lags or wins against GCC and SVE2. The suite is an Igalia-style
RVV health check: it does not aim to replace the LLVM test-suite, but it
catches autovec regressions at the kernel level fast enough to gate every
LLVM-trunk pin refresh.

## Kernels

| Group | Kernels | Why |
| --- | --- | --- |
| Trivial | saxpy, daxpy, dot_product, l2_norm | bandwidth-bound; full LMUL=8 should win |
| Conditional | cond_mask_add, cond_mask_mul | predication overhead; price-stride load |
| Stride | strided_load_2, strided_load_4 | known LLVM weakness vs GCC and SVE2 |
| Reduction | sum_reduction, max_reduction, argmax | reduction width / chain length |
| Quantization | int8_quantize, int8_dequantize | INT8 dot quality |
| Shuffle | bit_reverse_byte, packed_uint8_to_uint16 | LMUL gather/scatter |

## Output

The runner produces `build/reports/compiler/autovec-results.json`,
schema `eliza.autovec_results.v1`, recording per-kernel runtime, vector
instruction count, and a comparison against LLVM-stock and GCC-15 if those
toolchains are available in the container.

## Status

- Sixteen kernel sources committed under `kernels/`.
- Build/run harness committed.
- End-to-end run: BLOCKED on LLVM stage 2 + a RISC-V simulator/runtime.
