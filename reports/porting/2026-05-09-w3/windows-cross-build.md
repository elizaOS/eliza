# Wave 3 — F: Windows x86_64 cross-build

Owner: Wave-3 agent F. Date: 2026-05-09. Worktree branch: `worktree-agent-afda9c538e1350677`.

## Goal

Add Windows x86_64 cross-build support to the eliza llama.cpp build pipeline so CI ships Windows DLLs without needing a Windows runner. Today the script (`packages/app-core/scripts/build-llama-cpp-dflash.mjs`) handles linux/darwin/android/ios but treats `windows-x64-cpu` and `windows-x64-cuda` as host-only or `MINGW_TOOLCHAIN_FILE`-only paths — neither works on a stock Linux dev box.

## Scope landed

1. **Toolchain probe + auto-wire (no operator config required).** New `findMingwToolchain()` searches `ELIZA_MINGW_PREFIX`, then PATH, then `~/.local/x86_64-w64-mingw32/usr/bin/`. When found, `writeMingwToolchainFile()` materializes a CMake toolchain file under `~/.cache/eliza-dflash/mingw-toolchain/mingw-x86_64.cmake` and a force-included shim header (`eliza-mingw-win-shim.h`) that backports the Win8+ `THREAD_POWER_THROTTLING_STATE` typedef missing from mingw-w64 11.0 headers.
2. **`windows-x64-cpu` cross-build path.** `cmakeFlagsForTarget()` for `platform=windows`/`backend=cpu` now passes the toolchain file, `-DLLAMA_CURL=OFF`, `-DBUILD_SHARED_LIBS=ON`, and the AVX/AVX2/FMA/F16C flags so the Windows CPU baseline matches Linux.
3. **PE/COFF QJL link fix.** `patchGgmlBaseForWindowsQjl()` rewrites `ggml/src/CMakeLists.txt` to compile `ggml-cpu/qjl/*.c` into ggml-base on Windows shared-lib builds. The fork's `ggml.c` references QJL symbols defined in ggml-cpu via the type-traits table; ELF resolves these at runtime via DT_NEEDED, but PE/COFF requires every imported symbol to resolve at link time, so without this patch `ggml-base.dll` fails with `undefined reference to quantize_qjl1_256`.
4. **`isRuntimeLibrary()` accepts mingw DLL naming.** mingw produces `ggml.dll` / `ggml-base.dll` / `ggml-cpu.dll` (no `lib` prefix) alongside `libllama.dll` / `libmtmd.dll`. The installer regex now accepts plain `*.dll` so all six DLLs land in the output dir.
5. **CI matrix entry.** `.github/workflows/local-inference-bench.yml` adds a `windows-cross-build` job that installs Ubuntu's mingw-w64 packages, runs the cross-build, verifies the expected ggml + TBQ + QJL + Polar exports, and uploads the artifact dir as `dflash-windows-x64-cpu-<run_id>`. Optional wine smoke is gated behind `ELIZA_DFLASH_RUN_WINE_SMOKE=1` (off by default — wine isn't on `ubuntu-24.04` and we don't want to pay the install cost on every run).
6. **`scripts/benchmark/configs/host-windows-x64.json`.** New benchmark profile mirroring `host-cpu.json` for Windows-targeted runs (lower iteration count to absorb the wine / remote-runner latency surcharge).

## Out of scope (explicitly deferred)

- **MSVC native build.** mingw-w64's PE output is binary-compatible with the Microsoft loader, so we ship that. MSVC remains an option if a downstream consumer turns up a real ABI mismatch.
- **WSL / Windows-VM functional test.** Host doesn't have one; we settle for "binaries link, exports verified, optional wine --help smoke" in CI.
- **Windows ARM64.** Separate target (`windows-arm64-cpu`) if needed; mingw-w64 cross to ARM64 isn't on the Ubuntu repos.
- **`windows-x64-vulkan`.** Vulkan SDK has a Windows-cross story via lunarg's Linux SDK + the Khronos `Vulkan-Headers` repo we already fetch for Linux Vulkan, but the fork's `ggml-vulkan.cpp` would also need a glslc that emits SPIR-V for Windows-bound DLLs and we'd need a wine-equivalent ICD loader to verify. Not landed; documented here so the next agent can pick it up.
- **`windows-x64-cuda`.** Requires nvcc on the host — separate path.

## Toolchain

| Component | Version | Source |
|---|---|---|
| Cross gcc / g++ | `13-posix` (gcc 13.2.0) | Ubuntu 24.04 `g++-mingw-w64-x86-64-posix` (.deb extracted to `~/.local/x86_64-w64-mingw32/`) |
| binutils | 2.41.90.20240122 | Ubuntu 24.04 `binutils-mingw-w64-x86-64` |
| mingw-w64 headers / libs | 11.0.1 | Ubuntu 24.04 `mingw-w64-x86-64-dev` |
| CMake | 3.28.3 | Ubuntu 24.04 `cmake` |

