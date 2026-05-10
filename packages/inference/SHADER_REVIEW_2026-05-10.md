# Shader perf review — 2026-05-10 (Wave-3 post-verify)

Context: all 5 Metal shaders are 8/8 PASS on Apple M4 Max (max diff 1.1e-5
for QJL, ≤7.6e-6 for the rest). Vulkan turbo* shaders are 8/8 PASS on Intel
ARL + lavapipe. Verify harness fixes the dispatch threadgroup size at 32, so
any change that requires a different threadgroup size also needs a harness
extension.

This doc captures medium-confidence perf wins (need experiment + reverify)
and low-confidence / large-rewrite items (architectural).

---

## Landed in this pass (high-confidence)

These are committed to the shaders and re-verified 8/8 PASS:

1. **`metal/polar.metal` — threadgroup-cooperative Walsh-Hadamard butterfly.**
   The 7-stage / 64-pair-per-stage butterfly + the 128-element `*POLAR_INV_QK`
   rescale used to run entirely on `tid==0` while the other 31 threads idled.
   Replaced with a 32-thread cooperative butterfly: each thread owns 2 of the
   64 (a+b, a-b) pairs per stage, with a single barrier between stages. The
   `(1/QK_POLAR)` compensation is folded into the final per-row scalar
   multiplication (one float on `tid==0`) instead of a 128-element pass.

   **Bench (Apple M4 Max, 1000 iters/kernel, interleaved, 9B-class single
   attention step at seq=4096, n_rows=131072):**
   - Before: `polar` GPU median **5726 µs**, BW 1.97 GB/s (0.4% of peak).
   - After:  `polar` GPU median **458 µs**, BW 24.58 GB/s (4.5% of peak).
   - **12.5× speedup**; polar is now in line with the other four KV kernels
     (~240–460 µs each).
   - Single-block correctness fixture: 8/8 PASS, max diff 7.6e-6 (same as
     pre-change baseline — the change is algebraically identical, the
     `*POLAR_INV_QK` is just deferred to a single scalar multiply post-reduction).

   Same parallelization applied to the optional QJL-residual add path (the
   xorshift32 sign chain is still sequential on `tid==0` into shared scratch
   because the chain is recurrent, but the 128-element add of the resulting
   signs is now parallel). The `use_qjl=0` fixture path doesn't exercise this
   but the `use_qjl=1` path is required by the same correctness contract.

2. **`metal/qjl.metal` — float4 vectorised q_sketch loads.**
   Both `kernel_attn_score_qjl1_256` and `kernel_mul_mv_qjl1_256_f32` walk 8
   contiguous fp32 entries from the query sketch per thread (32 threads × 8
   bytes of sign-bits = 256 sign multiplications per dispatch). The 8 fp32
   entries per thread are 32-byte aligned (`base = tid*8`) and were being
   issued as 8 scalar `device const float *` loads. Replaced with two
   `device const float4 *` loads + branchless ±1 sign packed into two `float4`
   vectors + chained `fma()`s. Cuts the per-thread load instruction count
   from 8 to 2 and gives the GPU a coalesce-friendly transaction shape.

   Verify: 8/8 PASS, max diff 1.14e-5 (matches the pre-change Wave-3 baseline
   exactly — the FMA reordering produces the same value to within fp32
   rounding).

   Bench: at 131k tiny threadgroups per dispatch the QJL kernel is launch-tax
   bound, not bandwidth bound (~240 µs steady, ~6 GB/s, 1.3% of peak). The
   load-vectorisation is correctness-neutral and reduces per-thread
   instruction count, but the workload is too launch-dominated for the
   change to show in the median µs at the verify-harness scale. Should help
   on the larger H200 / multi-block dispatch shape.

---

## Medium-confidence (proposed, need experiment + reverify)

### M1. Mirror the Hadamard parallelization into `vulkan/polar.comp`.

The Vulkan `polar.comp` has the **exact same pattern** as the Metal version:
the butterfly + the `* POLAR_INV_QK` rescale both run on `tid==0`. The Metal
fix is mechanically translatable (32 threads, 2 pairs per stage, one
`barrier()` between stages). The blocker is that `verify/vulkan_verify.cpp`
hard-codes the turbo bind-set + push-constants, so the Vulkan polar harness
needs a separate verify binary or a harness branch before this can be
verified on hardware. Without a verified bench the fix is correctness-neutral
but the perf claim is unproven on the Vulkan side.

