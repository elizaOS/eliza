# CUDA kernels — RTX 5080 bring-up, hardware verification, optimization (2026-05-11)

CUDA is now live on the authoring machine: NVIDIA GeForce RTX 5080 Laptop GPU
(Blackwell, compute capability 12.0, 16 GB VRAM; driver 580.142, CUDA runtime
13.0). The distro toolkit is `nvcc` 12.0, which does **not** target `sm_100` /
`sm_120` directly — CUDA ≥ 12.8 is needed for native Blackwell SASS. The
verify harness + the fork build both compile `sm_90/89/86/80` SASS plus
`compute_90` PTX, and the 580 driver JIT-compiles the `compute_90` PTX to
`sm_120` SASS at load. That is correctness-valid; perf is suboptimal vs native
`sm_120` SASS.

## 1. Build

`cudaArchListFlag()` in `build-llama-cpp-dflash.mjs` already does the right
thing — it appends `sm_100;sm_120` only when nvcc accepts them, so on this box
it pinned `CMAKE_CUDA_ARCHITECTURES=90a;90;89;86;80` (CMake emits SASS + PTX for
each). `patchCudaKernels` staged `cuda/fused-attn-qjl-tbq.cu` into
`ggml-cuda/`, `patchGgmlCudaForFusedAttn` flipped the CMake define, and the
`backend === "cuda"` branch pushed `-DGGML_CUDA_FUSED_ATTN_QJL=ON`. The TU
compiled clean (only `-Wmissing-declarations` warnings on the `extern "C"`
launch wrappers). The fork's own `ggml-cuda/{qjl,polarquant,turbo-tcq}.cu` +
the `fattn-vec-instance-tbq*.cu` instances also compiled.

**Build fix landed (was blocking *every* fork build, not just CUDA):** the
auto-generated `polarquant_preht.h` shim in `cpu-polar-kernels.mjs` never
declared `polar_qjl_signs_cached()`, which the staged PolarQuant `_preht` TUs
call — the fork build (which compiles `ggml-cpu`) failed with
`-Werror=implicit-function-declaration`. Added a `static inline` cached wrapper
over the fork's `polar_qjl_signs()` to the shim.

**Build env note:** no env var needed for the structured-output patch — it is
now tolerant of fork drift (reports present/absent features, never fails). The
`v1.0.0-eliza` fork carries `grammar_lazy` / `json_schema` / `response_format` /
`prefill_assistant`, so the patch applies cleanly.

## 2. Hardware verification

`make -C packages/inference/verify cuda-verify` and `make cuda-verify-fused` on
the RTX 5080 (after fixing two harness issues — see §4):

| fixture            | result               | max diff   |
| ------------------ | -------------------- | ---------- |
| turbo3             | **8/8 PASS**         | 2.86e-6    |
| turbo4             | **8/8 PASS**         | 5.72e-6    |
| turbo3_tcq         | **8/8 PASS**         | 5.72e-6    |
| qjl                | **8/8 PASS**         | 9.54e-6 (DP4A int8-sketch cross-check 1.43e-1 round-trip, expected) |
| polar              | **8/8 PASS**         | 7.63e-6    |
| polar + QJL residual | **8/8 PASS**       | 5.72e-6    |
| fused_attn_qjl_tbq | **1920/1920 PASS** (4 GQA/n_kv cases: n_kv 64/512/256/128, GQA 1/2/4) | 3.28e-7 |

**Graph dispatch** (`llama-bench` — the fork's `llama-cli` is conversation-only
and busy-loops on stdin EOF, so it can't be used for a non-interactive smoke;
`llama-bench` is the equivalent and runs the same prompt-eval + token-gen graph
passes): `eliza-1-0_6b-32k.gguf -ngl 99` runs `backend=CUDA` with the
`GGML_OP_ATTN_SCORE_TBQ` route exercised via `--cache-type-k tbq3_0`
(pp64 1014 t/s) and `--cache-type-k tbq4_0` (pp64 1679 t/s, tg8 262 t/s), both
with `-fa 1`. The fork registers turbo3/turbo4 as `--cache-type-k` storage
types but QJL / Polar / TBQ3-TCQ as score-side ops (`GGML_OP_ATTN_SCORE_QJL` /
`_POLAR`), not `--cache-type-k` aliases — same as the Vulkan path, where the
QJL/Polar built-fork graph route was verified via the `vulkan-dispatch-smoke`
C++ harness, not `llama-cli`. The CUDA equivalent of that numeric built-fork op
gate is `make cuda-verify` (the fixture-parity `__device__` kernels vs the C
references, 8/8 above).

