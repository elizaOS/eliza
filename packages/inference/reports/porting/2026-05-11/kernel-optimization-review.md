# Eliza-1 Kernel Optimization Review - 2026-05-11

Scope: TurboQuant (`turbo3`, `turbo4`, `turbo3_tcq`), QJL, PolarQuant,
their Metal/Vulkan shader ports, CPU NEON/AVX2 plugin paths, and the
current verification/benchmark evidence in `packages/inference/verify`.

This report is a review artifact. It does not claim new Android, Windows,
Linux CUDA, ROCm, or H200 evidence. Current measured performance is Apple
M4 Max Metal plus CPU reference/SIMD source review, with Vulkan correctness
evidence from MoltenVK and prior Intel/lavapipe turbo runs.

## Evidence Read

- Metal standalone kernels:
  - `packages/inference/metal/turbo3.metal`
  - `packages/inference/metal/turbo4.metal`
  - `packages/inference/metal/turbo3_tcq.metal`
  - `packages/inference/metal/qjl.metal`
  - `packages/inference/metal/polar.metal`
- Vulkan standalone kernels:
  - `packages/inference/vulkan/turbo3.comp`
  - `packages/inference/vulkan/turbo4.comp`
  - `packages/inference/vulkan/turbo3_tcq.comp`
  - `packages/inference/vulkan/qjl.comp`
  - `packages/inference/vulkan/qjl_get_rows.comp`
  - `packages/inference/vulkan/qjl_mul_mv.comp`
  - `packages/inference/vulkan/polar.comp`
  - `packages/inference/vulkan/polar_get_rows.comp`
- CPU plugin paths:
  - `packages/native-plugins/qjl-cpu/src/qjl_score_{neon,avx2}.c`
  - `packages/native-plugins/qjl-cpu/src/qjl_quantize_{neon,avx2}.c`
  - `packages/native-plugins/polarquant-cpu/src/polar_dot_{neon,avx2}.c`
  - `packages/native-plugins/polarquant-cpu/src/polar_dequantize_{neon,avx2}.c`
- Evidence files:
  - `packages/inference/reports/porting/2026-05-10/platform-verification-performance-grid.md`
  - `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`
  - `packages/inference/verify/bench_results/m4max_2026-05-10.json`
  - `packages/inference/verify/bench_results/m4max_multiblock_2026-05-10.json`
  - `packages/inference/verify/bench_results/m4max_batched_2026-05-10.json`
  - `packages/inference/verify/kernel-contract.json`

## Findings

### P0 - Fuse attention, not just standalone score kernels

The current hot kernels compute one scalar score and write it out:

- QJL writes `scores[h_q * args.n_tokens + t]` after reconstructing the
  projected sign dot.
- Turbo3/Turbo4/TCQ write `scores[args.q_head * args.n_kv + kv_idx]`.
- Polar writes `y[row]` after dequantize/Hadamard/dot.

That shape is correct and verified, but it is still an intermediate-score
kernel. For the real long-context path, the next large win is a fused attention
kernel:

```text
QJL/Turbo/Polar K-score -> online softmax -> Turbo/Polar/V-cache mix -> output
```

This removes score matrix writes, score reads, a second V-cache decode, and at
least one dispatch boundary. It also gives the scheduler one cancellation
boundary per attention tile instead of per helper kernel.

Recommendation:

- Add backend kernels for `GGML_OP_FUSED_ATTN_QJL_TBQ` or an equivalent
  Eliza-1 graph op on Metal, Vulkan, CUDA/HIP, and CPU.
- Use online softmax per head/page so the kernel never materializes the full
  score vector.
- Treat standalone dot kernels as verification and fallback paths.

Acceptance:

- Output parity against the existing dot + softmax + V reference within the
  same tolerance used by the current fixtures.
- Lower total graph time than the current multi-kernel path at 4k, 32k, 64k,
  128k, and 256k contexts.
- Voice mode remains cancellable at one small kernel/tile boundary.

### P0 - Runtime policy must use Metal multi-block kernels for non-voice bulk work

The Metal source already has multi-block variants:

- `kernel_turbo3_dot_multi`
- `kernel_turbo4_dot_multi`
- `kernel_turbo3_tcq_dot_multi`
- `kernel_attn_score_qjl1_256_multi`

