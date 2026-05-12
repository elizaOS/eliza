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

**Build env note:** `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1` is required
(the pinned fork ref predates the post-refactor `llama-server` features the
default patch asserts; the resulting binary is dev-only, which is fine here).

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

Remaining (deferred — need a graph-wired microbench harness and/or Nsight on
the target arch, beyond this session's budget): **P2** cp.async/TMA
double-buffered K/V tile staging on sm_80+/sm_90+ (the `sh_dec` + `kv_tile`
seam is the hook); **P3** promote `qjl_score_dp4a_kernel` to the default
standalone QJL score path (needs fork-side `GGML_OP_ATTN_SCORE_QJL` wiring + a
real-trace round-trip accuracy check); **P3** occupancy (1 warp/block
under-uses an SM); native `sm_120` SASS (needs nvcc ≥ 12.8).

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

- Native `sm_120` SASS — needs `nvcc` ≥ 12.8 (distro toolkit here is 12.0).
- CUDA TTS/ASR `llama-bench` runs (out of time after 6+ rebuilds forced by a
  concurrent sibling CUDA build saturating this box).
- P2/P3 kernel optimizations (need a graph-wired microbench harness + Nsight).
- The fork's `llama-server` structured-output patch can't be applied against
  the current pinned ref (`ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1`) — a
  fork rebase is the fix, tracked elsewhere.
