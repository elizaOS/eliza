# This machine — Eliza-1 inference test capability (2026-05-11)

Ground-truth inventory of what can be built and run for kernel/runtime
verification on the development workstation. Companion data:
`packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json`.

## Hardware / toolchain

| Item | Value |
| --- | --- |
| OS | Linux 6.17.0-23-generic (Ubuntu 24.04 userspace) |
| CPU | Intel Core Ultra 9 275HX (Arrow Lake-HX, 24 logical cores). AVX2 / AVX-VNNI / F16C / SHA-NI / AES. **No AVX-512.** |
| RAM / swap | 30 GB / 39 GB |
| iGPU | Intel Arc/Xe — Mesa ANV 25.2.8 (`libvulkan_intel.so`). Vulkan reports `api 1.4.318`. |
| dGPU | NVIDIA Blackwell-class mobile (PCI `2c59`). `nvidia-driver-580-open` is installed but the `nvidia` kernel module is **not loaded** (`modinfo nvidia` → not found, `nvidia-smi` fails, `prime-select` = `on-demand`). CUDA is unavailable until the operator runs `sudo modprobe nvidia` (and likely a DKMS rebuild). |
| `gcc` 13.3.0 / `cmake` 3.28.3 / GNU Make 4.3 / `bun` 1.3.4 | present; `node_modules` populated. |
| `glslc` | present via Android NDK 29.0.13113456 (`~/Android/Sdk/ndk/29.0.13113456/shader-tools/linux-x86_64/glslc`). The Makefile's `findGlslc`/`NDK_GLSLC` picks it up automatically. |
| `vulkaninfo`, `glslangValidator`, `spirv-val`/`spirv-tools` | **not installed.** Not needed — `vulkan_verify` links the system `libvulkan.so.1` directly and `make vulkan-spirv` uses NDK `glslc`. |
| `nvcc` / CUDA Toolkit | **not installed.** |
| `mingw-w64` (`x86_64-w64-mingw32-gcc`) | **not installed** (only a cmake toolchain file cached at `~/.cache/eliza-dflash/mingw-toolchain/`). |
| Vulkan ICDs in `/usr/share/vulkan/icd.d/` | `intel_icd.json` (ANV, real), `lvp_icd.json` (lavapipe, software), `nouveau_icd.json` (NVK, software-ish on this box), `nvidia_icd.json` (proprietary — inert since the module isn't loaded), plus radeon/asahi/virtio/gfxstream stubs. |
| Caches present | `~/.cache/eliza-dflash/{vulkan-headers,spirv-headers,eliza-llama-cpp,buun-llama-cpp,mingw-toolchain}`. The cached `eliza-llama-cpp` clone is at detached `2baad86`; its `ggml-cuda/` has only `turboquant.cuh` — `turbo-tcq.cuh`, `qjl.cuh`, `polarquant.cuh` are produced by the build script's CUDA patch step and are **not yet staged**. (The primary source is the in-tree `packages/inference/llama.cpp` submodule; this loose cache dir only exists from a prior standalone-clone run.) |

## Capability matrix

| Target | Build here? | Run here? | Evidence | What's needed for the gap |
| --- | --- | --- | --- | --- |
| CPU C reference (`reference-test`, `gen_fixture --self-test`) | YES | YES | `make reference-test` clean; self-test `turbo3=-2.501480 turbo4=-23.721790 turbo3_tcq=-4.822659 qjl=3.696591 polar=-1.994053 polar_qjl=-1.438744 (all finite)` | — |
| Kernel contract (`kernel-contract`) | YES | YES | `node check_kernel_contract.mjs` → `OK kernels=6 targets=23 manifestNames=6` | — |
| CPU bench (`cpu-bench` + `./cpu_bench`) | YES (after the `_POSIX_C_SOURCE` fix below) | YES | `verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json` and `verify/bench_results/cpu_m4max_2026-05-10.json`. turbo3 19.4 ms / turbo4 12.2 ms / turbo3_tcq 17.7 ms / qjl 110.8 ms / polar 31.3 ms median (131072 outputs, single-thread scalar). | — |
| Vulkan SPIR-V compile (`vulkan-spirv`) | YES (NDK glslc, `--target-env=vulkan1.1 --target-spv=spv1.3`) | n/a | all 9 `../vulkan/*.spv` regenerated | — |
| Vulkan `vulkan_verify` standalone fixture check (`vulkan-verify`) — **Intel ARL Mesa ANV** | YES | YES | `make vulkan-verify` → 8/8 PASS on all 8 entrypoints (turbo3, turbo4, turbo3_tcq, qjl, polar, polar+QJL-residual, polar_preht, polar_preht+QJL-residual), `device=Intel(R) Graphics (ARL) api=1.4.318`, max diff ≤ 7.6e-6 | — (this is real hardware evidence; matches the README matrix's "Intel ARL Mesa 25.2.8" rows) |
| Vulkan `vulkan_verify` — **lavapipe (software)** | YES | YES (diagnostic only) | same 8 entrypoints 8/8 PASS with `ELIZA_ALLOW_SOFTWARE_VULKAN=1 VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`, max diff ≤ 9.5e-6 | harness refuses software ICDs without the env flag by design; software pass is not a hardware sign-off |
| Vulkan native graph-dispatch smoke (`vulkan-native-smoke` / `linux_vulkan_smoke.sh`) | NO (not yet) | NO | — | requires a built patched fork: `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan` to produce `libggml-vulkan.so` with the QJL/TBQ/Polar graph routes wired, then `make vulkan-native-smoke`. The Intel ANV iGPU here can run it once the fork is built. |
| Metal (`metal-verify`, `metal_bench`, `dispatch-smoke`) | NO | NO | — | macOS-only (`xcrun`). Owned by the Metal agent on an Apple host. |
| CUDA `cuda-preprocess-check` (host-side, nvcc NOT required) | NO (currently) | n/a | `make cuda-preprocess-check` fails at step 1: `MISS: dequantize_row_tbq3_tcq_cuda in turbo-tcq.cuh` — that header (and `qjl.cuh`, `polarquant.cuh`) is not in the cached `eliza-llama-cpp` checkout | run `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda --no-build` to fetch+patch the fork so `ggml-cuda/turbo-tcq.cuh|qjl.cuh|polarquant.cuh` exist, then `make cuda-preprocess-check`. CUDA-agent territory. |
| CUDA `cuda` / `cuda-verify` (compile + run) | NO | NO | — | needs `nvcc` (`apt install nvidia-cuda-toolkit` or CUDA Toolkit), `libggml-cuda.so` from a CUDA build of the fork, **and** a live NVIDIA GPU (`sudo modprobe nvidia` first — the Blackwell dGPU module is not loaded). |
| Windows (`windows-hardware`) | NO | NO | — | native Windows host; or cross-build via the cached mingw cmake toolchain after `apt install mingw-w64`. Platform-targets agent. |
| Android Vulkan on-device (`android-vulkan-smoke`) | partial (cross-compile only) | NO | — | NDK + emulator exist (`~/Android/Sdk`) but there is **no physical phone**; `android_vulkan_smoke.sh` needs `adb` to a real device. |

## turbo4 self-test discrepancy — VERDICT: case (a), stale doc, fixed

`gen_fixture --self-test` prints `turbo4=-23.721790`. `packages/inference/README.md` (§"What 'yes' means for the C references") documented `turbo4=-4.138101`.

Root cause: commit `21627dd8f6 chore: finalize PR merge follow-ups` rewrote `eliza_quantize_turbo4_block` / `eliza_dequantize_turbo4_block` / `eliza_dot_q_turbo4` from the old single 128-element WHT-rotated block (`turbo4=-4.138101`) to the **TBQ4 four-18-byte-record-per-128-row layout** (`ELIZA_QK_TURBO4=32`, Hadamard-32 preconditioning + per-32-element fp16 norm, low-nibble first 16 / high-nibble last 16). `verify/gen_fixture.c` and `verify/fixtures/turbo4.json` (`block_bytes:18, blocks_per_kv:4`) were updated in the **same commit**; only the README prose was missed. The other four self-test values (turbo3, turbo3_tcq, qjl, polar) are unchanged and still match, which is exactly what you'd expect from a turbo4-only layout swap. No regression in `reference/turbo_kernels.c` or `verify/gen_fixture.c`.

Action taken: updated the stale `turbo4=-4.138101` → `turbo4=-23.721790` in `packages/inference/README.md` (and added `polar_qjl=-1.438744` so the documented line matches the actual emitted line). No `reference/*.c` or `verify/fixtures/*` were touched.

## Build fix applied this pass

`verify/cpu_bench.c` failed to compile on glibc under `-std=c11` (`CLOCK_MONOTONIC undeclared`) because it never requested POSIX visibility — it only ever built on macOS/clang. Added `#define _POSIX_C_SOURCE 199309L` ahead of the includes. `cpu_bench.c` is a verify harness file (not `reference/*.c` or `verify/fixtures/*`), so this is in-scope.

## Commands to run when the operator provisions more

- After `sudo modprobe nvidia` succeeds + `apt install nvidia-cuda-toolkit`:
  `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda` then
  `make -C packages/inference/verify cuda-verify` (expect 8/8 on each fixture).
- For the host-side CUDA API check without nvcc/GPU:
  `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda --no-build` then
  `make -C packages/inference/verify cuda-preprocess-check`.
- For the Vulkan runtime graph-dispatch evidence the README still marks `NOT RUN`:
  `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-vulkan` then
  `make -C packages/inference/verify vulkan-native-smoke` (runs on the Intel ANV iGPU here).
- For Windows cross-build: `apt install mingw-w64` then the platform-targets agent's build path.
