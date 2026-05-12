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
  - `packages/inference/vulkan/polar_preht.comp`
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

## MacBook M4 Max Local Sweep - 2026-05-11

Hardware tested locally:

- MacBook Pro `Mac16,5`
- Apple M4 Max, 40-core GPU
- 16-core CPU, 128 GB unified memory
- Darwin 25.2.0, Metal runtime JIT through `MTLDevice.newLibraryWithSource`
- MoltenVK present and used for Vulkan API smoke. This is useful parity
  evidence, but it is not a substitute for native Linux/Android Vulkan drivers.

Correctness run:

| Target | Result |
| --- | --- |
| `node packages/inference/verify/check_kernel_contract.mjs` | PASS, 6 kernels, 21 targets |
| `./gen_fixture --self-test` | PASS, finite deterministic references |
| Metal standalone | Turbo3/Turbo4/TCQ/QJL/Polar/Polar+QJL/Polar-preHT/Polar-preHT+QJL all 8/8 PASS |
| Metal multiblock | Turbo3/Turbo4/TCQ/QJL all PASS for N in `{2,3,4,8}` |
| Metal fused | `fused_attn_qjl_tbq` and `fused_attn_qjl_polar` PASS, 1920/1920 outputs |
| Metal graph dispatch | `dispatch_smoke` PASS for QJL, Turbo3, Turbo4, TCQ, Polar raw no-residual/residual, and Polar preHT no-residual/residual |
| Vulkan via MoltenVK | Standalone, multiblock, fused, and Polar-preHT SPIR-V checks PASS |
| QJL CPU plugin | NEON/dotprod build runs; int8 smoke passes with `max_abs=0.001207` |
| Polar CPU plugin | NEON build runs; raw, preHT, SIMD parity tests pass |

Performance highlights from current Mac runs. Metal timings are noisy on an
interactive desktop, so use the ranges and the repeated ordering rather than a
single run as truth:

| Path | Best current evidence |
| --- | ---: |
| Metal Turbo3 multiblock | best saved runs `42-98 us`, repeatedly 4-9x vs single-block |
| Metal Turbo4 multiblock | best saved runs `55-93 us`, repeatedly 3-4x vs single-block |
| Metal Turbo3-TCQ multiblock | best saved runs `62-78 us`, repeatedly 3-4x vs single-block |
| Metal QJL multiblock | best saved runs `81-103 us`; N=16/32 are more stable for p99 than the occasional lower-median N=4 |
| Metal Polar raw | `593-657 us` median across current runs |
| Metal Polar preHT | `312-365 us` median, about 1.8-2.1x faster |
| Metal default rerun 2026-05-12 | raw Polar `681 us`, Polar preHT `339 us`, same 2.0x result |
| Metal multiblock autotune 2026-05-12 | Turbo3 best `92 us @ N=8`, Turbo4 `84 us @ N=8/32`, TCQ `79 us @ N=16`, QJL `70 us @ N=32` |
| CPU scalar verify bench | Turbo3 `30.34 ms`, Turbo4 `24.80 ms`, TCQ `23.69 ms`, QJL `23.33 ms`, Polar `36.29 ms` |
| CPU SIMD plugin on M4 Max | QJL i8 NEON-dotprod `13.0 ns/out`, QJL fp32 NEON `39.7 ns/out`, Polar preHT NEON `45.2 ns/out` |
| QJL CPU NEON/dotprod plugin | score `65.3 ns/(qh,tok)` in the direct CMake build; int8 reference is not default-on |
| Polar CPU NEON plugin | raw dot `80.93 ns/row`; preHT dot `34.42 ns/row`, about 2.35x faster |

Command-buffer batching remains a bad voice-mode fit. It can improve bulk
throughput for non-interactive runs, but current batched sweeps push worst-case
command-buffer completion into multi-millisecond territory at small batch sizes
and much higher at large batch sizes. Voice mode should use short graph tiles,
not long command-buffer batches.

## Per-Kernel Optimization Matrices

These are practical optimization candidates reviewed in this pass. The
important point is not "do everything"; several options trade accuracy,
latency, memory, portability, or engineering complexity.

