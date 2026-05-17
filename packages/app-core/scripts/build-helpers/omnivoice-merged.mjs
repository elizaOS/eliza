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
    "omnivoice_lib",
    "elizainference",
    "omnivoice-tts",
    "omnivoice-codec",
  ];
}

/**
 * CMake flags a fused build must add on top of the per-target defaults.
 * `ELIZA_FUSE_OMNIVOICE=ON` is redirected by the fork's root CMakeLists.txt
 * to `LLAMA_BUILD_OMNIVOICE=ON` so both source-level guards
 * (`#ifdef ELIZA_FUSE_OMNIVOICE` and `#ifdef LLAMA_BUILD_OMNIVOICE`) light up.
 */
export function fusedExtraCmakeFlags() {
  return [
    "-DLLAMA_BUILD_OMNIVOICE=ON",
    "-DOMNIVOICE_SHARED=ON",
    "-DBUILD_SHARED_LIBS=ON",
  ];
}
