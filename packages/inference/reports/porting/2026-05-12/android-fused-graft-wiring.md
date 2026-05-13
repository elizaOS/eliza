# Android `*-fused` omnivoice graft wiring — 2026-05-12

## Status

**Wired into `compile-libllama.mjs`. End-to-end verification is `--dry-run`
only on this box (no Android NDK installed; no Android hardware).** This
closes `.swarm/STATUS.md` FINALIZE-2 item 5 / genuinely-remaining #3 at the
source layer, leaves the on-hardware verify behind a documented operator
command.

## What changed

`packages/app-core/scripts/aosp/compile-libllama.mjs` now accepts an
explicit `--target <triple>` flag for any of the eight android targets the
dflash build script declares:

- `android-arm64-cpu`, `android-arm64-vulkan`
- `android-x86_64-cpu`, `android-x86_64-vulkan`
- `android-arm64-cpu-fused`, `android-arm64-vulkan-fused`
- `android-x86_64-cpu-fused`, `android-x86_64-vulkan-fused`

For the four `*-fused` triples the build flow runs the same omnivoice-fuse
graft as the desktop fused targets (`linux-x64-cpu-fused` et al.):

1. **Pre-cmake**: `prepareOmnivoiceFusion()` clones `omnivoice.cpp` into the
   cache root, strips its `ggml/` submodule, copies the `src/` + `tools/`
   sources into `<llamaCppRoot>/omnivoice/`, applies the qwen3-asr-mtmd
   compatibility patches.
2. **CMake graft**: `appendCmakeGraft()` appends the `omnivoice-core` +
   `libelizainference` + `llama-omnivoice-server` target block to
   `<llamaCppRoot>/CMakeLists.txt`, idempotent via the
   `# ELIZA-OMNIVOICE-FUSION-GRAFT-V1` sentinel.
3. **Configure**: `-DELIZA_FUSE_OMNIVOICE=ON` + `-DBUILD_SHARED_LIBS=ON`
   (from `fusedExtraCmakeFlags()`) flow into the cmake configure call.
4. **Build**: `fusedCmakeBuildTargets()` adds `omnivoice-core`,
   `elizainference`, `llama-omnivoice-server`, `llama-cli`,
   `llama-speculative-simple`, `llama-bench`, `llama-completion` on top of
   the standard `llama` + `llama-server` targets.
5. **Install**: `libelizainference.so` and `llama-omnivoice-server` land in
   the per-ABI asset dir alongside the existing `libllama.so` + `libggml*.so`
   + `llama-server` + `libeliza-llama-shim.so` artifacts.
6. **Post-build verify**: `verifyFusedSymbols()` asserts the installed
   `libelizainference.so` exports `llama_*`, `ov_*`, and the
   `eliza_inference_*` ABI v3 surface; on a half-fused artifact the script
   hard-errors out per AGENTS.md §3.

The non-fused triples (`android-arm64-cpu`, …) take the same code path with
empty `extraCmakeFlags` / `extraBuildTargets`, so their behavior is
byte-for-byte identical to the legacy `--abi <ABI>` bulk-build entry point.

A new `--dry-run` flag prints the resolved plan (zig target triple, cmake
invocation, graft steps, expected output layout, verify step) without
touching the filesystem or invoking the NDK.

## Operator command (NDK-bearing box)

```bash
# 1. Install the NDK.
#    Linux: sdkmanager "ndk;27.0.12077973"  (or unzip a side-tarball into
#           ~/Android/Sdk/ndk/<version>/)
#    macOS: brew install --cask android-ndk
#    The compile-libllama.mjs script resolves the NDK via the same shape the
#    dflash build script does — $ANDROID_NDK_HOME / $ANDROID_NDK_ROOT /
#    $ANDROID_NDK, or `~/Android/Sdk/ndk/<newest>`.

export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/27.0.12077973

# 2. End-to-end build for one fused triple.
cd /home/shaw/milady/eliza
bun run node packages/app-core/scripts/aosp/compile-libllama.mjs \
  --target android-x86_64-cpu-fused \
  --jobs 8

# 3. The post-build symbol verify will assert llama_* + ov_* + eliza_inference_*
#    co-residency in `libelizainference.so`. On a half-fused artifact the
#    script exits non-zero with the exact missing symbol(s).

# 4. Repeat for the other three fused triples:
for t in android-arm64-cpu-fused android-arm64-vulkan-fused android-x86_64-vulkan-fused; do
  bun run node packages/app-core/scripts/aosp/compile-libllama.mjs --target "$t" --jobs 8
done
```

`--dry-run` works on every box (no NDK or zig required) and prints the full
plan so a code review can audit the cmake invocation + graft steps without
running the toolchain.