### Turbo3

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Runtime-select `_multi` N per device | 4-9x measured on M4 Max | Needs per-device evidence; wrong N can hurt tail latency |
| Multi-head grid dispatch instead of per-head encoder loop | Medium | Larger ABI and graph smoke surface |
| Fuse score + softmax + V mix | Large at long context | More complex numerics and cancellation tiling |
| Keep `float4` Q loads and dot vectorization | Already landed | Requires aligned contiguous Q, already asserted |
| Device/policy split for voice vs non-voice | Preserves barge-in | More scheduler state |
| Packed block GPU-only staging with 4-byte alignment | Small-medium | More memory; cache artifact no longer minimally packed |
| Half centroid literals with fp32 accumulate | Small | Numeric drift; must pass model evals, not only fixtures |
| Function-constant blocks-per-threadgroup | Small-medium | More pipeline variants or compile-time specialization |
| Command-buffer batching for offline prefill/eval only | Throughput on noninteractive jobs | Bad voice cancellation latency |
| Per-tier benchmark gate for chosen N | Prevents regressions | More release evidence to maintain |

### Turbo4

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Runtime-select `_multi` N per device | 3-4x measured on M4 Max | N=16/N=32 alternate across runs; tune per device |
| Multi-head grid dispatch | Medium | Requires q/pk/dst offset audit for all batched shapes |
| Fuse score + softmax + V mix | Large at long context | Larger fused kernel, harder occupancy tuning |
| Keep current 4x32-block row layout | Avoids stale Turbo4 residual path | Less compact than a hypothetical 128-wide record |
| `float4` Q/decode dot path | Already landed | No extra loss |
| Align block_turbo4_0 staging for GPU-only buffers | Small-medium | Extra transcode/copy path |
| Half centroid/norm math experiment | Small | Accuracy risk |
| Non-voice command-buffer batching | Some throughput | Not acceptable for voice mode |
| Metal/Vulkan/CUDA per-backend N tables | Medium | Evidence burden across platforms |
| Fused graph route with QJL/Polar alternatives | Large | Backend-specific graph op contract |

### Turbo3-TCQ

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Runtime-select `_multi` N per device | 2-3x measured | N=4/8/16/32 trade median vs p99 |
| Keep decode-only on device | Avoids huge Viterbi shader | Encode stays CPU/training-side |
| TCQ codebook in constant/read-only cache | Small-medium | Backend-specific storage rules |
| Inline codebook literals | Unknown | Bigger shaders, longer compile, low confidence |
| Fuse score + softmax + V mix | Large at long context | More difficult than standalone fixtures |
| Sliding 9-bit window load hoist | Already reviewed/landed | Little remaining headroom |
| Multi-head grid dispatch | Medium | Requires graph route rewrite |
| Quantization-side trellis pruning | Model/storage win | Changes artifacts; needs retraining/eval |
| Command-buffer batching offline only | Throughput | Voice latency loss |
| CUDA/Hopper warp-specialized implementation | Large on H100/H200 | Needs real hardware and CUDA parity |

### QJL

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Keep Metal `_multi` route on runtime graph | 3-4x measured vs single | N varies; current N=32 is p99-biased |
| Add persistent per-device N autotune | Medium | Needs cache, invalidation, and release evidence |
| Fuse QJL score + softmax + V mix | Large | More numerics and graph-contract surface |
| Reorder CPU loops by KV head to reuse packed K across GQA fanout | 1.5-3x possible | More accumulators and output writes |
| QJL int8 sketch with NEON dotprod / AVX512 VNNI | Large if optimized | Current scalar/int8 experiment is not faster everywhere |
| Half q-sketch loads on Metal/Vulkan | Small-medium | Accuracy/eval risk |
| Align block_qjl1_256 to 36/40 B for GPU staging | Small-medium | Worse cache density and ABI churn |
| Specialize kernels by head/GQA shape | Small-medium | More pipeline variants |
| Parallelize bulk QJL quantization | Large for cache fill | Thread overhead at small batches |
| Do not default current int8 reference path | Prevents regression | Leaves a possible future win unused |