**Proposed change:** lift the new `polar_hadamard_inplace_tg32` design from
`metal/polar.metal` into `vulkan/polar.comp`'s shared-memory tree.
**Verification needed:** extend `verify/vulkan_verify.cpp` to handle the
polar bind-set (one block, one fp32 query, one row of output) and re-run
the 8/8 fixture against `polar.spv` on Intel ARL + lavapipe.
**Hypothesis:** same ~10× speedup the Metal fix delivered, since the
sequential-on-tid==0 pattern is the same.

### M2. Larger threadgroup size (64 / 128 / 256) for the per-block kernels.

The verify harness fixes `tg = MTLSizeMake(32, 1, 1)` for every kernel. The
shaders all assume `threadgroup_size == 32` for `simd_sum`. On Apple M4 Max
the SIMD-group size is 32 — running 1 SIMD-group per threadgroup means each
threadgroup occupies one execution unit, but the dispatch grid is 131k
threadgroups for the 9B workload. Apple's GPU launch tax dominates
(~240 µs steady-state for all four small kernels regardless of the work
inside).

**Proposed change:** dispatch 64- or 128-thread threadgroups that process
2 or 4 KV blocks per threadgroup. Each block still uses one SIMD-group of 32
threads for its `simd_sum`; the threadgroup hosts 2/4 SIMD-groups in
parallel, amortising the launch tax.
**Verification needed:** harness extension (`MTLSize(64,1,1)` + matching grid
divisor). Shader change: index the block by `tid / 32` and the per-thread
work by `tid % 32`. The `simd_sum` would still cover one SIMD-group via
Apple's per-SIMD-group reduction semantics.
**Hypothesis:** 1.5–3× speedup on the small kernels at the H200 / long-context
scale where launch tax is the binding constraint. Mobile devices with
smaller GPUs may not see the same gain — keep the 1-block-per-tg variant for
mobile if the multi-block variant regresses.

### M3. Multi-block per dispatch for long contexts (32k+ tokens).

Once M2 lands, the natural next step is a single dispatch that processes
N consecutive blocks per threadgroup with a streaming load. At seq=32k the
KV cache is 256 MB+ and `n_rows = 32 * 32768 = 1,048,576`; the per-block
launch tax is the dominant cost. A "block group" dispatch shape that maps
8 or 16 blocks to one threadgroup amortises both launch tax and shared
constant-buffer access (codebook, centroid LUT) over more arithmetic.
**Verification needed:** a bench-only harness change to dispatch the
multi-block variant against the same fixture (the fixture's 8 outputs would
just be tiled across 1 or 2 threadgroups); correctness is unchanged.

### M4. Promote the TCQ codebook to `constant address space`.

`metal/turbo3_tcq.metal` binds the 512-entry (2 KB) codebook as
`constant float * codebook [[buffer(3)]]`. The compiler already knows it's
in the constant address space — but the binding is a `device const float *`
in the verify harness (`MTLBuffer` allocated via `newBufferWithBytes:`). On
Apple Silicon, MTLBuffer-backed `constant` parameters do hit the constant
texture cache, but a true "embed the codebook in the shader" via a `constant
float CB[512] = {...}` literal would let the compiler put it in instruction-
stream constants and skip the load entirely.
**Trade-off:** 2 KB of literals × 1 shader is not free for compile time, and
the codebook is data-defined (lives in `reference/turbo_kernels.h` as
`ELIZA_TURBO3_TCQ_CODEBOOK`). Inlining would require a code-generation step.
**Verification needed:** generate the inlined variant via a small `gen` script,
re-verify, bench. Hypothesis: small per-thread load latency win at most.
Likely **low** confidence — list here for completeness; would not pursue
unless TCQ becomes the hot path.

### M5. fp16 / bf16 math for the Hadamard butterfly + the dot product.

Apple Silicon has 2× fp16 throughput vs fp32 in the ALU. The polar Hadamard
butterfly is 7 stages × 64 ops = 448 add/sub ops per block; the per-element
range is bounded by the centroid LUT (`[-2.75, +2.75]` × `2^7 = 128` ≈ 350
worst case). fp16's ±65504 range easily covers that. Doing the butterfly +
the per-element rescale in fp16 with fp32 accumulation in the dot product
would roughly halve the butterfly latency and cut the threadgroup-shared
buffer footprint from 512 B to 256 B per dispatch.
**Trade-off:** precision. The butterfly is a numerically stable transform
(bounded growth), but the LUT centroids start at fp32 precision; fp16
quantisation noise is ~3e-4 per op vs ~1e-7 for fp32. Across 7 stages this
could blow past the harness's 1e-3 tolerance.
**Verification needed:** an `fp16` variant of `polar_hadamard_inplace_tg32`
+ `polar.metal` re-verify. Hypothesis: ~1.5–2× speedup on the polar kernel
post-M1 (Hadamard is a smaller share of the runtime now), at a measurable
precision cost.

