# CUDA kernels — static review + optimization backlog (2026-05-11)

No NVIDIA hardware/`nvcc` on the authoring machine and the local Blackwell dGPU
is not yet runnable (see `cuda-bringup-operator-steps.md`), so this is a
**code-level** review of the production CUDA kernel
(`packages/inference/cuda/fused-attn-qjl-tbq.cu`), the fixture-parity harness
(`packages/inference/verify/cuda_verify.cu`), and the build/verify plumbing.
The benchmarking + contract flip waits on a CUDA host — use
`packages/training/scripts/cloud/run-on-cloud.sh --task kernel-verify` (or the
local bring-up doc) to get one.

## Correctness review — verdict: looks correct vs the C references

`fused-attn-qjl-tbq.cu`:

* `fused_bf16_to_fp32` / `fused_fp16_to_fp32`, `fused_tbq3_get_code` (3-bit
  packing with the cross-byte spill guard `byte + 1 < 12`), `fused_hadamard32`
  (in-place radix-2 + `1/sqrt(32)` norm), `k_fused_tbq3_codebook` (8 centroids),
  `k_fused_tbq_signs_32` (fixed ±1 vector) all match
  `eliza_fused_attn_qjl_tbq3` in `verify/qjl_polar_ref.c` and the Vulkan/Metal
  mirrors bit-for-bit. The QJL scale `sqrt(pi/2)/proj_dim` and the `* sm_scale`
  fold-in match.
* Online softmax is the standard flash form (`m_new = max(m, score)`,
  `corr = exp(m - m_new)`, `w = exp(score - m_new)`, `l = l*corr + w`,
  `acc = acc*corr + w*dec`). Because every lane sees the same `score`, the
  rescale is consistent across lanes — no divergence hazard. `inv_l` guards
  `l == 0`. ✔
* `qjl_score_dp4a_kernel`: the `#if __CUDA_ARCH__ >= 610` `__dp4a` path and the
  `#else` scalar fallback compute the same int8 dot; the `signs` byte is split
  into two 4-bit nibbles per `__dp4a` call (`(w & 1) * 4` shift), packed
  ±1→int8. The final `__shfl_down_sync` reduction + lane-0 write is correct.
  Accuracy is the fp32 score modulo the q→int8 round-trip (caller supplies
  `q_scale = max|q_h|/127`). ✔
* Launch wrappers assert `n_heads % n_kv_heads == 0` (GQA) and positivity;
  grid is `(n_heads, n_q_pos)` × 32 threads — one warp per (head, pos), matches
  the harness kernel `fused_attn_qjl_tbq3_kernel` in `cuda_verify.cu`. ✔

`cuda_verify.cu`: already uses `__device__ __constant__` for all centroid LUTs
(`k_turbo_centroids_3bit/4bit`, `k_tbq3_tcq_codebook[512]` from
`tbq3_tcq_codebook.inc`, `k_polar_q4_centroids`), `static_assert`s every block
struct size (14/18/52 B), and accumulates scores in `double` for parity
headroom. The Makefile `cuda` self-consistency target greps for the kernel
symbols + the codebook include so a regression in the harness shape fails the
`make cuda` gate even without hardware.

**Static-review gaps that need a real run to close:** `block_qjl1_256` /
`block_tbq3_0` field layouts come from the fork's `common.cuh` — the production
kernel `#include`s `ggml.h`/`ggml-impl.h`/`common.cuh`, which only resolve
inside the patched fork build (`patchCudaKernels` stages the file into
`ggml/src/ggml-cuda/`). A standalone `nvcc` of `fused-attn-qjl-tbq.cu` won't
compile; the real check is `node build-llama-cpp-dflash.mjs --target
linux-x64-cuda` + `make cuda-verify-fused`.

## Optimization backlog — ranked (all pending a CUDA host)

These extend the P1 "CUDA/H200 should start from fused attention" item in
`kernel-optimization-review.md` with concrete, code-level work on the kernel as
it stands today.

**P0 — V-decode is the obvious hotspot. Each lane re-decodes all 4 TBQ blocks
(4 × {32 codebook lookups + 32-point Hadamard + 32 sign multiplies}) every KV
step and keeps only `dec[lane]`.** That's ~31/32 wasted work per block, ×4
blocks, ×n_kv. Fix: split the 4 chunks across 8-lane sub-groups — lane `g*8 +
i` (g∈0..3) decodes block `g` into shared memory once, all lanes read their
slot. Cuts V-decode arithmetic ~4×. The comment in the kernel already flags
this ("A future optimization can split the 4 chunks across 8-lane groups"). Do
this first; it's the single biggest win and is parity-preserving.