## Local `--dry-run` verification (this box, 2026-05-12)

```
$ node packages/app-core/scripts/aosp/compile-libllama.mjs --target android-x86_64-cpu-fused --dry-run
[compile-libllama] (dry-run) skipping zig toolchain probe
[compile-libllama] (dry-run) target=android-x86_64-cpu-fused
  zig-target=x86_64-linux-musl android-abi=x86_64
  src=/home/shaw/.cache/eliza-android-agent/llama-cpp-v1.1.0-eliza
  build=/home/shaw/.cache/eliza-android-agent/llama-cpp-v1.1.0-eliza/build-x86_64
  install=/home/shaw/milady/apps/app/android/app/src/main/assets/agent/x86_64
  graft:
    prepareOmnivoiceFusion llamaCppRoot=/home/shaw/.cache/eliza-android-agent/llama-cpp-v1.1.0-eliza
    appendCmakeGraft -> /home/shaw/.cache/eliza-android-agent/llama-cpp-v1.1.0-eliza/CMakeLists.txt
  cmake -S … -B build-x86_64 … -DELIZA_FUSE_OMNIVOICE=ON -DBUILD_SHARED_LIBS=ON
  cmake --build build-x86_64 --target llama-server llama-cli llama-speculative-simple
        llama-bench llama-completion omnivoice-core elizainference
        llama-omnivoice-server -j 8
  expected output layout under …/agent/x86_64:
    libllama.so libggml*.so llama-server libeliza-llama-shim.so
    libelizainference.so llama-omnivoice-server (omnivoice-fuse artifacts)
  verifyFusedSymbols outDir=…/agent/x86_64 target=android-x86_64-cpu-fused (post-build)
  fused-graft cacheRoot=/home/shaw/.cache/eliza-android-agent (omnivoice.cpp clone)
[compile-libllama] (dry-run) plan complete: 1 target(s) (cache … (would clone v1.1.0-eliza)).
```

The same `--dry-run` is the gating check in
`packages/app-core/scripts/aosp/compile-libllama-fused.test.mjs` (10 tests,
all PASS via `node --test`).

## Toolchain note (zig vs the NDK)

`compile-libllama.mjs` deliberately uses `zig cc --target=<arch>-linux-musl`
instead of the regular NDK clang for libllama itself — the AOSP-bound APK
ships a self-contained bun-on-Android process that loads everything via the
Alpine musl loader, and NDK-clang-built ELFs depend on bionic symbols the
musl loader does not expose. That decision is unchanged here: the fused
graft is toolchain-agnostic (CMake snippet + source layout), and the
resulting `libelizainference.so` inherits the same musl ABI.

The NDK is still required because the omnivoice graft pulls in
`tools/mtmd/` (multimodal tokenizer), `examples/`, and headers that
transitively `#include <android/log.h>` / NDK API headers when
`__ANDROID__` is defined. We rely on the NDK sysroot for those — provided
via the standard environment variables — even though the actual compiler
front-end is zig. The script will hard-error if those headers are missing
at configure time rather than silently producing a non-Android artifact.

## What is left for a hardware-bearing run

- A real `--target android-x86_64-cpu-fused` end-to-end build on a box with
  zig 0.13+, an Android NDK ≥ r27, and the v1.1.0-eliza fork pin
  initialized in `packages/inference/llama.cpp`.
- `verifyFusedSymbols` PASS against the installed `libelizainference.so`
  (asserts `llama_*` + `ov_*` + `eliza_inference_*` ABI v3 exports, plus
  `DT_NEEDED libllama.so` on `libelizainference.so`).
- Cuttlefish/AVD `libelizainference.so` mmap smoke proving the fused
  artifact loads under the musl loader.
- Pixel-class device run of `voice:duet --backend android` once the bundle
  publishing path adds an android-fused channel.

## References

- Wiring: `packages/app-core/scripts/aosp/compile-libllama.mjs`
  (`mainTargets`, `applyOmnivoiceGraft`, `describeAndroidTargetDryRun`,
  `parseAndroidTarget`).
- Tests: `packages/app-core/scripts/aosp/compile-libllama-fused.test.mjs`.
- Graft pieces (shared with the dflash build path):
  - `packages/app-core/scripts/omnivoice-fuse/prepare.mjs`
  - `packages/app-core/scripts/omnivoice-fuse/cmake-graft.mjs`
  - `packages/app-core/scripts/omnivoice-fuse/verify-symbols.mjs`
- Reference build script for the dflash side:
  `packages/app-core/scripts/build-llama-cpp-dflash.mjs` (search for
  `linux-x64-cpu-fused`).
