// hip_verify.cu — ROCm/HIP fixture-parity harness for the
// turbo3 / turbo4 / turbo3_tcq / qjl / polar (+ polar_qjl, fused_attn_qjl_tbq)
// kernels. Sibling of cuda_verify.cu (NVIDIA), metal_verify.mm (Apple),
// vulkan_verify.cpp (cross-vendor) — same contract, same JSON fixtures, same
// C reference (`expected_scores` / `expected_out` regenerated from
// reference/turbo_kernels.c + verify/qjl_polar_ref.c), same 1920/1920-style
// pass count, same `qjl_polar_ref.o` / `turbo_kernels.o` linked for the
// on-host double-check.
//
// WHY THIS IS A THIN SHIM OVER cuda_verify.cu:
//
//   HIP is, by design, a near-identical superset of the CUDA runtime + kernel
//   language on AMD GPUs: the `<<<grid, block>>>` launch syntax, `__global__`,
//   `__device__`, `__constant__`, `__shfl_down_sync`, `__half` /
//   `__half2float`, and the `cuda*` runtime entry points (renamed `hip*`) all
//   map 1:1. cuda_verify.cu now guards its backend-header block on
//   `__HIP_PLATFORM_AMD__` (set by `hipcc`) and aliases the handful of `cuda*`
//   symbols it uses to their `hip*` equivalents — so this file is just:
//       #include "cuda_verify.cu"
//   compiled by `hipcc`. The ~25 device kernels, the JSON fixture loader, the
//   reference cross-check, and `main()` are the EXACT same source the NVIDIA
//   harness builds — only the backend ABI differs. That is the strongest
//   "ROCm runs the same numerics" claim short of a separately-authored kernel
//   set, and it stays in lockstep with cuda_verify.cu automatically (a drifted
//   CUDA kernel would break the HIP build too).
//
// STATUS (honest): the fork's *production* .cu kernels
// (turboquant.cuh / qjl.cu / polarquant.cu / turbo-tcq.cu) are not yet
// `__HIP_PLATFORM_AMD__`-clean — making them HIP-compilable is a stretch goal
// recorded in reports/porting/2026-05-11/needs-hardware-ledger.md. Until that
// lands, the ROCm runtime story is: (a) this numeric gate
// (`make -C packages/inference/verify hip-verify` on an AMD `gfx*` box), plus
// (b) the documented reduced-optimization local mode
// (`ELIZA_LOCAL_ALLOW_STOCK_KV=1`, loud warning, not publishable) for
// production inference on ROCm. kernel-contract.json's `linux-x64-rocm`
// entry says so honestly. This source is authored + buildable; running it
// needs `hipcc` + `rocminfo` reporting a `gfx*` agent — see rocm_runner.sh.
//
// Build:
//     make -C packages/inference/verify hip-verify          # all fixtures
// or manually (ROCm/HIP toolchain present):
//     hipcc -O2 -std=c++17 -I. hip_verify.cu qjl_polar_ref.o turbo_kernels.o \
//           -lm -o hip_verify
//     ./hip_verify fixtures/turbo3.json [tol=1e-3]
//
// Full hardware gate (build the fork's linux-x64-rocm target, run fixtures,
// then drive a real GGUF graph dispatch): verify/rocm_runner.sh.

#ifndef __HIP_PLATFORM_AMD__
// Defensive: if someone compiles this file with a non-HIP compiler, force the
// HIP code path in cuda_verify.cu anyway (it will then fail to find the HIP
// headers — which is the correct, loud failure: hip_verify.cu must be built
// with `hipcc`).
#define ELIZA_VERIFY_HIP 1
#endif

#include "cuda_verify.cu"