Host running this: Ubuntu 24.04.4 LTS, no root access (`sudo` blocked), so the .debs were `dpkg-deb -x`-extracted into `~/.local/x86_64-w64-mingw32/`. The script's `findMingwToolchain()` finds them there automatically. CI gets the same packages via `apt-get install` because GitHub runners do have root.

The mingw-w64 11.0 headers don't ship `THREAD_POWER_THROTTLING_STATE` (Win8+) even though `_WIN32_WINNT` resolves to `0x0a00` (Win10). cpp-httplib in `vendor/cpp-httplib/` hard-requires `_WIN32_WINNT >= 0x0A00` and uses `CreateFile2`; bumping `WINVER` to `0x0A00` triggers `ggml-cpu.c`'s `#if _WIN32_WINNT >= 0x0602` throttling-state branch. The script's `eliza-mingw-win-shim.h` provides the missing typedef inline; the actual `SetThreadInformation` API is in kernel32.dll on every Win8+ host so the resulting binary works at runtime.

## Build commands

The script invocation:

```bash
# Default fork (spiritbuun/buun-llama-cpp master):
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target windows-x64-cpu

# elizaOS/llama.cpp v0.1.0-eliza (the fork the AOSP path consumes; this
# is what the CI matrix uses so the symbols match downstream consumers):
ELIZA_DFLASH_LLAMA_CPP_REMOTE="https://github.com/elizaOS/llama.cpp.git" \
  node packages/app-core/scripts/build-llama-cpp-dflash.mjs \
    --target windows-x64-cpu \
    --ref v0.1.0-eliza
```

Effective cmake invocation (auto-emitted by the script):

```
cmake -B <cache>/build/windows-x64-cpu \
  -DCMAKE_TOOLCHAIN_FILE=<cache>/mingw-toolchain/mingw-x86_64.cmake \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=ON \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_CURL=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=OFF -DGGML_CUDA=OFF -DGGML_HIP=OFF -DGGML_VULKAN=OFF
cmake --build <cache>/build/windows-x64-cpu \
  --target llama-server llama-cli llama-speculative-simple -j 16
```

Build wall time on a 16-core dev box: ~110s clean, ~25s cached. CI is allotted 30 minutes which is conservative.

## Artifacts (elizaOS/llama.cpp v0.1.0-eliza, commit edd55d8)

Output dir: `$ELIZA_STATE_DIR/local-inference/bin/dflash/windows-x64-cpu/`.

| File | Type | Size |
|---|---|---|
| `ggml.dll` | PE32+ DLL | 160,190 B (~157 KB) |
| `ggml-base.dll` | PE32+ DLL | 1,059,038 B (~1.0 MB) |
| `ggml-cpu.dll` | PE32+ DLL | 1,421,531 B (~1.4 MB) |
| `libllama.dll` | PE32+ DLL | 3,896,606 B (~3.7 MB) |
| `libllama-common.dll` | PE32+ DLL | 6,318,332 B (~6.0 MB) |
| `libmtmd.dll` | PE32+ DLL | 1,251,093 B (~1.2 MB) |
| `llama-server.exe` | PE32+ EXE | 8,238,440 B (~7.9 MB) |
| `llama-cli.exe` | PE32+ EXE | 6,540,256 B (~6.2 MB) |
| `llama-speculative-simple.exe` | PE32+ EXE | 5,287,847 B (~5.0 MB) |
| `CAPABILITIES.json` | JSON | 502 B |

All produced by `x86_64-w64-mingw32-gcc 13-posix` + `x86_64-w64-mingw32-g++ 13-posix`. `file(1)` reports each as `PE32+ executable (...) x86-64, for MS Windows`.

The `lib*.dll` vs `*.dll` split is just CMake's default OUTPUT_NAME for shared libs (no `lib` prefix is added when the original target name already starts with `lib`). All six DLLs are equal-citizens at runtime and the `isRuntimeLibrary()` install regex accepts both forms.

## Symbol verification

Per `x86_64-w64-mingw32-objdump -p`'s `[Ordinal/Name Pointer] Table` (the canonical PE export listing). All required symbols verified present:

### Standard ggml — `ggml-base.dll`

- `ggml_init`, `ggml_new_tensor`, `ggml_new_tensor_1d`, `ggml_new_tensor_2d`, `ggml_new_tensor_3d`, `ggml_new_tensor_4d` — all OK.

### TBQ (TurboQuant V-cache) — `ggml-base.dll`

- `quantize_row_tbq3_0_ref`, `quantize_row_tbq4_0_ref` — OK.
- `dequantize_row_tbq3_0`, `dequantize_row_tbq4_0` — OK.
- `quantize_tbq3_0`, `quantize_tbq4_0` — OK (the bulk-quantize entries `ggml_quantize_chunk` dispatches to).