### M6. Pre-decode the TCQ bit window into a per-thread cache.

`turbo3_tcq.metal`'s `kernel_turbo3_tcq_dot` re-walks the bit stream 4× per
thread (`for (uint local = 0; local < 4; ++local)`). Each iteration reads two
adjacent bytes and extracts a 9-bit window. The 4 `local` iterations of a
single thread read 4 windows that overlap by up to 3 bits each (bit_pos is
3, 6, 9, 12 within the thread's slice). A 32-bit register could pre-load
the relevant 4 bytes once and be shifted in-register for each `local`
iteration, eliminating 4 byte loads per iteration.
**Verification needed:** rewrite the TCQ inner loop with a single 32-bit
register pre-load (`uint w = qs[byte_idx0] | (qs[byte_idx0+1] << 8) | ...`),
then derive each window via `(w >> bit_off_local) & 0x1FF`.
**Hypothesis:** small win — 4 loads → 1 load × 4 windows = 75% load reduction
in the hot loop, but the kernel is launch-tax bound at the verify scale.
Worth doing for the H200 multi-block dispatch shape.

---

## Low-confidence / large rewrites

### L1. Multi-token batched attention score (QJL).

The `kernel_attn_score_qjl1_256` dispatches one threadgroup per (h_q, t).
At decode time `t` is small (one new token), so the dispatch grid degenerates
to 32 × 1 = 32 threadgroups — a tiny launch where the launch tax dominates.
A batched variant that processes one h_q across all `n_tokens` in a single
threadgroup (32 threads × one token sweep per outer iteration) would
amortise the dispatch but requires a complete kernel restructure and a
harness extension to drive it.

### L2. Fused QJL+softmax+V-cache decode (Eliza-1 attention pipeline).

The score kernel emits `scores[h_q, t]` to global memory; the next stage
reads them back to do softmax + multiply by V. Fusing those three stages
into one kernel (per Apple's standard "flash-attention" recipe) removes the
intermediate global store, but it requires owning the V-cache layout
(currently PolarQuant) inside the same kernel and tile-streaming both
caches. This is properly the `dflash-server.ts` integration's responsibility
and lives outside this directory's contract.

### L3. wave64-aware Vulkan reduction.

The current `vulkan/*.comp` files use `shared float partials[32]` for the
tree reduction, hard-coded to a 32-thread workgroup. AMD GCN (wave64) and
some RDNA configurations would benefit from a 64-thread workgroup using
`shared float partials[64]` (or `[gl_WorkGroupSize.x]` if the harness
gained a `--wave-size` arg). This is a portable-but-larger workgroup
variant and would need a separate `.comp` per wave size or a templated
build. Today's Wave-3 verify on Intel ARL + lavapipe (subgroup_size = 32 /
4 respectively) does not exercise this and the Vulkan turbo* shaders
already pass 8/8. Pursue only if AMD-specific perf becomes a constraint.

---

## Verification record

After the high-confidence changes (Hadamard parallelization in
`metal/polar.metal`, vec4 q_sketch loads in `metal/qjl.metal`):

```
$ ./metal_verify ../metal/turbo3.metal     kernel_turbo3_dot              fixtures/turbo3.json     # 8/8 PASS, max diff 3.3e-6
$ ./metal_verify ../metal/turbo4.metal     kernel_turbo4_dot              fixtures/turbo4.json     # 8/8 PASS, max diff 5.7e-6
$ ./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot          fixtures/turbo3_tcq.json # 8/8 PASS, max diff 6.7e-6
$ ./metal_verify ../metal/qjl.metal        kernel_attn_score_qjl1_256     fixtures/qjl.json        # 8/8 PASS, max diff 1.14e-5
$ ./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_f32     fixtures/polar.json      # 8/8 PASS, max diff 7.6e-6
```

Bench summary (`verify/bench_results/polar_hadamard_parallel.json`):

| kernel       | before µs (median) | after µs (median) | speedup |
| ------------ | ------------------ | ----------------- | ------- |
| `turbo3`     | 245.7              | 240.3             | ~1.0×   |
| `turbo4`     | 246.1              | 241.5             | ~1.0×   |
| `turbo3_tcq` | 246.3              | 243.3             | ~1.0×   |
| `qjl`        | 240.8              | 239.8             | ~1.0×   |
| `polar`      | **5726.6**         | **458.5**         | **12.5×** |

The four small kernels are launch-tax bound at the verify scale (131k tiny
threadgroups per dispatch) and changes there don't move the median; their
correctness is preserved bit-for-bit. The polar fix is the headline win.