### PolarQuant

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Route score path to pre-Hadamard Q when graph proves `H*q` | 1.8-2.4x measured | Catastrophically wrong if raw q is passed |
| Add graph smoke proving raw-q cannot hit preHT route | Safety | More test harness code |
| Specialize residual/no-residual kernels | Small | More symbols and dispatch variants |
| Multi-block sweep for `polar_preht` score ABI | Medium | Serial blocks per TG can hurt occupancy |
| Dot while unpacking on CPU, no 128-float scratch | Medium | More complex NEON/AVX code |
| Precompute residual sign-scaled vectors | Small | Extra static data |
| Half centroid/norm loads with fp32 accumulate | Small-medium | Numeric drift risk |
| Thread-parallel CPU rows through ggml pool | Up to core count | Overhead and thermal limits |
| Fuse Polar score + softmax + V mix | Large | Largest implementation complexity |
| GPU-private staging for hot K blocks | Small-medium | Copy overhead and memory pressure |

### Runtime / Model-Level

| Approach | Gain | Cost / loss |
| --- | ---: | --- |
| Native DFlash verifier event stream into voice rollback | First-audio and wasted-TTS win | Token-index accounting must be exact |
| One scheduler for voice-on and voice-off | Less duplicated memory/policy | More centralized complexity |
| Lazy mmap TTS/ASR only in voice-on | Saves GB in voice-off | Voice-on warm start needs explicit prewarm |
| Keep text/voice caches separate unless layers truly match | Correctness | Less apparent "fusion" than a single cache |
| Prompt/tool cache for stable system/tool prefixes | TTFT win | Cache invalidation and safety rules |
| KV spill/offload gates based on measured latency | Enables longer context | CPU spill can miss voice latency |
| Per-tier quantization sidecars drive runtime routing | Prevents wrong kernels | More artifact metadata |
| Fused `.eliza` bundle over one literal GGUF for now | Realistic single download | Not a pure single neural graph |
| Per-device benchmark evidence as publish gate | Prevents paper optimizations | Slower release process |
| Mode-aware route hiding and hard-fail missing required kernels | Production safety | Less fallback tolerance |

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

### P0 - Metal multi-block runtime policy - LANDED with runtime tuning knobs

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

Current state:

- Metal graph-dispatch evidence already records Turbo3, Turbo4, Turbo3-TCQ,
  and QJL routing through the `_multi` entrypoints.
- This pass keeps the conservative defaults but exposes guarded runtime knobs
  so the release harness can run per-device autotune without recompiling the
  fork:
  `ELIZA_METAL_QJL_TOKENS_PER_TG=32`,
  `ELIZA_METAL_TBQ3_BLOCKS_PER_TG=8`,
  `ELIZA_METAL_TBQ4_BLOCKS_PER_TG=32`,
  `ELIZA_METAL_TBQ3_TCQ_BLOCKS_PER_TG=4`; valid range is `1..64`.
- Invalid tuning values log a warning and fall back to the default. A
  dispatch-smoke run with non-default values (`QJL=4`, `TBQ3=4`, `TBQ4=16`,
  `TCQ=8`) passed all eight Metal graph routes.
- The idempotent repair path in
  `packages/app-core/scripts/kernel-patches/metal-kernels.mjs` also updates
  older cached forks when the sentinel is already present.

Remaining recommendation:

- Add a higher-level voice/non-voice scheduler override so voice can force
  `N=1` when barge-in latency dominates. The kernel patcher does not currently
  know whether the graph was launched by voice mode.
- Persist the chosen N in benchmark evidence and bundle metadata so release
  artifacts can be reproduced per device class.

Do not use command-buffer batching for voice. The batched bench shows N=4
already pushes worst-case cancellation around 0.8-1.4 ms for the small kernels
and higher for Polar. That violates the voice loop's low-latency cancellation
goal even when throughput improves.

### P1 - PolarQuant pre-Hadamard hot path - LANDED for Metal graph dispatch