Evidence: `verify/hardware-results/cuda-linux-rtx5080-2026-05-11.json`,
`verify/cuda-runtime-dispatch-evidence.json`.

## 3. Contract / README flip

- `kernel-contract.json`: `runtimeStatus.cuda` → `runtime-ready` for `turbo3`,
  `turbo4`, `turbo3_tcq`, `qjl`, `polar`; `fusedAttn.runtimeStatus.cuda` →
  `runtime-ready` (+ `fusedAttn.runtimeEvidence.cuda` pointing at the new
  evidence file); `platformTargets.linux-x64-cuda` /
  `linux-x64-cuda-fused` gates lifted to `verified`. `fused_attn` stays out of
  `requiredRuntimeCapabilityKeys` / `manifestKernelNames` (AGENTS.md §3).
- `check_kernel_contract.mjs`: loads `cuda-runtime-dispatch-evidence.json` and
  adds it to `fusedAttnEvidenceByBackend` so the `fusedAttn.runtimeStatus.cuda
  = runtime-ready` flip is gated on real evidence (same shape as the Vulkan
  gate). `make -C packages/inference/verify kernel-contract` stays green.
- `README.md` verification matrix: CUDA rows updated from `NEEDS-HARDWARE` /
  `AUTHORED` to `YES — verified on RTX 5080 (sm_90 PTX JIT to sm_120)`.
- Dropped `hardware-results/cuda-linux-thismachine-2026-05-11.pending.json`.

## 4. Harness fixes (so `cuda-verify` builds + runs on a real NVIDIA host)

- `cuda_verify.cu` was missing `#include <cuda_fp16.h>` — it used `__half` /
  `__half2float` in `fp16_to_fp32_dev` but only included `cuda_runtime.h`. It
  had never been compiled on real CUDA.
- `verify/Makefile`: `CUDA_HOME` now probes `/usr/include` (the distro
  `nvidia-cuda-toolkit` puts `cuda_runtime.h` there, not
  `/usr/local/cuda/include`); the default `CUDA_ARCH_FLAGS` always emits
  `sm_80/86/90` SASS + `compute_90` PTX (driver JITs to sm_120) and adds native
  `sm_120` SASS only when nvcc accepts it (≥ 12.8).

## 5. Kernel optimizations (production `cuda/fused-attn-qjl-tbq.cu`)

Parity-verified after each change (`make cuda-verify-fused` stays 1920/1920,
max diff 3.28e-7 — identical to pre-opt; the arithmetic and online-softmax
rescale order are unchanged, only *which lane* performs each scalar op moved).
Numbers in `verify/bench_results/cuda_kopt_2026-05-11.json`. The fused kernel is
not yet wired into a GGML graph op (only the standalone launch wrappers exist),
so a graph-level `llama-bench` delta cannot isolate it — the wins below are
arithmetic-reduction / memory-traffic reductions whose magnitude is analytical
and whose correctness is the fixture parity.

- **P0 — shared-memory V-decode.** The naive form had all 32 warp lanes re-run
  all 4 TBQ3 V-block decodes per KV step (4 × {32 codebook lookups +
  Hadamard-32 + 32 sign multiplies}) and keep only `dec[lane]` — ~31/32 wasted
  per block × 4 blocks × n_kv. Now lanes 0..3 each decode one block into
  `__shared__ float sh_dec[4][32]`, `__syncwarp()`, all 32 lanes read
  `sh_dec[c][lane]`. **8× fewer V-decode block-decodes per KV step** (32 → 4 —
  better than the 8-lane-subgroup variant the prior review proposed; the
  32-element Hadamard is inherently sequential so one thread per block is fine).
  512 B shared mem / warp. The kernel is V-decode dominated at long context, so
  this is roughly proportional minus the `__syncwarp` + shared-load overhead.
