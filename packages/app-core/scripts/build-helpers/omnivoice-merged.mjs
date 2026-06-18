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
 */
export function fusedExtraCmakeFlags() {
  return [
    "-DELIZA_FUSE_OMNIVOICE=ON",
    "-DLLAMA_BUILD_OMNIVOICE=ON",
    "-DOMNIVOICE_SHARED=ON",
    "-DBUILD_SHARED_LIBS=ON",
  ];
}
