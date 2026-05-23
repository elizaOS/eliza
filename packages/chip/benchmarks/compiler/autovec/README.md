# RVV 1.0 autovec quality suite

Short kernels (`kernels.c`, indexed by `kernels.json`) that exercise the loops
where RVV autovec typically wins or lags against scalar code. The suite is an
Igalia-style RVV health check; it catches autovec regressions at the kernel
level fast enough to gate an LLVM/GCC pin refresh.

## Kernels

| Group | Examples | Why |
| --- | --- | --- |
| Trivial | saxpy, daxpy, dot_product, l2_norm | bandwidth-bound; full LMUL should win |
| Conditional | cond_mask_add, cond_mask_mul | predication overhead |
| Stride | strided_load_2/4, gather_sum_f32 | known autovec weakness |
| Reduction | sum_reduction, max_reduction, sum_i16 | reduction chain length / widening |
| Quantization | int8_quantize, int8_dequantize, saxpy_i8 | INT8 quality, saturation |
| Shuffle | bit_reverse_byte, packed_uint8_to_uint16 | LMUL gather/scatter |
| NN | layernorm, gelu, silu, softmax | activation lowering |
| Bandwidth | memcpy_byte, memset_byte | vse8.v store-loop |

## Two harnesses

1. **Functional RVV 1.0 vector eval** — `run_vector_eval.py`, driven by
   `scripts/run_e1_rvv_vector.sh` and `make rvv-vector`. Builds each kernel
   twice (scalar `rv64gc`, vector `rv64gcv`), runs both under QEMU user-mode
   on an RVV 1.0 substrate (`rva23u64`, vlen=256), and measures the kernel's
   *dynamic* instruction stream via QEMU's execlog TCG plugin, isolated to the
   kernel region by the `kernel_region_begin/end` markers in `driver.c`.
   Output: `docs/evidence/cpu_ap/e1-rvv-vector.json` (schema
   `eliza.cpu_vector_eval.v1`, claim_level `functional`). Reports per-kernel
   scalar-vs-vector dynamic instruction reduction, the RVV ops exercised, and
   a scalar/vector result-checksum cross-check.

2. **LLVM-trunk vs LLVM-stock comparison** — described in `kernels.json`
   `comparison_recipe`; compares the pinned LLVM stage-2 clang against the
   stock distro clang. BLOCKED on the LLVM stage-2 build.

## Claim level

The functional eval is `functional` (L1 row of the claim ladder): it proves
the RVV 1.0 ISA + toolchain execute end to end and measures dynamic
instruction reduction. It is **not** a cycle-accurate or silicon performance
claim — QEMU does not model the e1 vector datapath timing. The cycle-accurate
RTL path is tracked in `docs/arch/rvv-integration-plan.md`.
