/**
 * Merged-path OmniVoice build helpers.
 *
 * H2.c collapsed the W3-3 deprecation runway: the legacy graft path
 * (`OMNIVOICE_INSIDE_LLAMA_CPP=0` + `omnivoice-fuse/{prepare,cmake-graft}.mjs`)
 * is removed and the only supported path is the in-fork merged tree at
 * `plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/`.
 *
 * This module exposes the two surfaces the build script needs:
 *   - `fusedCmakeBuildTargets()` — the target list passed to
 *     `cmake --build … --target …` for a fused build.
 *   - `fusedExtraCmakeFlags()` — the `-D…=…` flags a fused build adds on
 *     top of the per-target defaults.
 */

/**
 * Names of CMake build targets the fused build produces. The merged tree
 * at `tools/omnivoice/CMakeLists.txt` declares all of these directly; no
 * graft is required.
 */
export function fusedCmakeBuildTargets() {
  return [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
    "llama-mtmd-cli",
    "llama-bench",
    "llama-completion",
    "omnivoice_lib",
    // kokoro_lib (STATIC) is folded into elizainference (ABI v10). It must
    // build before elizainference links so the `if(TARGET kokoro_lib)` fold in
    // tools/omnivoice/CMakeLists.txt picks it up. Listed as a build target so
    // the cross-compile path (LLAMA_BUILD_TOOLS=ON → kokoro from tools/) emits
    // the archive; auxiliary, so a checkout without it is warned-and-skipped
    // rather than fatal (verify-fused-symbols gates the real presence check).
    "kokoro_lib",
    "elizainference",
    "omnivoice-tts",
    "omnivoice-codec",
  ];
}

/**
 * CMake flags a fused build must add on top of the per-target defaults.
 * The fused lib `elizainference` (libelizainference.so — the TTS+ASR+LLM
 * artifact the APK bundles) is guarded by `if(ELIZA_FUSE_OMNIVOICE)` in the
 * fork's root CMakeLists.txt, while the omnivoice TTS subtree (and its CLI
 * drivers) is guarded by `LLAMA_BUILD_OMNIVOICE`. The pinned fork has NO
 * redirect wiring one flag to the other, so BOTH must be set explicitly —
 * with only `LLAMA_BUILD_OMNIVOICE` the `elizainference` target is never
 * defined and `cmake --build --target elizainference` silently no-ops, which
 * is exactly why x86_64 shipped without libelizainference.so.
 *
 * Self-contained static fuse (device-proven on a real Pixel, arm64/bionic):
 *   - `BUILD_SHARED_LIBS=OFF` makes llama/ggml/mtmd build as STATIC `.a`
 *     archives instead of shared `.so` files.
 *   - `CMAKE_POSITION_INDEPENDENT_CODE=ON` compiles those `.a`s with -fPIC so
 *     they fold cleanly into the still-SHARED libelizainference.so.
 *   - `elizainference` and `omnivoice` are declared with an explicit
 *     `add_library(... SHARED ...)` in tools/omnivoice/CMakeLists.txt, so they
 *     stay shared `.so` even under BUILD_SHARED_LIBS=OFF.
 *   The net result is ONE self-contained libelizainference.so whose only
 *   DT_NEEDED entries are libc/libm/libdl — no libllama.so / libggml*.so
 *   runtime siblings to stage or resolve via LD_LIBRARY_PATH.
 *
 * `LLAMA_BUILD_KOKORO=ON` makes the fork's root-CMakeLists embed-as-library
 * hook fold kokoro_lib into elizainference (ABI v10) when the fused build runs
 * with LLAMA_BUILD_TOOLS=OFF (the bionic JNI path). On the cross-compile path
 * (compile-libllama.mjs) LLAMA_BUILD_TOOLS defaults ON, so kokoro is added by
 * tools/CMakeLists.txt instead; verify-fused-symbols.mjs gates the resulting
 * libelizainference.so on the eliza_inference_kokoro_* exports so a kokoro-less
 * fuse fails the build rather than shipping silently.
 */
export function fusedExtraCmakeFlags() {
  return [
    "-DELIZA_FUSE_OMNIVOICE=ON",
    "-DLLAMA_BUILD_OMNIVOICE=ON",
    "-DOMNIVOICE_SHARED=ON",
    "-DLLAMA_BUILD_KOKORO=ON",
    // Static-fuse: llama/ggml/mtmd → .a archives folded into the still-SHARED
    // libelizainference.so. Appended after the base configure flags, so this
    // overrides the earlier `-DBUILD_SHARED_LIBS=ON` the non-fused libllama
    // configure line emits (CMake last `-D` wins).
    "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  ];
}