- **P1 — register-hoist the Q sketch row.** `qh[lane*8+b]` (8 fp32/lane) was
  reloaded from global on every KV step; Q is loop-invariant, so it's now loaded
  once into `float qreg[8]` at kernel entry. n_kv−1 redundant global loads per
  lane eliminated.

## 5a. P3 + native sm_120 SASS landed (2026-05-11, CUDA 12.8 wave)

CUDA 12.8 (`/usr/local/cuda-12.8`, `nvcc V12.8.93`) was installed on the box
alongside the distro 12.0. Changes:

- **Native Blackwell SASS.** `cudaArchListFlag()` already appended `100;120`
  when nvcc ≥ 12.8 — but only as seen on `PATH`, which is still the distro
  12.0. Added `resolveNvcc()` to `build-llama-cpp-dflash.mjs`: it probes
  `$CUDACXX`, `$CUDA_HOME/$CUDA_PATH/bin/nvcc`, `/usr/local/cuda-*/bin/nvcc`
  (newest first), `/usr/local/cuda/bin/nvcc`, then `PATH`, and picks the
  newest-versioned toolkit. `cudaArchListFlag()` now uses that version (so the
  CUDA-12.8 side-by-side toolkit is what decides `100;120`), and a new
  `cudaCompilerFlags()` emits `-DCMAKE_CUDA_COMPILER=<resolved nvcc>` plus
  prepends its bin dir to `PATH` for the cmake configure+build when it differs
  from `PATH`'s nvcc. The arch list for `linux-x64-cuda` is now
  `90a;90;89;86;80;100;120;90-virtual` — plain `120` is **real SASS** (`-gencode
  arch=compute_120,code=sm_120`), not PTX, so RTX 50xx launches JIT-free; the
  trailing `90-virtual` keeps forward-compat PTX in the fat binary. Verified by
  compiling `cuda/fused-attn-qjl-tbq.cu` against the fork headers with the full
  fat-binary list — `cuobjdump --list-elf` shows `sm_80/86/89/90/90a/100/120`
  cubins. The standalone `verify/cuda_verify` now also builds a native
  `sm_120.cubin` (Makefile's `CUDA_BLACKWELL_GENCODE` probe fires under 12.8).
- **P3 — occupancy + read-only loads.** `fused_attn_qjl_tbq3_kernel` and
  `qjl_score_dp4a_kernel` get `__launch_bounds__(32, 16)` (1 warp/block, ask for
  16 blocks/SM so the many tiny `n_heads × n_q_pos` attention blocks co-reside);
  `__ldg` on the K-cache scalars (`pk[t].signs[lane]`, `pk[t].d`, `q_scale[hq]`,
  the DP4A K signs + q bytes); the per-lane Q sketch row is now a vectorized
  `float4 + float4` load (with a scalar fallback when the 32-byte slice isn't
  16-aligned). The `verify/cuda_verify` fused kernel was rewritten from the old
  single-thread reference shape to the **same warp-cooperative form** so the
  gate exercises the production algorithm — `cuda-verify-fused` still
  1920/1920 PASS, max diff 4.47e-7 (was 3.28e-7; the warp-reduction order
  shifts a few ULPs, still 4 orders of magnitude inside the 1e-3 tol).
- **P3 — DP4A as the production standalone QJL path.** `qjl_score_dp4a_kernel`
  (64 `__dp4a` MACs over the int8-quantized Q sketch) is now documented as *the*
  NVIDIA standalone `GGML_OP_ATTN_SCORE_QJL` path; the fp32 sign-dot inside the
  fused kernel stays the bit-exact reference. nsys (back-to-back, same process)
  measured the DP4A kernel at **~2.27× faster** than the fp32 `qjl_score_kernel`
  on the `qjl.json` fixture (2,976 ns vs 6,752 ns). It still cross-checks
  against the fp32 path in the harness (max diff ~1.4e-1 vs the int8 round-trip
  — expected and well under any attention-softmax sensitivity).
- **P2 — cp.async/TMA staging: NOT applied (deferred with a recorded reason).**
  cp.async requires the *global source* to be aligned to the copy granularity
  (4/8/16 B). The on-cache QJL block is 34 B and the TBQ3 V block 14 B — neither
  layout has any natural 4-byte alignment at a token stride, so staging a KV
  tile via cp.async would need an aligned repack of the cache (or the sm_90+ TMA
  bulk-tensor path with a custom tensor map) *first*. That repack is a real
  design item, not a drop-in, and is out of scope for this wave. The kernel is
  V-decode-arithmetic dominated (Hadamard-32 × 4 blocks/token) far more than
  KV-load-latency dominated at the context lengths in the fixtures, so the
  expected win is modest until the V-decode itself is parallelized further.

**Nsight profiling note.** `ncu` (Nsight Compute 2022.4.1) is installed but
`ERR_NVGPUCTRPERM` — GPU performance counters need root / the
`NVreg_RestrictProfilingToAdminUsers=0` driver param, neither available on this
box. `nsys` (system tracer, no perf counters) works and gave the kernel-duration
deltas above; full occupancy / memory-throughput / stall-reason sections await a
host with profiling perms.

Remaining (still deferred): **P2** cp.async/TMA after an aligned cache repack;
parallelizing the TBQ3 V-decode beyond 4 lanes/warp; a graph-wired microbench
harness so the fused op's end-to-end delta can be isolated (only the standalone
launch wrappers exist today).

