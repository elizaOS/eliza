/**
 * Defines the runtime artifacts and CMake flags for a fused OmniVoice build.
 * The implementation lives inside the pinned llama.cpp tree; Android build
 * orchestration consumes these helpers to produce one self-contained inference
 * library plus the local speculative-decode server.
 */

/**
 * Runtime artifacts for a fused Android build. CMake already follows the
 * complete dependency graph beneath `elizainference` (including llama, ggml,
 * Kokoro, and OmniVoice static libraries), so naming its private libraries and
 * developer CLIs separately only rebuilds the graph and cross-links binaries
 * that are never packaged. `llama-server` remains explicit because the AOSP
 * speculative-decode process launches it alongside the JNI inference library.
 */
export function fusedCmakeBuildTargets() {
  return ["llama-server", "elizainference"];
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
 * hook fold kokoro_lib into elizainference (ABI v15) when the fused build runs
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