The M4 Max multiblock bench shows these are the biggest measured shader-level
win still available to runtime routing:

| Kernel | Best N | Best median | Speedup |
| --- | ---: | ---: | ---: |
| Turbo3 | 8 | 51.56 us | 4.80x |
| Turbo4 | 32 | 68.63 us | 4.13x |
| Turbo3-TCQ | 4 | 106.00 us | 2.09x |
| QJL | 8 | 55.33 us | 4.26x |

Recommendation:

- Route non-voice, long-context scoring through the verified multi-block entry
  points.
- Use a backend/device heuristic table, initially:
  - M4 Max non-voice: `turbo3=8`, `turbo4=32`, `turbo3_tcq=4`, `qjl=8`.
  - Voice: force `N=1` unless an end-to-end barge-in benchmark proves otherwise.
- Persist the chosen N in benchmark evidence so release artifacts can be
  reproduced.

Do not use command-buffer batching for voice. The batched bench shows N=4
already pushes worst-case cancellation around 0.8-1.4 ms for the small kernels
and higher for Polar. That violates the voice loop's low-latency cancellation
goal even when throughput improves.

### P1 - PolarQuant still pays avoidable decode-to-scratch cost

Metal and Vulkan Polar both materialize a full 128-float decoded block into
threadgroup scratch, run a 7-stage Hadamard, then dot against `q`. CPU NEON and
AVX2 do the same at a row level: `polar_dot_*` calls `dequantize_row_*` into a
128-float buffer, then dots.

The better hot-path formulation is:

```text
dot(H * x, q) == dot(x, H * q)
```

where `H` is the Hadamard transform and `x` is the centroid/residual vector.
For attention scoring, the query vector is reused across many K rows. So the
runtime can pre-Hadamard the query once per query head/chunk, then each Polar
block can:

1. Unpack centroids and optional residual.
2. Dot directly against `Hq`.
3. Apply `norm / 128`.

That removes the per-K-row 7-stage Hadamard and most scratch traffic in the hot
score path. Keep `kernel_get_rows_q4_polar` as the exact decode fallback.

Recommendation:

- Add `kernel_attn_score_q4_polar_preht_f32` for Metal and Vulkan.
- Add CPU `ggml_vec_dot_q4_polar_q8_0_{neon,avx2,avx512}_preht` variants.
- Store a manifest/runtime bit stating whether `q` has been pre-Hadamarded.
  Hard-fail if the wrong variant is selected.
- Benchmark both `use_qjl=0` and `use_qjl=1`.

Expected impact:

- Polar is the slowest current Metal kernel (`651.88 us` median in the latest
  default bench, versus about `300 us` for QJL/Turbo). Removing the per-row
  Hadamard should be the largest remaining Polar-specific win.

### P1 - Vulkan lacks multi-block variants and device-specialized routing

Metal has `_multi` entry points for the launch-tax-bound kernels. Vulkan
standalone shaders are still one workgroup per output. The Vulkan shaders use
portable shared-memory reductions, which is correct across Intel, lavapipe,
Adreno, Mali, AMD, and NVIDIA, but it leaves throughput on the table for long
contexts.

Recommendation:

- Add Vulkan multi-block variants for Turbo3, Turbo4, Turbo3-TCQ, and QJL.
- Prefer specialization constants for `blocks_per_workgroup` /
  `tokens_per_workgroup` so the same SPIR-V family can tune by vendor/device.
- Keep local size 32 as the portable baseline. Do not rely on subgroup size.
- Add device-policy defaults after physical runs:
  - Adreno: sweep N in `{2,4,8,16}` and local size `{32,64}` with correctness.
  - Mali: sweep N in `{2,4,8}` and keep barrier pressure low.
  - Desktop AMD/NVIDIA/Intel: sweep N in `{4,8,16,32}`.

Acceptance:

- `vulkan_verify` fixture parity for each N.
- Native Linux `vulkan-dispatch-smoke`, not MoltenVK only.
- Android physical-device evidence for at least one Adreno and one Mali.

### P1 - QJL should gain an integer-dot path

Current QJL hot paths expand sign bits to `+/-1` fp32 and FMA against fp32
`q_sketch`. The Metal path vectorizes `q_sketch` as two `float4` loads per lane,
and the CPU AVX2/NEON paths are already SIMD, but the math is still fp32.

