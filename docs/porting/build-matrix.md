# Build matrix — unified llama.cpp fork

> Per-cell status of every (platform, ABI, GPU-backend) combination
> that ships a Milady on-device runtime artifact. The unified fork
> ([`milady-ai/llama.cpp`](https://github.com/milady-ai/llama.cpp) @
> `v0.1.0-milady`) is the authoritative source; per-cell artifacts
> live under `~/.eliza/local-inference/bin/<target>/` for host
> targets and under `apps/app/android/app/src/main/assets/agent/<abi>/`
> for AOSP. See
> [`docs/porting/unified-fork-strategy.md`](./unified-fork-strategy.md)
> for the per-technique branching scheme that produces these
> artifacts, and
> [`docs/porting/on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md)
> for the per-technique deliverable order.

## Status legend

- **`✓ verified`** — Artifact builds, native runtime smoke + symbol
  audit completed on the matching hardware (or QEMU for cross-arch
  parity), exported symbols include the Milady additions
  (`tbq{3,4}_0`, `qjl1_256`, `q4_polar`, `eliza_llama_*`), and at
  least one end-to-end agent chat round-trip has been recorded.
- **`⚠ partial`** — Build compiles, symbols are emitted, but at least
  one of {device runtime, parity check, end-to-end chat} hasn't run
  on the matching hardware yet. Cross-arch verification (QEMU) lands
  here when no physical device is available.
- **`□ source-only`** — Source/CMake configuration is in the fork but
  no green CI build has been recorded. Configure-only verified
  (CMake walked the tree without erroring) but compile not started.
- **`✗ blocked`** — Hardware or upstream dependency is missing; the
  cell cannot be built today even if scheduled. See **Notes** for
  the specific block.

The verification commands assume:

- `MILADY_LLAMA_CPP_REMOTE=https://github.com/milady-ai/llama.cpp` and
  `MILADY_LLAMA_CPP_REF=v0.1.0-milady` (the post-fork-unifier pin).
- `~/.cache/milady-llama-cpp/<commit>` is the canonical checkout
  cache used by `compile-libllama.mjs` (AOSP) and
  `build-llama-cpp-dflash.mjs` (host).

Symbols listed under "Expected exported symbols" are the Milady-side
additions on top of stock llama.cpp; the upstream `llama_*` /
`ggml_*` API is always present and not enumerated here.

## Cells

### Linux

| Cell | Status | Notes |
|---|---|---|
| `linux-x64-cpu` | `✓ verified` | Built by the fork-unifier on `2026-05-09`. Used as the host reference for every cross-arch parity check. |
| `linux-x64-cuda` | `□ source-only` | W3-D walked the CUDA configure on a CUDA-toolkit-equipped host and started compiling `ggml-cuda` template instances; no green end-to-end run yet. |
| `linux-x64-vulkan` | `□ source-only` | W3-E configure-only verified the SPIR-V compile path; needs a Vulkan loader + GPU runner. |
| `linux-arm64-cpu` | `⚠ partial` | W2-A and W2-B cross-built and ran the QJL/Polar NEON kernels under `qemu-aarch64-static` with 100/100 bit-parity. End-to-end agent chat against this artifact has not run on a physical aarch64 Linux device. |
| `linux-arm64-vulkan` | `✗ blocked` | Needs Adreno or Mali silicon (or a discrete arm64 + GPU box). No GH-hosted runner. |

#### `linux-x64-cpu`

- **Build command (host CMake):**
  ```bash
  cmake -B build-linux-x64-cpu \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-cpu --target llama-server llama-cli
  ```
- **Expected exported symbols:** `quantize_row_tbq3_0`,
  `quantize_row_tbq4_0`, `dequantize_row_tbq{3,4}_0`,
  `quantize_row_qjl1_256`, `dequantize_row_qjl1_256`,
  `qjl_quantize_row_avx2`, `qjl_score_qk_avx2`,
  `qjl_quantize_row_ref`, `qjl_score_qk_ref`,
  `quantize_row_q4_polar`, `dequantize_row_q4_polar`,
  `ggml_attn_score_qjl`.
- **Verification command:**
  ```bash
  nm -D --defined-only build-linux-x64-cpu/bin/libggml-cpu.so |
    grep -E 'tbq|qjl|polar' | wc -l   # expect ≥ 30
  ```
- **Hardware required:** any x86_64 Linux box; GH `ubuntu-24.04`.
- **Reports:** `reports/porting/2026-05-09-unified/INDEX.md` (TBQ=8,
  QJL=19 on arm64 / 15 on x86_64, Polar=4 per backend).

#### `linux-x64-cuda`

- **Build command:**
  ```bash
  cmake -B build-linux-x64-cuda \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DGGML_CUDA=ON -DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-cuda --target ggml-cuda llama-server
  ```
- **Expected exported symbols:** baseline CPU set (above) plus the
  CUDA TBQ template instances inherited from apothic
  (`mmq_tbq3_0`, `mmq_tbq4_0`, `fattn_vec_tbq3_0`,
  `fattn_vec_tbq4_0`). QJL/Polar CUDA kernels are not yet ported —
  see `docs/porting/unified-fork-strategy.md` §D.
- **Verification command:**
  ```bash
  nm -D --defined-only build-linux-x64-cuda/bin/libggml-cuda.so |
    grep -E 'tbq.*kernel|fattn.*tbq' | wc -l   # expect ≥ 8
  ```
- **Hardware required:** Linux x86_64 + NVIDIA GPU + CUDA toolkit
  ≥ 12.0. Self-hosted runner labels: `cuda-l4` (L4) or `cuda-a10`.
- **Reports:** `reports/porting/2026-05-09-w3/build-cuda-ggml.log`
  (template-instance compile pass, no end-to-end yet).

#### `linux-x64-vulkan`

- **Build command:**
  ```bash
  cmake -B build-linux-x64-vulkan \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DGGML_VULKAN=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-vulkan --target ggml-vulkan llama-server
  ```
- **Expected exported symbols:** SPIR-V `.spv` compiled into
  `libggml-vulkan.so` for the upstream quants plus the Milady
  additions whose `.comp` shaders have landed. Today the fork
  ships TBQ Vulkan shaders (W1-D); QJL and Polar Vulkan are
  source-only (`local-inference/kernels/vulkan/{qjl,polar}.comp`
  present, dispatcher unwired).
- **Verification command:**
  ```bash
  ls build-linux-x64-vulkan/bin/*.spv 2>/dev/null | wc -l   # ≥ 3 (turbo3, turbo3_tcq, turbo4)
  ```
- **Hardware required:** Linux x86_64 + Vulkan ICD; GH-hosted
  `ubuntu-24.04` covers the SPIR-V compile, real GPU runtime
  needs a discrete card.

#### `linux-arm64-cpu`

- **Build command (zig cross from x86_64 host):**
  ```bash
  cmake -B build-linux-arm64-cpu \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_C_COMPILER="zig" \
    -DCMAKE_C_COMPILER_ARG1="cc -target aarch64-linux-gnu" \
    -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
    -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-arm64-cpu
  ```
- **Expected exported symbols:** baseline CPU set, plus
  `qjl_quantize_row_neon`, `qjl_quantize_rows_neon`,
  `qjl_dequantize_row_neon`, `qjl_score_qk_neon`,
  `dequantize_row_q4_polar_neon`,
  `ggml_vec_dot_q4_polar_q8_0_neon`.
- **Verification command:**
  ```bash
  qemu-aarch64-static -L /tmp/aarch64-sysroot \
    build-linux-arm64-cpu/bin/qjl_fork_parity   # expect 100/100
  qemu-aarch64-static -L /tmp/aarch64-sysroot \
    build-linux-arm64-cpu/bin/polar_dot_test    # expect rel-err in budget
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build +
  `qemu-aarch64-static` parity. Real device verification needs a
  Pixel/dev-board with an arm64 Linux userspace.
- **Reports:** `reports/porting/2026-05-09-w2/qjl-neon-cross.md`,
  `reports/porting/2026-05-09-w2/polar-neon-cross.md`.

### macOS / iOS

| Cell | Status | Notes |
|---|---|---|
| `darwin-arm64-cpu` | `□ source-only` | The fork's Apple Silicon CPU path inherits upstream defaults; no Milady-specific bring-up yet (NEON sources work, they just haven't been built on a Mac runner). |
| `darwin-arm64-metal` | `⚠ partial` | W3-G shipped a ready-to-run Apple-Silicon build kit with the .metal sources from W1-D vendored under `ggml/src/ggml-metal/milady-kernels/`. Dispatcher wiring (`ggml-metal.metal` updates so TBQ/QJL/Polar route to the new shaders) is the next step. |
| `darwin-x64-metal` | `✗ blocked` | Apple deprecated x86_64 Metal toolchains in 2024. Not a target; documented for completeness. |
| `ios-arm64-metal` | `□ source-only` | Same `.metal` sources as `darwin-arm64-metal` plus the `LlamaCpp.xcframework` packaging at `packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch`. Needs Apple Silicon runner. |
| `ios-arm64-simulator-metal` | `□ source-only` | Same as `ios-arm64-metal` with `CMAKE_OSX_SYSROOT=iphonesimulator`. |

#### `darwin-arm64-metal`

- **Build command:**
  ```bash
  cmake -B build-darwin-arm64-metal \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-darwin-arm64-metal --target llama-server
  ```
- **Expected exported symbols:** baseline CPU set plus the
  embedded `default.metallib` linked into `libggml-metal.dylib`
  with the `kernel_get_rows_tbq{3,4}_0`,
  `kernel_mul_mv_tbq{3,4}_0_f32`,
  `kernel_cpy_f32_tbq{3,4}_0` MSL kernels. QJL/Polar Metal kernels
  exist as `.metal` sources under
  `ggml/src/ggml-metal/milady-kernels/` but are not dispatcher-wired.
- **Verification command:**
  ```bash
  ./local-inference/kernels/verify/metal_verify \
    ggml/src/ggml-metal/milady-kernels/turbo3.metal \
    kernel_turbo3_dot \
    local-inference/kernels/reference/turbo3.json
  ```
- **Hardware required:** Apple Silicon (M1/M2/M3/M4). Self-hosted
  runner label `apple-m3-pro`.
- **Reports:** W3-G ready-to-run kit (worktree-only, not yet on
  develop). Metal kernels staged in fork tree under
  `ggml/src/ggml-metal/milady-kernels/`; dispatcher patch pending.

#### `ios-arm64-metal`

- **Build command:**
  ```bash
  cmake -B build-ios-arm64-metal \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-ios-arm64-metal
  ```
- **Expected exported symbols:** static `lib*.a` archive set with
  the same Metal symbols as `darwin-arm64-metal`, packaged into
  `LlamaCpp.xcframework` for the `@elizaos/llama-cpp-capacitor`
  iOS jniLibs equivalent.
- **Verification command:**
  ```bash
  lipo -info build-ios-arm64-metal/bin/libllama.a   # expect arm64
  ar t build-ios-arm64-metal/bin/libggml-metal.a |
    grep -E 'tbq|qjl|polar' | wc -l   # ≥ 8
  ```
- **Hardware required:** Apple Silicon Mac with Xcode + iOS SDK.
- **Reports:** none yet — needs Apple Silicon runner.

### Android

| Cell | Status | Notes |
|---|---|---|
| `android-arm64-v8a-cpu+neon` | `⚠ partial` | W1-A built the libs and W2-A confirmed 100/100 bit-parity under QEMU. Real-hardware runtime (cuttlefish arm64 or a Pixel) hasn't run end-to-end yet. |
| `android-x86_64-cpu` | `⚠ partial` | Built by the fork-unifier on `2026-05-09` (build log `compile-libllama-x86_64.log` in the unified report). The cuttlefish AVD was the intended runtime gate but no green chat round-trip is on file yet. After W3-H's AVX2 flag fix, the next x86_64 rebuild should add `qjl_quantize_row_avx2` + `qjl_score_qk_avx2` to the symbol set. |
| `android-arm64-v8a-vulkan` | `✗ blocked` | Needs an Adreno/Mali Android device with a working Vulkan ICD; cuttlefish AVDs ship a SwiftShader Vulkan stub that is not representative. |

#### `android-arm64-v8a-cpu+neon`

- **Build command (zig cross from `compile-libllama.mjs`):**
  ```bash
  bun run --cwd packages/app-core scripts/aosp/compile-libllama.mjs \
    --abi arm64-v8a \
    --assets-dir apps/app/android/app/src/main/assets/agent/arm64-v8a
  ```
- **Expected exported symbols:** AOSP musl-linked `libllama.so`,
  `libggml-base.so`, `libggml-cpu.so`, `libeliza-llama-shim.so`,
  plus a cross-compiled `llama-server`. NEON variants per
  `linux-arm64-cpu` above; shim adds
  `eliza_llama_context_params_set_type_k`,
  `eliza_llama_context_params_set_type_v`,
  `eliza_llama_create_speculative` (when the DFlash shim drop
  lands).
- **Verification command:**
  ```bash
  $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm \
    -D --defined-only \
    apps/app/android/app/src/main/assets/agent/arm64-v8a/libggml-cpu.so |
    grep -E 'tbq|qjl|polar' | wc -l   # ≥ 30
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build.
  Real-device verification needs cuttlefish arm64 (KVM-required,
  self-hosted) or an `adb`-connected Pixel.
- **Reports:** `reports/porting/2026-05-09-unified/aosp-symbols-post.txt`,
  `reports/porting/2026-05-09-w2/qjl-neon-cross.md`.

#### `android-x86_64-cpu`

- **Build command:**
  ```bash
  bun run --cwd packages/app-core scripts/aosp/compile-libllama.mjs \
    --abi x86_64 \
    --assets-dir apps/app/android/app/src/main/assets/agent/x86_64
  ```
- **Expected exported symbols:** same shape as
  `android-arm64-v8a-cpu+neon` but with AVX2 variants
  (`qjl_quantize_row_avx2`, `qjl_score_qk_avx2`, AVX2 polar
  vec-dot) instead of NEON. **W3-H caveat:** the unified-fork
  build pre-W3-H's fix shipped 15 QJL symbols on x86_64 vs 19 on
  arm64 because the AVX2 sources `#if-out`'d to nothing under
  `GGML_NATIVE=OFF`. Post-W3-H (this followup) the x86_64 build
  should match arm64's symbol count.
- **Verification command:**
  ```bash
  $NDK/.../llvm-nm -D --defined-only \
    apps/app/android/app/src/main/assets/agent/x86_64/libggml-cpu.so |
    grep -E 'qjl_(quantize_row|score_qk)_avx2' | wc -l   # expect 2
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build.
  Cuttlefish x86_64 AVD for runtime.
- **Reports:** `reports/porting/2026-05-09-unified/symbol-counts.txt`
  (pre-W3-H baseline). Post-W3-H rerun is queued.

#### `android-arm64-v8a-vulkan`

- **Build command:**
  ```bash
  cmake -B build-android-arm64-vulkan \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 \
    -DGGML_VULKAN=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-android-arm64-vulkan
  ```
- **Expected exported symbols:** NDK-linked `libllama.so` distinct
  from the musl path, plus Vulkan SPIR-V shaders. Adreno/Mali
  ICD loaded at runtime by the host process.
- **Verification command:** runtime `vkInfo` against the device
  (`adb shell vulkaninfo`); shader load via `llama-cli --vulkan`.
- **Hardware required:** Adreno/Mali Android device. No
  GH-hosted equivalent; cuttlefish's Vulkan ICD is SwiftShader
  software emulation.

### Windows

| Cell | Status | Notes |
|---|---|---|
| `windows-x64-cpu` | `⚠ partial` | W3-F built the mingw-w64 cross from Linux (`/tmp/llama-mingw-build`). End-to-end runtime hasn't run on a real Windows box yet. |
| `windows-x64-cuda` | `□ source-only` | Needs W3-F + CUDA cross-compile. |
| `windows-x64-vulkan` | `□ source-only` | Needs W3-F + Vulkan SDK. |

#### `windows-x64-cpu`

- **Build command (mingw-w64 cross from Linux):**
  ```bash
  cmake -B build-windows-x64-cpu \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_TOOLCHAIN_FILE=cmake/x86_64-w64-mingw32.cmake \
    -DGGML_NATIVE=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-windows-x64-cpu --target llama-server
  ```
- **Expected exported symbols:** `llama-server.exe`, `llama.dll`,
  `ggml-cpu.dll` with the same Milady symbol set as
  `linux-x64-cpu`.
- **Verification command:**
  ```bash
  x86_64-w64-mingw32-objdump -p build-windows-x64-cpu/bin/ggml-cpu.dll |
    grep -E 'tbq|qjl|polar' | wc -l   # ≥ 30
  ```
- **Hardware required:** GH `windows-2022` for native MSVC, or
  `ubuntu-24.04` + mingw-w64 for the cross. Native runtime
  verification needs a Windows box.
- **Reports:** W3-F mingw build at `/tmp/llama-mingw-build`
  (worktree-local, not yet on develop).

#### `windows-x64-cuda`

- **Build command:**
  ```bash
  cmake -B build-windows-x64-cuda \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_TOOLCHAIN_FILE=cmake/x86_64-w64-mingw32.cmake \
    -DGGML_CUDA=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-windows-x64-cuda
  ```
- **Expected exported symbols:** `windows-x64-cpu` set plus
  `ggml-cuda.dll` with TBQ CUDA template instances.
- **Verification command:**
  ```bash
  ls build-windows-x64-cuda/bin/ggml-cuda.dll
  ```
- **Hardware required:** Windows + CUDA toolkit + RTX-class GPU.
  Self-hosted runner label `windows-rtx`.

#### `windows-x64-vulkan`

- **Build command:**
  ```bash
  cmake -B build-windows-x64-vulkan \
    -S ~/.cache/milady-llama-cpp/edd55d8b \
    -DCMAKE_TOOLCHAIN_FILE=cmake/x86_64-w64-mingw32.cmake \
    -DGGML_VULKAN=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-windows-x64-vulkan
  ```
- **Expected exported symbols:** `windows-x64-cpu` set plus
  Vulkan `.spv` shader artifacts.
- **Verification command:**
  ```bash
  ls build-windows-x64-vulkan/bin/*.spv | wc -l   # ≥ 3
  ```
- **Hardware required:** Windows + Vulkan SDK + Vulkan-capable
  GPU. Cross-compile only is GH-hosted-runner-friendly.

## Summary by status

- **`✓ verified`:** `linux-x64-cpu`.
- **`⚠ partial`:** `linux-arm64-cpu`, `darwin-arm64-metal`,
  `android-arm64-v8a-cpu+neon`, `android-x86_64-cpu`,
  `windows-x64-cpu`.
- **`□ source-only`:** `linux-x64-cuda`, `linux-x64-vulkan`,
  `darwin-arm64-cpu`, `ios-arm64-metal`,
  `ios-arm64-simulator-metal`, `windows-x64-cuda`,
  `windows-x64-vulkan`.
- **`✗ blocked`:** `darwin-x64-metal`, `linux-arm64-vulkan`,
  `android-arm64-v8a-vulkan`.

## What this matrix replaces

The pre-fork-unifier era tracked artifact status across three
separate llama.cpp trees (`Apothic-AI/llama.cpp-1bit-turboquant`
for AOSP, `spiritbuun/buun-llama-cpp` for the host DFlash server,
upstream `node-llama-cpp@3.18.1` for desktop). Per-cell verification
required reading three different build scripts and reconciling
patch-application status by hand. After the fork unifier landed
(`reports/porting/2026-05-09-unified/INDEX.md`), every cell pulls
from the same `milady-ai/llama.cpp @ v0.1.0-milady` and the only
moving variable is the platform/ABI/backend. This file is the
canonical place for that table.