Original finding: Metal and Vulkan Polar both materialized a full 128-float decoded block into
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

Implemented in this pass:

- Added `kernel_mul_mv_q4_polar_preht_f32` in
  `packages/inference/metal/polar.metal`.
- Added `packages/inference/vulkan/polar_preht.comp`.
- Updated `metal_verify` and `vulkan_verify` so the same Polar fixtures can
  verify the pre-Hadamard path by transforming fixture `q` to `H*q` before
  binding it.
- Added `polar_qjl.json` coverage for both normal and pre-Hadamard paths.
- Removed the remaining serial xorshift residual fill from the Vulkan Polar
  matvec/get-rows shaders by using the same literal xorshift32(seed=42) sign
  table as Metal.
- Added CPU reference API `ggml_vec_dot_q4_polar_preht_f32_ref()` plus
  `polar_preht_dot_test`, proving the same `dot(H*x, q) == dot(x, H*q)` path
  matches dequantize-then-dot for both `use_qjl=0` and `use_qjl=1`.
- Added explicit graph constructor `ggml_attn_score_polar_preht(ctx, Hq, K,
  n_kv_heads, use_qjl)` so the raw-q route cannot accidentally select the
  preHT kernel.
- Updated Metal graph dispatch to read a third Polar op-param (`q_preht`) and
  route only the explicit preHT graph to `kernel_attn_score_q4_polar_preht_f32`.
- Extended `dispatch_smoke` so raw-q Polar and preHT Polar both run for
  `use_qjl=0` and `use_qjl=1` against the same scalar reference.

Verification run on 2026-05-11:

- `make -C packages/inference/verify metal-verify`: all eight Metal checks pass,
  including Polar pre-Hadamard with and without QJL residual.
- `make -C packages/inference/verify dispatch-smoke`: all eight Metal graph
  routes pass, including `GGML_OP_ATTN_SCORE_POLAR_PREHT/use_qjl=0` and
  `GGML_OP_ATTN_SCORE_POLAR_PREHT/use_qjl=1`.
- `make -C packages/inference/verify vulkan-verify` on Apple M4 Max via
  MoltenVK: all eight Vulkan checks pass, including `polar_preht.spv` with and
  without QJL residual.
- Direct CPU smoke build:
  `polar_preht_dot_test` max relative diff `3.6e-7` versus
  dequantize-then-dot.

Benchmark note:

- Short M4 Max Metal run (`./metal_bench --iters 160 --warmup 20 --runs 1`):
  `polar` median `586.52 us`; `polar_preht` median `284.88 us`.
  This is a 2.06x speedup for the standalone Polar score kernel and moves
  Polar into the same launch-floor cluster as Turbo/QJL.

Remaining production work:

- CPU SIMD pre-Hadamard variants have separate AVX2/NEON work; keep measuring
  the plugin path on each target CPU before defaulting it for CPU-only tiers.
- Model graph producers still need to choose `ggml_attn_score_polar_preht()`
  only after constructing `H*q`. The backend route is ready; the higher-level
  model graph must carry the preHT contract explicitly.
- A manifest/runtime bit should state whether Polar score receives raw `q` or
  `H*q`, and dispatch must hard-fail on a mismatched variant.

### P1 - Vulkan multi-block exists; native driver routing still needs evidence

Earlier review said Vulkan lacked multi-block variants. That is now stale. The
tree has specialization-constant multi-block shaders for Turbo3, Turbo4,
Turbo3-TCQ, and QJL, plus fused-attention SPIR-V routes. On this Mac, MoltenVK
verified standalone, multi-block, fused, and Polar-preHT paths.

Current evidence:

- `make -C packages/inference/verify vulkan-verify`: PASS via MoltenVK.
- `make -C packages/inference/verify vulkan-verify-multiblock`: PASS via
  MoltenVK.
- `make -C packages/inference/verify vulkan-verify-fused`: PASS via MoltenVK.
- `vulkan_bench` rebuilt as arm64 and runs via MoltenVK. It shows multi-block
  wins for large `n_kv`/`n_tokens`, but MoltenVK is not a publishable native
  Vulkan performance proxy.