**P1 — Q loaded from global every KV step.** `qh[lane*8 + b]` (8 fp32 per lane)
is reloaded inside the `t` loop. Stage the 256-elem `q_sketch` row into shared
memory (or 8 registers per lane) once at kernel entry — Q is reused across all
n_kv. Pairs naturally with K/V page tiling: the existing `kv_tile` arg already
walks tiles but currently only changes cancellation granularity; make it the
hook for `__shared__` K-sign / V-block staging so a tile of K/V is brought in
once per `(head, pos)` warp instead of streamed per token.

**P2 — `cp.async` / TMA staging of K-sign + V blocks on sm_80+ / sm_90+.** Once
P1's shared-memory tiling exists, double-buffer the K/V tile load with
`__pipeline_memcpy_async` (sm_80) or `cuda::memcpy_async` + the cluster/TMA path
on Hopper/Blackwell (sm_90+). Gate on `__CUDA_ARCH__` with a synchronous
fallback. Per the existing review: only after the simpler tiled kernel passes.

**P3 — promote the DP4A path into the standalone QJL score kernel.**
`qjl_score_dp4a_kernel` already exists in the production file but isn't wired as
the default standalone QJL score path; the fork's `ggml-cuda/qjl.cu` score
kernel still does the fp32 sign-dot. On Pascal+ the 256-dim sign-dot is 64
`__dp4a` MACs vs 256 fp32 FMAs. Wire it behind a runtime/build switch with the
fp32 path as the verified fallback; benchmark the q→int8 round-trip accuracy
delta on a real graph trace before flipping the default. (This is the "int8
sketch on CUDA/Hopper" P1.5 item — promote only with throughput evidence.)

**P3 — occupancy.** One warp/block at 32 threads under-uses an SM (≤32
resident warps if blocks are tiny). Either run 2–4 warps/block each handling a
different (head,pos) and share the K/V tile in shared memory, or pad the block
to 64/128 threads with the extra lanes idle only during the score reduce. Needs
`nvcc --ptxas-options=-v` + Nsight Compute on the target arch to tune; don't
guess.

**P4 — `__shfl_xor_sync` butterfly for the score reduce is already the right
primitive.** No change; just confirm the mask `0xFFFFFFFFu` is fine (full warp,
all lanes active — yes). On Blackwell the warp-reduce intrinsics
(`__reduce_add_sync`) could replace the 5-step butterfly for the int32 DP4A
accumulator — micro-opt, do last.

## GH200 / aarch64 (sm_90a) path — status: correct

* `build-llama-cpp-dflash.mjs`'s `linux-aarch64-cuda` branch pins
  `sm_90a` and the unconditional `sm_80..sm_90a` arch list; `sm_100`/`sm_120`
  are appended only when the installed `nvcc` accepts them
  (`cudaArchitecturesFlag`). `patchCudaKernels` + the `GGML_CUDA_FUSED_ATTN_QJL`
  CMakeLists patch run for the aarch64 CUDA target too.
* `verify/gh200_runner.sh` enforces arm64 Linux host userspace + an NVIDIA GPU
  with compute capability 9.x, then delegates to `cuda_runner.sh` with the
  aarch64 target / `sm_90a` build arch. Fail-closed: skip modes exit non-zero
  and the JSON must show `passRecordable: true`.
* The `27b-256k` and `27b-1m` tiers (CUDA-only-backend) are in the
  catalog/schema/Python manifest/platform-plan with `defaultEligible` blocked
  on a real GH200 verify. No code gap — needs the hardware run, which the cloud
  runner can do with `--gpu h200` (or a GH200 vast offer) once a GH200 image is
  pinned in `run-on-cloud.sh`'s `gpu_to_vast_query` (currently maps `h200` →
  single H200; a `gh200` token would add `num_gpus=1 gpu_name=GH200`).

## Exact "run me on a CUDA host" command

Locally (after the bring-up doc):
```bash
cd /home/shaw/eliza/eliza
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda
make -C packages/inference/verify cuda-verify cuda-verify-fused
ELIZA_DFLASH_SMOKE_MODEL=/path/to/eliza-1-smoke.gguf packages/inference/verify/cuda_runner.sh \
  --report packages/inference/verify/hardware-results/cuda-linux-thismachine-2026-05-11.json
make -C packages/inference/verify kernel-contract reference-test    # stays green
```
GH200/aarch64: swap `cuda_runner.sh` for `gh200_runner.sh --report …`.

Via cloud:
```bash
bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task kernel-verify --gpu h100 \
  --smoke-model /models/eliza-1-smoke.gguf --yes-i-will-pay
```

Only after a green `cuda_runner.sh` JSON (`status: pass`, `passRecordable:
true`, `graphSmoke: required`, `exitCode: 0`): flip `kernel-contract.json`
`runtimeStatus.cuda` (the five score kernels) and `fusedAttn.runtimeStatus.cuda`
from `needs-hardware` to `runtime-ready`, drop the
`hardware-results/cuda-linux-thismachine-2026-05-11.pending.json` stub, and
update the README matrix.
