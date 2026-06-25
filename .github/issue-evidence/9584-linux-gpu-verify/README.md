# #9584 — Linux CUDA/Vulkan kernel verification (real GPU)

The "Linux — CUDA/Vulkan" half of #9584 was filed as needing a `gpu-cuda`
runner. It was run on a real **NVIDIA GeForce RTX 5080 Laptop GPU (Blackwell,
sm_120)** host with CUDA 12.8 + Mesa/Vulkan 1.4 — see `host.txt`. Both kernel
correctness gates pass against the C reference (`native/reference/turbo_kernels.c`),
so the shipped TurboQuant / QJL / PolarQuant / fused-attention kernels are
verified on Blackwell.

## CUDA — RTX 5080 (sm_120), CUDA 12.8 → `cuda-verify-rtx5080-sm120.log`

Built with native `-gencode arch=compute_120,code=sm_120` (12.8 adds JIT-free
Blackwell SASS). `make cuda-verify`:

| fixture | result |
|---|---|
| turbo3 | 8/8 PASS (max diff 2.9e-06) |
| turbo4 | 8/8 PASS (max diff 5.7e-06) |
| turbo3_tcq | 8/8 PASS (max diff 5.7e-06) |
| qjl | 8/8 PASS (max diff 9.5e-06) |
| polar | 8/8 PASS (max diff 7.6e-06) |
| polar + QJL residual | 8/8 PASS (max diff 5.7e-06) |
| fused QJL-K + TBQ-V attention | **1920/1920** PASS across 4 head configs (max diff 5.1e-07) |

7/7 fixture families PASS, 0 FAIL (tol 1e-03).

## Vulkan — three implementations, all 8/8 score-kernel families PASS

`make vulkan-verify` (SPIR-V built via the Android-NDK glslc the Makefile
already falls back to). Runs turbo3 / turbo4 / turbo3_tcq / qjl / polar +
polar-residual + polar-pre-Hadamard variants:

| device | api | result |
|---|---|---|
| NVIDIA GeForce RTX 5080 Laptop GPU | 1.4.329 | 8/8 PASS → `vulkan-verify-rtx5080.log` |
| Intel(R) Graphics (ARL) iGPU | 1.4.318 | 8/8 PASS → `vulkan-verify-intel-igpu.log` |
| llvmpipe / lavapipe (CPU, software) | 1.4.318 | 8/8 PASS → `vulkan-verify-lavapipe-cpu.log` |

The lavapipe pass is the software-Vulkan gate the issue names — it means the
correctness gate is reproducible on a GPU-less CI runner too.

## Reproduce

```bash
cd plugins/plugin-local-inference/native/verify
# CUDA (needs nvcc >= 12.8 for native sm_120; the driver JITs compute_90 otherwise)
make cuda-verify NVCC=/usr/local/cuda-12.8/bin/nvcc
# Vulkan (system libvulkan + headers; glslc auto-resolves to the NDK copy)
make vulkan-verify ELIZA_MTP_VULKAN_HEADERS_DIR=/usr/include
#   target a specific device: VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json …
#   software path:            VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json ELIZA_ALLOW_SOFTWARE_VULKAN=1 …
```