For the hot score path, `q_sketch` can be quantized per query/head to int8 or
fp16 with one scale. Then QJL's sign bits become an ideal integer dot:

```text
sum_j sign_j * q_j
```

CPU targets can use:

- ARMv8.4 dot-product / i8mm (`vdot`/matrix extensions) for int8 sketches.
- AVX512/VNNI on x86_64, while preserving AVX2 fallback.
- AVX2 byte/nibble LUTs as a fallback when VNNI is unavailable.

GPU targets can use:

- half sketch storage on Metal/Vulkan to cut q-sketch bandwidth.
- int8 sketch plus packed signs on CUDA/Hopper where tensor-core or DP4A
  patterns can be used profitably.

Recommendation:

- Add a second fixture family for quantized QJL sketch. Keep fp32 fixtures for
  exact reference parity.
- Require end-to-end perplexity/attention-score tolerance before enabling by
  default.
- Keep the current fp32 path as the verification baseline.

### P1 - CUDA/H200 should start from fused attention, not standalone parity only

The current macOS tree cannot run CUDA, but the target H100/H200 path should not
mirror only the standalone dot kernels. CUDA is where a fused score/softmax/V
kernel should pay the most because HBM traffic and dispatch count dominate
long-context throughput.

Recommendation for NVIDIA:

- Place TCQ codebook in `__constant__` memory or read-only cache.
- Use warp-level reductions for 32-lane block dots; block-level reductions only
  where multiple warps share one output tile.
- Tile K/V pages so Q is loaded once per head/tile.
- Use online softmax and V accumulation in one kernel.
- Use `cp.async`/TMA-style staging on Hopper only after correctness and simpler
  tiled kernels pass.
- Benchmark 4k, 32k, 128k, and 256k contexts on H100/H200 before promoting any
  default.

### P2 - Turbo3/Turbo4 micro-optimizations are secondary

Turbo3, Turbo4, TCQ, and QJL cluster near the same Metal latency because they
are launch-bound at the current dispatch shape. Micro-tuning their inner loops
will not beat multi-block dispatch or fused attention.

Still-worthwhile small changes:

- Load each thread's four contiguous `q` values as `float4` in Turbo3/Turbo4/TCQ
  and reduce locally. This may reduce scalar load instructions, but it is a
  small gain under current launch-bound conditions.
- For Turbo4, precompute the four local centroid values into a `float4` before
  the dot.
- For Vulkan, consider aligned GPU staging layouts for packed blocks. The
  current raw-byte reads preserve packed cache storage, but native drivers may
  benefit from 4-byte-aligned GPU-only staging for QJL/Polar if the memory
  budget allows it.

Do not prioritize these ahead of fused attention, runtime multi-block routing,
or Polar pre-Hadamard dot.

### P2 - TCQ codebook inlining is low confidence

TCQ now preloads the overlapping bit window once per lane, which removed the
obvious redundant byte loads. The remaining codebook lookup is a 512-float
table:

- Metal binds it as `constant float *`.
- Vulkan binds it as a read-only storage buffer.
- CUDA should prefer `__constant__` or read-only cache.

Inlining the codebook as shader literals could help Metal, but it adds a codegen
step and increases shader size. Treat it as an experiment only if TCQ becomes
hot in real graph traces.

### P2 - CPU paths need thread-level parallelism and newer SIMD tiers

The CPU plugins have NEON and AVX2 implementations, but the reviewed loops are
single-threaded over heads/tokens/rows. They also do not yet expose AVX512/VNNI
or ARM int8 dot-product paths for QJL.

Recommendation:

- Parallelize across heads/tokens/rows through the same runtime thread pool used
  by ggml, not plugin-local ad hoc threads.
- Add AVX512/VNNI for QJL int8 sketch and Polar dot.
- Add ARM dot-product/i8mm where available.
- Keep scalar, NEON, AVX2, and AVX512 paths under one dispatch table with a
  runtime-visible `active_simd` string for evidence.

CPU offload is still important for large context spill, but it must be gated by
measured latency. Do not silently spill to a CPU path that misses voice latency
targets.

## Voice On vs Voice Off

Voice-off should not mmap or warm TTS/ASR weights and should not route through
voice-oriented command-buffer batching. It should use:

- Text model + DFlash drafter only.
- KV kernels required by the selected Eliza-1 tier.
- Multi-block scoring for non-interactive/bulk work.
- Single/tile-sized dispatch when user-visible latency dominates.

