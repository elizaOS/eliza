# Metal Kernel Optimization Review - 2026-05-11

Scope: `packages/inference/AGENTS.md`, `packages/inference/metal/*.metal`,
`packages/inference/verify/metal_bench.mm`, and
`packages/inference/verify/bench_results/*`. No shared source files were edited.
Short ablations were run against the existing `metal_bench` and `metal_verify`
binaries with benchmark JSON output directed to `/dev/null`.

## Executive Findings

1. The biggest actionable Metal win is to route the existing multi-block
   TurboQuant/QJL entrypoints in production for long-context decode. Existing
   M4 Max results show the single-block score kernels around 335-345 us in
   `m4max_2026-05-11-current.json`, while the multi-block variants are 48-81 us
   in `m4max_multiblock_2026-05-11-current.json`, a 3.6x-4.8x win. My short
   ablation reproduced the same shape: 4.6x-6.2x best-case speedups.

2. Fused attention needs algorithmic work before it should be considered the
   performance path. Both Metal fused kernels currently score K twice and apply
   the V-side inverse transform per token. Because TBQ and Polar V unconditioning
   are linear, the shader can accumulate weighted pre-unconditioned V values and
   run the Hadamard/sign transform once at the end. This removes O(n_kv) barriers
   and Hadamard work from the V path.

3. PolarQuant raw `kernel_mul_mv_q4_polar_f32` should not be the attention hot
   path when the caller can provide `H*q`. The pre-Hadamard query path is already
   present and hardware-correct on this M4 Max. Current bench data shows raw
   Polar at 656.6 us and `polar_preht` at 365.0 us; the older pre-optimization
   raw Polar was 5726.6 us before cooperative Hadamard, so avoiding per-row
   Hadamard remains the dominant Polar rule.

4. `kv_tile` in the fused-attention ABI is currently a no-op in both Metal fused
   kernels. The comments describe voice barge-in tile granularity, but the loops
   walk `0..args.n_kv` regardless of `args.kv_tile`. Do not rely on `kv_tile`
   for cancellation or chunking until the shader has real partial-state tiling.

5. The fused Metal kernels and the standalone `polar_preht` Metal kernel are no
   longer only source-reviewed on this machine: the fixture verifier passes on
   Apple M4 Max. The comments still say "hardware-verify pending", so the docs
   and capability notes should be updated after the team decides where to record
   this evidence.

## Existing Benchmark Evidence

Key existing M4 Max results:

| Source | Kernel | Median GPU us | Note |
| --- | ---: | ---: | --- |
| `m4max_2026-05-11-current.json` | turbo3 | 342.2 | single-block compatibility symbol |
| `m4max_2026-05-11-current.json` | turbo4 | 339.7 | single-block compatibility symbol |
| `m4max_2026-05-11-current.json` | turbo3_tcq | 345.0 | single-block compatibility symbol |
| `m4max_2026-05-11-current.json` | qjl | 335.8 | single-block compatibility symbol |
| `m4max_2026-05-11-current.json` | polar | 656.6 | raw-q Polar path |
| `m4max_2026-05-11-current.json` | polar_preht | 365.0 | pre-Hadamard query path |
| `m4max_multiblock_2026-05-11-current.json` | turbo3 | 48.2 | best N=32 |
| `m4max_multiblock_2026-05-11-current.json` | turbo4 | 58.1 | best N=16 |
| `m4max_multiblock_2026-05-11-current.json` | turbo3_tcq | 62.6 | best N=32 |
| `m4max_multiblock_2026-05-11-current.json` | qjl | 81.1 | best N=32 |
| `m4max_fp16ref_2026-05-11-current.json` | fp16ref | 269.3 | unquantized fp16 dot baseline |

Interpretation: the single-block quantized score kernels are not winning on
latency despite touching far fewer bytes, because they are dominated by Metal
threadgroup scheduling and launch overhead. Multi-block variants are where the
quantized formats become latency-positive.

Older Polar evidence:

| Source | Polar Median GPU us | Meaning |
| --- | ---: | --- |
| `baseline_pre_opt.json` | 5726.6 | sequential/tid-0 Hadamard dominated |
| `polar_hadamard_parallel.json` | 458.5 | cooperative 32-lane Hadamard |
| `m4max_2026-05-11-current.json` | 656.6 | current raw Polar run, noisier |
| `m4max_2026-05-11-current.json` | 365.0 | current `polar_preht` |

## Short Ablations Run

Commands were run from `packages/inference/verify`:

```sh
./metal_bench --mode default --iters 20 --warmup 3 --runs 1 --out /dev/null
./metal_bench --mode multiblock --iters 8 --warmup 1 --out /dev/null
./metal_bench --mode tgsweep --iters 8 --warmup 1 --out /dev/null
./metal_bench --mode batched --iters 3 --warmup 1 --out /dev/null
```