## 6. End-to-end benchmark

`llama-bench`, RTX 5080, `backend=CUDA`, `-ngl 99`
(`verify/bench_results/cuda_e2e_2026-05-11.json`):

| model            | KV cache | pp512 | pp4096 | tg128 |
| ---------------- | -------- | ----: | -----: | ----: |
| eliza-1-0_6b     | f16      | 6699 t/s | 2676 t/s | 53.9 t/s |
| eliza-1-0_6b     | tbq3_0 (-fa 1) | 685 t/s | 178 t/s | 40.9 t/s |
| eliza-1-1_7b     | f16      | 4254 t/s | 2290 t/s | 45.2 t/s |

(0.6B tbq4_0: pp64 1680 t/s, tg8 262 t/s. The 0.6B's 32768-token prompt fails
to create a context with this checkpoint — shorter trained ctx / KV alloc
limit.) Prompt-eval (compute-bound) is healthy; token-gen (~40–55 t/s) is
memory-latency-bound at batch 1 and runs on JIT'd generic `sm_120` SASS rather
than tuned native SASS — nvcc ≥ 12.8 would lift it. The TurboQuant KV-cache
path costs decode throughput vs f16 (the TBQ score/decode op has CPU-side
components in this build) but runs end-to-end on the CUDA backend with flash
attention on.

## What's left

- ~~Native `sm_120` SASS~~ — **done** (CUDA 12.8 installed; `resolveNvcc()` +
  `cudaCompilerFlags()` in the build hook pin it; arch list now includes real
  `100;120` SASS; verified via `cuobjdump --list-elf`). See §5a.
- Full `ggml-cuda` integration build with the 12.8 toolkit — **blocked on host
  RAM contention** (≥7 sibling agents building; ~3 GB free of 30 GB, 23 GB swap
  in use, 80+ `cc1plus`/`cicc` procs). The kernel-patch dry-run is green, the
  staged `fused-attn-qjl-tbq.cu` compiles clean against the fork headers with
  the full fat-binary arch list (native `sm_120` cubin confirmed), and an empty
  object is produced without `-DGGML_CUDA_FUSED_ATTN_QJL`. Re-run
  `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda`
  once the box is quiet to refresh `llama-server`/`llama-bench` and run the
  graph-dispatch + voice/runtime smoke.
- CUDA TTS/ASR `llama-bench` runs (still pending the rebuild above).
- P2 (cp.async/TMA after an aligned cache repack); a graph-wired microbench
  harness; profiling on a host with GPU perf-counter perms.