Voice-on should optimize first-audio and barge-in:

- Keep GPU command buffers short enough to cancel quickly.
- Use DFlash rollback to cancel pending TTS phrase chunks before audio enqueue.
- Use voice preset and phrase cache before model decode where possible.
- Avoid multi-dispatch command-buffer batching even if it improves throughput.
- Use fused attention tiles once available, but tile for cancellation, not just
  maximum throughput.

Shared policy:

- One scheduler, one mmap budget, one telemetry stream.
- Separate KV caches unless the text and voice networks truly share identical
  layers.
- Hard-fail when a required Eliza-1 kernel or voice asset is missing in a mode
  that requires it.

## Platform Plan

| Platform | Optimization plan | Required evidence |
| --- | --- | --- |
| Apple Silicon Mac | Route verified Metal multi-block kernels for non-voice. Add fused attention and Polar pre-Hadamard dot. Keep voice command buffers short. | `metal-verify`, `metal-verify-multiblock`, `dispatch-smoke`, fused voice/text latency/RSS/thermal gates. |
| iPhone/iPad | Same Metal kernels, but device-specific N table must be learned on real iOS hardware. Favor smaller tiles for thermals and barge-in. | XCTest/Capacitor bundle smoke with first token, first audio, peak RSS, thermal state. |
| Android Adreno | Add Vulkan multi-block variants and sweep N/local size. Avoid subgroup assumptions. Keep shared-memory reduction until vendor evidence says otherwise. | Physical Adreno standalone + app graph-dispatch evidence. |
| Android Mali | Same as Adreno, with extra focus on barrier pressure and register pressure. Mali may prefer smaller N than desktop GPUs. | Physical Mali standalone + app graph-dispatch evidence. |
| Linux/Windows Vulkan | Add Vulkan multi-block and native graph smoke. Tune Intel/AMD/NVIDIA separately with specialization constants. | Native hardware `vulkan-dispatch-smoke`, not MoltenVK or software ICD. |
| Linux CUDA/H100/H200 | Implement fused attention first. Then tune TCQ codebook placement, warp reductions, page tiling, and Hopper staging. | CUDA fixture parity, graph smoke, long-context throughput on H100/H200. |
| ROCm | Port fused attention through HIP with wave-size-safe reductions. Do not assume wave32. | MI250/MI300/RDNA hardware parity and graph smoke. |
| CPU ARM64 | Add thread-level parallelism, QJL int8 sketch with dot-product/i8mm, and Polar pre-Hadamard dot. | NEON/dot-product parity and per-device latency gates. |
| CPU x86_64 | Add AVX512/VNNI, keep AVX2 fallback, parallelize by row/head. | Native Linux/Windows CPU parity and throughput gates. |

## Priority Backlog

1. Port fused attention score/softmax/V mix to Metal and CUDA.
2. Wire Metal multi-block runtime policy for non-voice paths.
3. Add Polar pre-Hadamard-query score kernels for Metal, Vulkan, CPU.
4. Add Vulkan multi-block variants and specialization-constant routing.
5. Add QJL quantized-sketch/int-dot experiment with exact fp32 fallback.
6. Add AVX512/VNNI and ARM dot-product dispatch tiers.
7. Run native device sweeps:
   - iPhone/iPad Metal.
   - Android Adreno Vulkan.
   - Android Mali Vulkan.
   - Linux Intel/AMD/NVIDIA Vulkan.
   - Windows CUDA/Vulkan/CPU.
   - Linux H100/H200 CUDA.
8. Update `kernel-contract.json` only after each backend has runtime-ready
   graph evidence, not after symbol presence or standalone fixture parity.

## Review Conclusion

The standalone shader math is in good shape. The remaining performance work is
mostly not more centroid micro-tuning. The highest leverage changes are:

1. Fuse the attention pipeline so QJL/Turbo/Polar do not materialize scores.
2. Route already-verified Metal multi-block kernels where latency policy allows.
3. Remove Polar's per-K-row Hadamard by pre-transforming Q or fusing the
   Hadamard-dot algebra.
4. Add integer-dot QJL paths for CPU and server GPUs.
5. Close device-specific routing with physical evidence on Adreno, Mali,
   Windows, Linux Vulkan, and CUDA/H200.