Short default run:

| Kernel | Median GPU us |
| --- | ---: |
| turbo3 | 247.3 |
| turbo4 | 238.4 |
| turbo3_tcq | 232.4 |
| qjl | 228.8 |
| polar | 348.1 |
| polar_preht | 227.2 |

Short multi-block run:

| Kernel | Single GPU us | Best GPU us | Best N | Speedup |
| --- | ---: | ---: | ---: | ---: |
| turbo3 | 223.5 | 37.7 | 16 | 5.93x |
| turbo4 | 214.1 | 34.6 | 8 | 6.18x |
| turbo3_tcq | 240.1 | 52.5 | 32 | 4.57x |
| qjl | 238.4 | 43.9 | 16 | 5.44x |

Short tgsweep run:

| Kernel | Best observed TG | Caveat |
| --- | ---: | --- |
| qjl | 64 in this tiny run | TG > 32 under-reduces because `simd_sum` covers one SIMD-group, so timings are not correctness-valid. |
| polar | 32 | Larger TG sizes were slower and also not correctness-valid for the reduction assumption. |

Short batching run was noisy and not a preferred direction. It also increases
barge-in cancellation latency with N because work cannot be interrupted inside a
command buffer. Multi-block-per-threadgroup is a better optimization axis for
voice responsiveness because it lowers the single dispatch time instead of
packing more dispatches into one buffer.

Correctness checks run:

```sh
./metal_verify ../metal/fused_attn_qjl_tbq.metal kernel_fused_attn_qjl_tbq3_f32 fixtures/fused_attn_qjl_tbq.json
./metal_verify ../metal/fused_attn_qjl_polar.metal kernel_fused_attn_qjl_polar_f32 fixtures/fused_attn_qjl_polar.json
./metal_verify ../metal/polar_preht.metal kernel_attn_score_q4_polar_preht_f32 fixtures/polar_preht.json
for n in 2 3 4 8; do ./metal_verify ../metal/polar_preht.metal kernel_attn_score_q4_polar_preht_f32_multi fixtures/polar_preht.json --multi "$n"; done
for n in 2 3 4 8; do
  ./metal_verify ../metal/turbo3.metal kernel_turbo3_dot_multi fixtures/turbo3.json --multi "$n"
  ./metal_verify ../metal/turbo4.metal kernel_turbo4_dot_multi fixtures/turbo4.json --multi "$n"
  ./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot_multi fixtures/turbo3_tcq.json --multi "$n"
  ./metal_verify ../metal/qjl.metal kernel_attn_score_qjl1_256_multi fixtures/qjl.json --multi "$n"
done
```

Results: fused TBQ and fused Polar each passed 1920/1920 outputs across four
cases at tol 1e-3. `polar_preht` passed use_qjl=0 and use_qjl=1. Multi-block
TurboQuant/QJL entrypoints passed for N in {2,3,4,8}.

## Patch Recommendations

### TurboQuant

1. Route long-context Metal dispatch to the existing `_multi` symbols:
   `kernel_turbo3_dot_multi`, `kernel_turbo4_dot_multi`, and
   `kernel_turbo3_tcq_dot_multi`. Keep the single-block symbols as compatibility
   and small-N fallbacks.

2. Tune `blocks_per_threadgroup` per kernel and mode. Based on existing and short
   runs, start with:

| Kernel | Voice/decode conservative N | Prefill/throughput N |
| --- | ---: | ---: |
| turbo3 | 8 or 16 | 16 or 32 |
| turbo4 | 8 | 16 |
| turbo3_tcq | 8 or 16 | 32 |

3. Hoist invariant query vector loads out of the multi-block loop. In
   `turbo3.metal`, `turbo4.metal`, and `turbo3_tcq.metal`, each `_multi` kernel
   reloads `qv` inside the `for (b < blocks_per_threadgroup)` loop even though
   `q_base` is invariant. `qjl.metal` already hoists its `q0/q1` loads in the
   multi kernel; mirror that pattern for TurboQuant.

4. For `turbo3_tcq`, leave the 512-entry codebook as a buffer for ABI stability,
   but consider a function-constant or inlined-constant variant only if counters
   show constant-buffer pressure. The measured bottleneck is scheduling, not
   bandwidth, so this is lower priority than routing `_multi`.

### QJL

1. Route `kernel_attn_score_qjl1_256_multi` in production for long-context
   scoring. Existing current result: 335.8 us single-block versus 81.1 us at
   N=32.

