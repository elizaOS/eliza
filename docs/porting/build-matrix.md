# Build matrix — unified llama.cpp fork

> Per-cell status of every (platform, ABI, GPU-backend) combination
> that ships a Eliza on-device runtime artifact. The unified fork
> ([`elizaOS/llama.cpp`](https://github.com/elizaOS/llama.cpp) @
> `v1.0.0-eliza`, commit `08032d57`) is the authoritative source and
> ships in-tree as the git submodule at `packages/inference/llama.cpp`;
> per-cell artifacts live under `~/.eliza/local-inference/bin/<target>/`
> for host targets and under
> `apps/app/android/app/src/main/assets/agent/<abi>/` for AOSP. See
> [`docs/porting/unified-fork-strategy.md`](./unified-fork-strategy.md)
> for the per-technique branching scheme that produces these
> artifacts,
> [`docs/porting/on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md)
> for the per-technique deliverable order, and
> [`docs/porting/CURRENT-STATE.md`](./CURRENT-STATE.md) for the
> single-page consolidated status.

## Status legend

- **`✓ verified`** — Artifact builds, native runtime smoke + symbol
  audit completed on the matching hardware (or QEMU for cross-arch
  parity), exported symbols include the Eliza additions
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

- The fork checkout is the in-repo submodule `packages/inference/llama.cpp`
  (`elizaOS/llama.cpp @ v1.0.0-eliza`, commit `08032d57`) — `bun install`
  inits it via `scripts/ensure-llama-cpp-submodule.mjs`. Both build scripts
  (`compile-libllama.mjs` AOSP, `build-llama-cpp-dflash.mjs` host) default to
  it; `ELIZA_DFLASH_LLAMA_CPP_REMOTE` / `_REF` (or `--cache-dir` / `--src-dir`)
  force a standalone clone at `~/.cache/eliza-dflash/eliza-llama-cpp` instead.
- Older example invocations below using a `~/.cache/...llama-cpp-v0.1.0`
  directory name are illustrative of a standalone-clone layout; the current
  default is the submodule path above.

Symbols listed under "Expected exported symbols" are the Eliza-side
additions on top of stock llama.cpp; the upstream `llama_*` /
`ggml_*` API is always present and not enumerated here.

## Cells

### Linux

| Cell | Status | Notes |
|---|---|---|
| `linux-x64-cpu` | `✓ verified` | **Measured 2026-05-09 (W4-D):** native build pass in 1m04s; 33 tbq/qjl/polar symbols in `libggml-cpu.so` (including W3-B fused). Used as the host reference for every cross-arch parity check. |
| `linux-x64-cuda` | `⚠ partial` | **Measured 2026-05-09 (W4-D):** ~40m compile pass against sm_80/86/89/90; 167/167 .cu files OK (W3-D process re-confirmed). TBQ CUDA template instances (4 fattn-vec) compile clean. QJL/Polar CUDA still **not in fork** (W4-B kernel port not landed). No real-GPU runtime test on this host. |
| `linux-x64-vulkan` | `⚠ partial` | **Measured 2026-05-09 (W4-D):** 8/8 `.comp` shaders compile clean. lavapipe + Intel ARL turbo3/4/tcq runtime: 0/8 PASS (driver-portability subgroup-size bug; W4-A fix not landed yet). qjl/polar shaders compile clean but no harness/fixtures yet. |
| `linux-arm64-cpu` | `⚠ partial` | **Measured 2026-05-09 (W4-D):** zig cross-build pass in 1m41s; 6 tbq + 22 qjl + 7 polar symbols (NEON variants present). QEMU-user QJL self-parity 100/100 + fork dlopen parity 100/100 against W2-A glibc baseline. End-to-end agent chat against this artifact has not run on a physical aarch64 Linux device. |
| `linux-arm64-vulkan` | `✗ blocked` | Needs Adreno or Mali silicon (or a discrete arm64 + GPU box). No GH-hosted runner. |

#### `linux-x64-cpu`

- **Build command (host CMake):**
  ```bash
  cmake -B build-linux-x64-cpu \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
    -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-cpu --target llama-server llama-cli
  ```
- **Expected exported symbols (`libggml-cpu.so`):**
  `quantize_row_tbq{3,4}_0`, `dequantize_row_tbq{3,4}_0`,
  `ggml_vec_dot_tbq{3,4}_0_f32`,
  `quantize_row_qjl1_256`, `dequantize_row_qjl1_256`, `quantize_qjl1_256`,
  `qjl_quantize_row_avx2`, `qjl_score_qk_avx2`,
  `qjl_quantize_row_ref`, `qjl_score_qk_ref`,
  `quantize_row_q4_polar`, `dequantize_row_q4_polar`,
  `ggml_vec_dot_q4_polar_q8_0`, `ggml_compute_forward_attn_score_qjl`,
  `ggml_compute_forward_fused_attn_qjl_tbq` (W3-B fused),
  `ggml_vec_dot_q4_polar_q8_0_fused{,_avx2,_hadamard,_ref}` (W3-B fused).
- **Verification command:**
  ```bash
  nm -D --defined-only build-linux-x64-cpu/bin/libggml-cpu.so |
    grep -E 'tbq|qjl|polar' | wc -l   # measured 2026-05-09: 33
  ```
- **Hardware required:** any x86_64 Linux box; GH `ubuntu-24.04`.
- **Reports:** `reports/porting/2026-05-09-w4/build-matrix-rerun.md` §1
  (current); `reports/porting/2026-05-09-unified/INDEX.md` (v0.1.0
  baseline: TBQ=8, QJL=15 on x86_64, Polar=4).

#### `linux-x64-cuda`

- **Build command:**
  ```bash
  cmake -B build-linux-x64-cuda \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
    -DGGML_CUDA=ON -DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON \
    -DCMAKE_CUDA_ARCHITECTURES="80;86;89;90" \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-cuda --target ggml-cuda llama-server -j 16
  ```
- **Expected exported symbols:** baseline CPU set (above) plus the
  CUDA TBQ template instances inherited from apothic
  (`mmq_tbq3_0`, `mmq_tbq4_0`, `fattn_vec_tbq3_0`,
  `fattn_vec_tbq4_0`, `dequantize_block_cuda<...,block_tbq{3,4}_0>`,
  `set_rows_cuda_quant<...,block_tbq{3,4}_0>`). QJL/Polar CUDA
  kernels are not yet ported — see `docs/porting/unified-fork-strategy.md` §D.
- **Verification command:**
  ```bash
  nm -D --defined-only build-linux-x64-cuda/bin/libggml-cuda.so |
    grep -E 'tbq.*kernel|fattn.*tbq' | wc -l   # measured 2026-05-09 (W3-D): 275 TBQ-named
  ```
- **Hardware required:** Linux x86_64 + NVIDIA GPU + CUDA toolkit
  ≥ 12.0. Self-hosted runner labels: `cuda-l4` (L4) or `cuda-a10`.
- **Reports:** `reports/porting/2026-05-09-w3/cuda-compile-only.md`
  (167/167 .cu compile pass on sm_80/86/89/90, 1.17 GB unstripped
  `libggml-cuda.so`); `reports/porting/2026-05-09-w4/build-matrix-rerun.md` §6.

#### `linux-x64-vulkan`

- **Build command (shaders only):**
  ```bash
  cd packages/inference/verify
  make vulkan-spirv GLSLC=$HOME/Android/Sdk/ndk/29.0.13113456/shader-tools/linux-x86_64/glslc
  ```
- **Build command (full ggml-vulkan):**
  ```bash
  cmake -B build-linux-x64-vulkan \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
    -DGGML_VULKAN=ON \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build build-linux-x64-vulkan --target ggml-vulkan llama-server
  ```
- **Expected SPIR-V artifacts:** 8 `.spv` files under
  `packages/inference/vulkan/`: `turbo3.spv`, `turbo4.spv`,
  `turbo3_tcq.spv`, `qjl.spv`, `qjl_get_rows.spv`, `qjl_mul_mv.spv`,
  `polar.spv`, `polar_get_rows.spv`. The fork's `ggml-vulkan.cpp`
  dispatcher does NOT yet wire the QJL/Polar Eliza-shaders; only the
  upstream quants + W1-D TBQ shaders run via the integrated backend.
- **Verification command:**
  ```bash
  ls packages/inference/vulkan/*.spv | wc -l   # measured 2026-05-09: 8
  VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
    packages/inference/verify/vulkan_verify \
    packages/inference/vulkan/turbo3.spv \
    packages/inference/verify/fixtures/turbo3.json
  # measured 2026-05-09 (W4-D): 0/8 PASS lavapipe, 0/8 PASS Intel ARL
  # — W4-A subgroup-size shader fix not yet landed
  ```
- **Hardware required:** Linux x86_64 + Vulkan ICD; GH-hosted
  `ubuntu-24.04` covers the SPIR-V compile, real GPU runtime
  needs a discrete card.
- **Reports:** `reports/porting/2026-05-09-w3/vulkan-compile-only.md`
  (8/8 compile + 0/8 runtime baseline); `reports/porting/2026-05-09-w4/build-matrix-rerun.md` §5.

#### `linux-arm64-cpu`

- **Build command (zig cross from x86_64 host):**
  ```bash
  node packages/app-core/scripts/aosp/compile-libllama.mjs \
    --abi arm64-v8a \
    --assets-dir /tmp/arm64-out \
    --src-dir ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0
  ```
- **Expected exported symbols:** baseline CPU set, plus
  `qjl_quantize_row_neon`, `qjl_quantize_rows_neon`,
  `qjl_dequantize_row_neon`, `qjl_score_qk_neon`,
  `qjl_score_one_neon`, `ggml_vec_dot_q4_polar_q8_0_fused_neon`.
- **Verification command:**
  ```bash
  /tmp/cross-tools/aarch64-linux-gnu-nm -D --defined-only \
    /tmp/arm64-out/arm64-v8a/libggml-cpu.so |
    grep -cE 'tbq|qjl|polar'    # measured 2026-05-09: 33
  qemu-aarch64-static -L /tmp/aarch64-sysroot \
    /tmp/qjl_neon_self_parity_aarch64    # measured 2026-05-09: 100/100 PASS
  qemu-aarch64-static -L /tmp/arm64-sysroot \
    /tmp/dlopen_parity_aarch64 .../libggml-cpu.so   # 100/100 PASS
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build +
  `qemu-aarch64-static` parity. Real device verification needs a
  Pixel/dev-board with an arm64 Linux userspace.
- **Reports:** `reports/porting/2026-05-09-w2/qjl-neon-cross.md`,
  `reports/porting/2026-05-09-w2/polar-neon-cross.md`,
  `reports/porting/2026-05-09-w4/qjl-arm64-rerun.txt`.

### macOS / iOS

| Cell | Status | Notes |
|---|---|---|
| `darwin-arm64-cpu` | `□ source-only` | The fork's Apple Silicon CPU path inherits upstream defaults; no Eliza-specific bring-up yet (NEON sources work, they just haven't been built on a Mac runner). **Hardware-blocked on this host.** |
| `darwin-arm64-metal` | `⚠ partial` | W3-G shipped a ready-to-run Apple-Silicon build kit with the .metal sources from W1-D vendored under `ggml/src/ggml-metal/eliza-kernels/`. Dispatcher wiring (`ggml-metal.metal` updates so TBQ/QJL/Polar route to the new shaders) is the next step. **Hardware-blocked on this host.** Intel Macs are not a supported target — Apple Silicon only. |
| `ios-arm64-metal` | `□ source-only` | Same `.metal` sources as `darwin-arm64-metal` plus the `LlamaCpp.xcframework` packaging at `packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch`. Needs Apple Silicon runner. |
| `ios-arm64-simulator-metal` | `□ source-only` | Same as `ios-arm64-metal` with `CMAKE_OSX_SYSROOT=iphonesimulator`. |

#### `darwin-arm64-metal`

- **Build command:**
  ```bash
  cmake -B build-darwin-arm64-metal \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
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
  `ggml/src/ggml-metal/eliza-kernels/` but are not dispatcher-wired.
- **Verification command:**
  ```bash
  ./packages/inference/verify/metal_verify \
    ggml/src/ggml-metal/eliza-kernels/turbo3.metal \
    kernel_turbo3_dot \
    packages/inference/verify/fixtures/turbo3.json
  ```
- **Hardware required:** Apple Silicon (M1/M2/M3/M4). Self-hosted
  runner label `apple-m3-pro`.
- **Reports:** W3-G ready-to-run kit (worktree-only, not yet on
  develop). Metal kernels staged in fork tree under
  `ggml/src/ggml-metal/eliza-kernels/`; dispatcher patch pending.

#### `ios-arm64-metal`

- **Build command:**
  ```bash
  cmake -B build-ios-arm64-metal \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
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
| `android-arm64-v8a-cpu+neon` | `⚠ partial` | **Measured 2026-05-09 (W4-D):** zig musl cross-build pass in 1m41s; 33 tbq/qjl/polar symbols (NEON variants confirmed). QEMU-user 100/100 self-parity + 100/100 fork dlopen parity. Real-hardware runtime (cuttlefish arm64 or a Pixel) hasn't run end-to-end yet. |
| `android-x86_64-cpu` | `⚠ partial` | Built by the fork-unifier on `2026-05-09`. Symbol parity to arm64 confirmed on the linux-x64-cpu cross (33/33 tbq/qjl/polar, AVX2 variants present). Cuttlefish AVD round-trip not on file. |
| `android-arm64-v8a-vulkan` | `✗ blocked` | Needs an Adreno/Mali Android device with a working Vulkan ICD; cuttlefish AVDs ship a SwiftShader Vulkan stub that is not representative. |

#### `android-arm64-v8a-cpu+neon`

- **Build command (zig cross from `compile-libllama.mjs`):**
  ```bash
  bun run --cwd packages/app-core scripts/aosp/compile-libllama.mjs \
    --abi arm64-v8a \
    --assets-dir apps/app/android/app/src/main/assets/agent/arm64-v8a
  ```
  (Update the script's `LLAMA_CPP_TAG` from `v0.2.0-eliza` to
  `v0.3.0-eliza` to pick up W3-B fused kernels — currently the script
  uses `--src-dir` override.)
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
    grep -cE 'tbq|qjl|polar'   # measured 2026-05-09: 33
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build.
  Real-device verification needs cuttlefish arm64 (KVM-required,
  self-hosted) or an `adb`-connected Pixel.
- **Reports:** `reports/porting/2026-05-09-unified/aosp-symbols-post.txt`,
  `reports/porting/2026-05-09-w2/qjl-neon-cross.md`,
  `reports/porting/2026-05-09-w4/qjl-arm64-rerun.txt`.

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
  vec-dot) instead of NEON. **W3-H caveat resolved:** the linux-x64-cpu
  build (which uses the same source) shows 33 tbq/qjl/polar symbols,
  matching the arm64 musl build. The pre-W3-H 15-vs-19 gap is closed.
- **Verification command:**
  ```bash
  $NDK/.../llvm-nm -D --defined-only \
    apps/app/android/app/src/main/assets/agent/x86_64/libggml-cpu.so |
    grep -E 'qjl_(quantize_row|score_qk)_avx2' | wc -l   # expect 2
  ```
- **Hardware required:** GH `ubuntu-24.04` for the cross-build.
  Cuttlefish x86_64 AVD for runtime.
- **Reports:** `reports/porting/2026-05-09-w4/build-matrix-rerun.md` §1
  (linux-x64-cpu uses identical sources).

#### `android-arm64-v8a-vulkan`

- **Build command:**
  ```bash
  cmake -B build-android-arm64-vulkan \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
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
| `windows-x64-cpu` | `⚠ partial` | **Measured 2026-05-09 (W4-D):** mingw-w64 cross-build pass in 2m37s; 6 PE32+ DLLs + 3 PE32+ EXEs; `ggml-base.dll` 27 tbq/qjl/polar exports + `ggml-cpu.dll` 31 exports. End-to-end runtime hasn't run on a real Windows box yet. |
| `windows-x64-cuda` | `□ source-only` | Needs CUDA on a Windows box (or cross-CUDA from Linux — non-trivial). |
| `windows-x64-vulkan` | `□ source-only` | Needs the Khronos Linux→Windows cross plus a Windows Vulkan ICD; documented as deferred in W3-F. |

#### `windows-x64-cpu`

- **Build command (mingw-w64 cross from Linux):**
  ```bash
  PATH=/path/to/mingw/bin:$PATH \
  ELIZA_DFLASH_LLAMA_CPP_REMOTE="https://github.com/elizaOS/llama.cpp.git" \
    node packages/app-core/scripts/build-llama-cpp-dflash.mjs \
      --target windows-x64-cpu --ref v0.3.0-eliza
  ```
- **Expected exported symbols:** `llama-server.exe`, `llama-cli.exe`,
  `llama-speculative-simple.exe`, `libllama.dll`, `libllama-common.dll`,
  `libmtmd.dll`, `ggml.dll`, `ggml-base.dll` (with QJL/Polar/TBQ
  ref + dispatch entries; W3-F's PE/COFF link-time fix moves the
  QJL definitions into ggml-base for Windows shared-lib builds),
  `ggml-cpu.dll` (with the AVX2 variants).
- **Verification command:**
  ```bash
  x86_64-w64-mingw32-objdump -p \
    ~/.eliza/local-inference/bin/dflash/windows-x64-cpu/ggml-cpu.dll |
    grep -E 'tbq|qjl|polar' | wc -l   # measured 2026-05-09: 31
  x86_64-w64-mingw32-objdump -p \
    ~/.eliza/local-inference/bin/dflash/windows-x64-cpu/ggml-base.dll |
    grep -E 'tbq|qjl|polar' | wc -l   # measured 2026-05-09: 27
  ```
- **Hardware required:** GH `windows-2022` for native MSVC, or
  `ubuntu-24.04` + mingw-w64 for the cross. Native runtime
  verification needs a Windows box.
- **Reports:** `reports/porting/2026-05-09-w3/windows-cross-build.md`,
  `reports/porting/2026-05-09-w4/build-matrix-rerun.md` §4.

#### `windows-x64-cuda`

- **Build command:**
  ```bash
  cmake -B build-windows-x64-cuda \
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
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
    -S ~/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
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

## Summary by status (measured 2026-05-09)

- **`✓ verified`:** `linux-x64-cpu`.
- **`⚠ partial`:** `linux-arm64-cpu`, `linux-x64-cuda`, `linux-x64-vulkan`,
  `darwin-arm64-metal`, `android-arm64-v8a-cpu+neon`, `android-x86_64-cpu`,
  `windows-x64-cpu`.
- **`□ source-only`:** `darwin-arm64-cpu`, `ios-arm64-metal`,
  `ios-arm64-simulator-metal`, `windows-x64-cuda`,
  `windows-x64-vulkan`.
- **`✗ blocked`:** `linux-arm64-vulkan`, `android-arm64-v8a-vulkan`.

## What this matrix replaces

The pre-fork-unifier era tracked artifact status across three
separate llama.cpp trees (`Apothic-AI/llama.cpp-1bit-turboquant`
for AOSP, `spiritbuun/buun-llama-cpp` for the host DFlash server,
upstream `node-llama-cpp@3.18.1` for desktop). Per-cell verification
required reading three different build scripts and reconciling
patch-application status by hand. After the fork unifier landed
(`reports/porting/2026-05-09-unified/INDEX.md`), every cell pulls
from the same `elizaOS/llama.cpp @ vX.Y.0-eliza` and the only
moving variable is the platform/ABI/backend. This file is the
canonical place for that table.