### QJL (1-bit JL-transform K-cache) — split

- `ggml-base.dll`: `quantize_row_qjl1_256_ref`, `dequantize_row_qjl1_256`, `quantize_qjl1_256` — OK (moved from ggml-cpu by the Windows-only patch).
- `ggml-cpu.dll`: `qjl_quantize_row_avx2`, `qjl_score_qk_avx2`, `ggml_compute_forward_attn_score_qjl` — OK.
- NEON variants (`qjl_quantize_row_neon`, `qjl_score_qk_neon`) are intentionally absent: their source files are guarded by `#if defined(__ARM_NEON)`. Cross-builds for x86_64 don't compile them and the AVX2 path is what runs on x86_64 hosts. The ARM64 Windows path (out of scope here) would pick up the NEON variants.

### PolarQuant (4-bit weight quant) — split

- `ggml-base.dll`: `quantize_row_q4_polar_ref`, `dequantize_row_q4_polar`, `quantize_q4_polar` — OK.
- `ggml-cpu.dll`: `ggml_vec_dot_q4_polar_q8_0` — OK (the dot kernel called by the matmul reduction).

### Aggregate export counts

```
ggml-base.dll                     791 exports     1,059,038 bytes
ggml-cpu.dll                      547 exports     1,421,531 bytes
ggml.dll                           64 exports       160,190 bytes
libllama-common.dll             3,295 exports     6,318,332 bytes
libllama.dll                    2,817 exports     3,896,606 bytes
libmtmd.dll                       374 exports     1,251,093 bytes
```

The CI workflow re-runs the same checks via the `Verify exported symbols` step and fails the job loudly if any required symbol regresses.

## Known limitations + follow-up work

1. **PE/COFF QJL link-time fix is a build-side patch, not a fork-side fix.** `patchGgmlBaseForWindowsQjl()` mutates `ggml/src/CMakeLists.txt` in the cached checkout to compile `ggml-cpu/qjl/*.c` into `ggml-base.dll`. The right fix lives upstream in `elizaOS/llama.cpp`: either move the QJL definitions into ggml-base (matches where TBQ already lives), or wire the type-traits table through a registration callback that ggml-cpu fills in at backend-load time. When that lands, the patch becomes a no-op and can be removed. Tracker: `TODO(elizaOS/llama.cpp)` comment in the patch function.
2. **mingw-w64 11.0 vs Win10 SDK gap.** The shim header (`eliza-mingw-win-shim.h`) papers over `THREAD_POWER_THROTTLING_STATE`. If a future fork rev pulls in another Win10-only API the shim doesn't cover, the build will fail loud and the shim needs an addition. Documented inline.
3. **CUDA path still unwired.** `windows-x64-cuda` remains "host-only or MINGW_TOOLCHAIN_FILE" in `targetCompatibility()`. Cross-CUDA from Linux is theoretically possible (nvcc + cudart_static.lib + the Windows kernel32 import lib) but not in scope here.
4. **wine smoke is opt-in.** `ubuntu-24.04` doesn't ship `wine-stable` and installing it bloats the runtime by ~5min. The job uploads artifacts unconditionally; consumers can wine-test downstream. To turn the smoke on, set `ELIZA_DFLASH_RUN_WINE_SMOKE=1` on the workflow (and add `apt-get install wine64` to the install step).
5. **Vulkan path unwired.** `windows-x64-vulkan` is documented above as deferred. A Linux→Windows Vulkan cross would need `Vulkan-Headers` (already fetched in `safelyPrepareVulkanHeaders()`), `glslc` (already on PATH after `apt-get install glslc`), and a Windows-bound `vulkan-1.lib` import lib. The hard part is verification: there's no software-Vulkan ICD that runs PE binaries under wine (Mesa lavapipe is Linux-native).

## Files changed

- `packages/app-core/scripts/build-llama-cpp-dflash.mjs` — added `findMingwToolchain()`, `writeMingwToolchainFile()`, `mingwToolchainCacheDir()`, `patchGgmlBaseForWindowsQjl()`; wired the `platform=windows` branch in `cmakeFlagsForTarget()` to consume the toolchain + emit the right cmake flags; widened `isRuntimeLibrary()` to accept plain `*.dll` (no `lib` prefix); plumbed `ctx.mingwToolchainFile` through `build()` so single-target invocations skip mingw probing when no Windows target is queued.
- `scripts/benchmark/configs/host-windows-x64.json` — new file; mirrors `host-cpu.json` for Windows-targeted runs.
- `.github/workflows/local-inference-bench.yml` — added `windows-cross-build` job; widened the PR-trigger paths to include the build script so a script edit triggers the cross-build CI; added `run_windows_cross_build` workflow_dispatch input.
- `reports/porting/2026-05-09-w3/windows-cross-build.md` — this file.