2. Keep threadgroup size fixed at 32 for correctness. The tgsweep mode can time
   TG > 32, but `simd_sum` only reduces one SIMD-group, so those timings are not
   valid output shapes unless the kernel is rewritten with threadgroup reductions.

3. In fused attention, hoist the invariant `q_sketch` vector loads out of
   `qjl_score_one_token`. Both fused kernels reload two `float4`s for every
   token and for both passes. Load `q0/q1` once per lane per `(q_pos, h_q)` and
   pass them into a helper that only consumes `blk->qs[tid]` and `norm_bf16`.

### PolarQuant

1. Prefer pre-Hadamard query dispatch for attention scoring:
   `kernel_mul_mv_q4_polar_preht_f32` or the attention-ABI symbols in
   `polar_preht.metal`. Raw `kernel_mul_mv_q4_polar_f32` should stay as a
   fallback/debug path because it pays the 7-stage Hadamard per row.

2. Add `kernel_attn_score_q4_polar_preht_f32_multi` to `metal_bench`'s
   multiblock sweep and route it in production after measuring. The symbol
   exists and passed correctness for N={2,3,4,8}, but the current Metal bench
   only times the non-multi matvec-ABI `polar_preht` path in default mode.

3. Hoist residual scaling out of the inner loops in `polar_preht.metal` and
   `kernel_mul_mv_q4_polar_preht_f32`. `use_qjl` is uniform for the dispatch, and
   `scaled = sign * 0.5 / sqrt(128)` is invariant per block.

4. If raw Polar remains on any hot path, unroll the Hadamard stages or replace
   division/modulo in `polar_hadamard_inplace_tg32` with power-of-two bit math.
   The current code is clear, but the butterfly runs in raw Polar and fused
   Polar V decode; removing dynamic division is a cheap targeted ablation.

### Fused Attention

1. Convert the two-pass score/V-mix to true online softmax. Current kernels:
   pass 1 computes `(m,l)`, pass 2 recomputes every QJL score and then mixes V.
   Use the existing `corr` parameter in the decode helpers:

```c
new_m = max(m, raw);
old = l * exp(m - new_m);
add = exp(raw - new_m);
new_l = old + add;
corr = old / new_l;
w = add / new_l;
acc = acc * corr + w * V;
m = new_m;
l = new_l;
```

This saves one full QJL score pass and one `exp` per token.

2. Delay linear V unconditioning until after the weighted sum:

   - TBQ: accumulate `w * d * codebook[code]` in the pre-Hadamard 32-point
     domain for each of the four chunks, then apply Hadamard-32 and the fixed
     sign vector once at the end.
   - Polar: accumulate `w * l2 * centroid_or_residual_value` in the pre-Hadamard
     128-point domain, then apply Hadamard-128 once at the end and multiply by
     `1/128`.

   This is algebraically equivalent because Hadamard and sign flips are linear.
   It removes per-token Hadamard barriers from the fused V path.

3. Remove the redundant pre-helper barriers in the fused pass-2 loops after
   proving the delayed-transform patch or the current helper sequencing. The
   helpers already place barriers after threadgroup writes and at the end; the
   barrier immediately before each helper call appears redundant.

4. Use parallel Metal stores for the final `out_attn` write. The current Metal
   code copies the Vulkan workaround where lane 0 writes all 128 elements
   serially. On native Apple Metal, write `out_attn[out_base + i]` with
   `for (i = tid; i < HEAD_DIM; i += 32)` after the final threadgroup barrier.

5. Implement or deprecate `kv_tile`. It is declared in the ABI but ignored by
   both fused Metal kernels. A correct tiled fused attention path needs partial
   `(m, l, acc)` state per tile, or a separate combine pass. Until that exists,
   dispatchers should not treat `kv_tile` as a cancellation or latency bound.

6. Add a native Metal fused-attention benchmark mode. `metal_bench.mm` currently
   has no fused-attention timing path, so the fused kernels are correctness
   verified but not performance-characterized. Benchmark at least n_kv
   {512, 4096, 32768} and n_heads {1, 8}, matching the existing fused fixtures
   and Vulkan-style result shape.

## Priority Order

1. Production route existing `_multi` TurboQuant/QJL score kernels and benchmark
   tuned N values on M4 Max.
2. Route Polar attention scoring through `polar_preht` and add `polar_preht_multi`
   to the Metal multiblock bench.
3. Patch fused attention to single-pass online softmax plus delayed V
   unconditioning.
4. Add native Metal fused-attention perf coverage.
5. Apply micro-optimizations: hoist Turbo `_multi` q loads, hoist Polar residual
   scale, remove redundant fused barriers, parallelize fused output stores, and
   unroll Hadamard stage index math.