Remaining recommendation:

- Keep the portable shared-memory reduction. Do not reintroduce subgroup-size
  assumptions.
- Keep specialization constants for `blocks_per_workgroup` /
  `tokens_per_workgroup`, with conservative defaults.
- Add native driver sweeps before any per-vendor default:
  - Adreno: sweep N in `{2,4,8,16}` and local size `{32,64}`.
  - Mali: sweep N in `{2,4,8}` and watch barrier/register pressure.
  - Desktop AMD/NVIDIA/Intel: sweep N in `{4,8,16,32}`.

Acceptance:

- Native Linux `vulkan-dispatch-smoke`, not MoltenVK only.
- Android physical-device evidence for at least one Adreno and one Mali.
- Windows Vulkan smoke if Windows remains a supported local runtime target.

### P1 - QJL integer-dot path - CPU reference experiment LANDED

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

Implemented in this pass:

- Added experimental `qjl_i8_sketch_256` to
  `packages/native-plugins/qjl-cpu/include/qjl/qjl.h`.
- Added `qjl_quantize_sketch_i8_ref()` and `qjl_score_qk_i8_ref()` in
  `packages/native-plugins/qjl-cpu/src/qjl_score_i8_ref.c`.
- Added `qjl_int8_smoke` to the qjl-cpu CMake build plus standalone C smoke
  coverage under `packages/native-plugins/qjl-cpu/test/qjl_int8_smoke.c`.
- Local direct `cc` build/run on Apple arm64 passed:
  `max_abs=0.001207 max_rel=0.001207 failures=0`.

Remaining before default-on:

- Add NEON dot-product/i8mm and AVX512/VNNI implementations; the new path is
  scalar reference only.
- Add a fixture family and end-to-end model tolerance gates. The current fp32
  QJL path remains the exact verification baseline.
- Add Metal/Vulkan/CUDA variants only after device-specific tolerance and
  throughput evidence prove the int8 sketch is a net win.

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

### P2 - Turbo3/Turbo4/TCQ Metal float4 micro-optimization - LANDED

Turbo3, Turbo4, TCQ, and QJL cluster near the same Metal latency because they
are launch-bound at the current dispatch shape. Micro-tuning their inner loops
will not beat multi-block dispatch or fused attention.

Implemented in this pass:

- `turbo3.metal`, `turbo4.metal`, and `turbo3_tcq.metal` now load each lane's
  four contiguous query values as one `float4`.
- The decoded centroid values are assembled into a local `float4` and reduced
  with `dot(qv, kv)` for both single-block and multi-block entrypoints.
- The multi-block TurboQuant entrypoints now hoist the invariant query `float4`
  out of the per-KV-block loop, matching the QJL multi-block shape. This removes
  redundant Q loads for `blocks_per_threadgroup > 1`; the post-change M4 timing
  sweep remained noisy, so this is treated as a cleanliness/low-risk win rather
  than a claimed standalone speedup.
- `make -C packages/inference/verify metal-verify` and
  `make -C packages/inference/verify metal-verify-multiblock` pass after the
  change.

Short M4 Max Metal benchmark note (`./metal_bench --iters 160 --warmup 20 --runs 1`):

| Kernel | Median after change |
| --- | ---: |
| Turbo3 | `243.17 us` |
| Turbo4 | `245.08 us` |
| Turbo3-TCQ | `242.88 us` |
| Polar pre-Hadamard | `238.77 us` |

Remaining small experiments:

- For Vulkan, consider aligned GPU staging layouts for packed blocks. The
  current raw-byte reads preserve packed cache storage, but native drivers may
  benefit from 4-byte-aligned GPU-only staging for QJL/Polar if the memory
  budget allows it.

Do not prioritize more centroid micro-tuning ahead of fused attention or
runtime multi-block/pre-Hadamard routing.

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
   - Metal/Vulkan standalone: done and verified.
   - CPU/runtime graph route: still open.
4. Add native Vulkan graph-dispatch/performance evidence for the existing
   multi-block and fused routes on Linux/Android/Windows drivers.
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
