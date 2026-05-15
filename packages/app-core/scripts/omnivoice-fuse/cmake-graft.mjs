/**
 * Append a CMake graft block to llama.cpp's root CMakeLists.txt that
 * declares `omnivoice-core` (static archive over the grafted sources)
 * and the fused output targets:
 *
 *   - `omnivoice-core`         — static lib over omnivoice/src/*.cpp
 *   - `llama-omnivoice-server` — small executable smoke target kept for
 *                                symbol verification and manual OmniVoice
 *                                checks.
 *   - `libelizainference`      — fused shared library used by the desktop
 *                                + mobile bridges. Exposes both `llama_*`
 *                                and `omnivoice_*` exports.
 *
 * Idempotent: a sentinel marker in CMakeLists.txt prevents double-append.
 *
 * The product HTTP route fusion lives in
 * `kernel-patches/server-omnivoice-route.mjs`: it mounts
 * `POST /v1/audio/speech` onto the fused `llama-server` and this graft links
 * that server target against `omnivoice-core`. The legacy
 * `llama-omnivoice-server` remains only as a small co-residency smoke target.
 */

import fs from "node:fs";
import path from "node:path";

import { OMNIVOICE_GRAFT_SUBDIR } from "./prepare.mjs";

const SENTINEL = "# ELIZA-OMNIVOICE-FUSION-GRAFT-V1";

// CMake snippet appended verbatim to llama.cpp's root CMakeLists.txt.
// Indentation is intentional — it's read out of CMakeLists.txt as-is.
function buildGraftSnippet() {
  return `

${SENTINEL}
# ----------------------------------------------------------------------
# Source-level fusion of github.com/ServeurpersoCom/omnivoice.cpp into
# this build tree. See packages/app-core/scripts/omnivoice-fuse/README.md
# for the strategy. The omnivoice sources were copied into ${OMNIVOICE_GRAFT_SUBDIR}/
# by prepare.mjs and intentionally do NOT bring their own ggml — they
# share llama.cpp's vendored ggml.
# ----------------------------------------------------------------------

if(ELIZA_FUSE_OMNIVOICE)
    find_package(Threads REQUIRED)

    # Audio tokenizer tensor names exceed default GGML_MAX_NAME of 64.
    # Mirrored from omnivoice's own CMakeLists.txt.
    add_compile_definitions(GGML_MAX_NAME=128)
    foreach(_eliza_ggml_max_name_target
            ggml ggml-base ggml-cpu ggml-blas ggml-metal ggml-vulkan ggml-cuda
            llama common mtmd server-context)
        if(TARGET \${_eliza_ggml_max_name_target})
            target_compile_definitions(\${_eliza_ggml_max_name_target}
                PUBLIC GGML_MAX_NAME=128)
        endif()
    endforeach()

    file(GLOB ELIZA_OMNIVOICE_SOURCES
        CONFIGURE_DEPENDS
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src/*.cpp)
    file(GLOB ELIZA_OMNIVOICE_HEADERS
        CONFIGURE_DEPENDS
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src/*.h)

    if(NOT ELIZA_OMNIVOICE_SOURCES)
        message(FATAL_ERROR "ELIZA_FUSE_OMNIVOICE=ON but no sources under ${OMNIVOICE_GRAFT_SUBDIR}/src/")
    endif()

    add_library(omnivoice-core STATIC \${ELIZA_OMNIVOICE_SOURCES})
    target_compile_definitions(omnivoice-core PUBLIC OMNIVOICE_STATIC)
    target_compile_features(omnivoice-core PUBLIC cxx_std_17)
    target_include_directories(omnivoice-core PUBLIC
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_SOURCE_DIR}/tools/mtmd
        \${CMAKE_CURRENT_SOURCE_DIR}/include
        \${CMAKE_CURRENT_BINARY_DIR})
    # Share llama.cpp's ggml. NEVER add a second add_subdirectory(ggml)
    # from the omnivoice tree — see the README's reconciliation
    # strategy for why.
    target_include_directories(omnivoice-core SYSTEM PUBLIC
        \${CMAKE_CURRENT_SOURCE_DIR}/ggml/include)
    target_link_libraries(omnivoice-core PUBLIC llama mtmd ggml Threads::Threads)
    if(TARGET ggml-base)
        target_link_libraries(omnivoice-core PUBLIC ggml-base)
    endif()
    foreach(_eliza_backend cpu blas cuda metal vulkan)
        if(TARGET ggml-\${_eliza_backend})
            get_target_property(_eliza_btype ggml-\${_eliza_backend} TYPE)
            if(NOT _eliza_btype STREQUAL "MODULE_LIBRARY")
                target_link_libraries(omnivoice-core PUBLIC ggml-\${_eliza_backend})
            endif()
        endif()
    endforeach()

    # Fused shared library exporting both \`llama_*\` and \`omnivoice_*\`.
    # Used by Electrobun + Capacitor bridges that dlopen one artifact.
    add_library(elizainference SHARED
        \${ELIZA_OMNIVOICE_SOURCES})
    target_compile_definitions(elizainference PRIVATE OMNIVOICE_BUILD)
    target_compile_features(elizainference PUBLIC cxx_std_17)
    target_include_directories(elizainference PUBLIC
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_SOURCE_DIR}/tools/mtmd
        \${CMAKE_CURRENT_SOURCE_DIR}/include
        \${CMAKE_CURRENT_BINARY_DIR})
    target_include_directories(elizainference SYSTEM PUBLIC
        \${CMAKE_CURRENT_SOURCE_DIR}/ggml/include)
    target_link_libraries(elizainference PUBLIC llama mtmd)
    if(APPLE)
        target_link_options(elizainference PRIVATE
            "LINKER:-reexport_library,$<TARGET_FILE:llama>")
    endif()
    target_link_libraries(elizainference PUBLIC ggml Threads::Threads)
    if(TARGET ggml-base)
        target_link_libraries(elizainference PUBLIC ggml-base)
    endif()
    foreach(_eliza_backend cpu blas cuda metal vulkan)
        if(TARGET ggml-\${_eliza_backend})
            get_target_property(_eliza_btype ggml-\${_eliza_backend} TYPE)
            if(NOT _eliza_btype STREQUAL "MODULE_LIBRARY")
                target_link_libraries(elizainference PUBLIC ggml-\${_eliza_backend})
            endif()
        endif()
    endforeach()
    set_target_properties(elizainference PROPERTIES
        OUTPUT_NAME elizainference
        POSITION_INDEPENDENT_CODE ON)

    # The fused HTTP server IS \`llama-server\`. The kernel-patch
    # \`server-omnivoice-route.mjs\` adds a \`POST /v1/audio/speech\` route to
    # tools/server/server.cpp, guarded by \`#ifdef ELIZA_FUSE_OMNIVOICE\`,
    # backed by omnivoice-core's \`ov_synthesize\`. So the same process that
    # serves \`/completion\` + \`/v1/chat/completions\` + the DFlash spec loop
    # also serves TTS — one process, one llama.cpp build, one GGML pin
    # (packages/inference/AGENTS.md §4). We link omnivoice-core into the
    # \`llama-server\` target and put the route define + omnivoice headers on
    # it. The non-fused build is untouched (this whole block is inside
    # \`if(ELIZA_FUSE_OMNIVOICE)\`).
    if(TARGET llama-server)
        target_link_libraries(llama-server PRIVATE omnivoice-core)
        target_include_directories(llama-server PRIVATE
            \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src
            \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR})
        # Match the rest of the fused build's ggml_tensor layout (the
        # foreach above bumps GGML_MAX_NAME on every other target);
        # omnivoice-core was compiled the same way, so the static link is
        # ABI-consistent.
        target_compile_definitions(llama-server PRIVATE
            ELIZA_FUSE_OMNIVOICE GGML_MAX_NAME=128)
    endif()

    # Legacy \`llama-omnivoice-server\` placeholder kept ONLY so the symbol
    # verifier can still confirm both symbol families are co-resident in an
    # executable, and so an operator who scripted the old binary name still
    # gets a working OmniVoice CLI. The real merged HTTP route lives in
    # \`llama-server\` above; spawn that, not this.
    if(EXISTS \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/tools/omnivoice-tts.cpp)
        add_executable(llama-omnivoice-server
            \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/tools/omnivoice-tts.cpp)
        target_include_directories(llama-omnivoice-server PRIVATE
            \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src
            \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
            \${CMAKE_CURRENT_BINARY_DIR})
        target_compile_features(llama-omnivoice-server PRIVATE cxx_std_17)
        target_link_libraries(llama-omnivoice-server PRIVATE
            omnivoice-core llama)
    endif()
endif()
# ----------------------------------------------------------------------
# end ${SENTINEL}
`;
}

/**
 * Append the graft snippet to <llamaCppRoot>/CMakeLists.txt if not
 * already present. Returns true if the file was modified, false if the
 * sentinel was already present (already grafted).
 */
export function appendCmakeGraft({ llamaCppRoot }) {
  const cmakePath = path.join(llamaCppRoot, "CMakeLists.txt");
  if (!fs.existsSync(cmakePath)) {
    throw new Error(
      `[omnivoice-fuse] llamaCppRoot=${llamaCppRoot} missing CMakeLists.txt`,
    );
  }
  const original = fs.readFileSync(cmakePath, "utf8");
  if (original.includes(SENTINEL)) {
    let upgraded = original.replace(
      "if(ELIZA_FUSE_OMNIVOICE)\n    # Audio tokenizer",
      "if(ELIZA_FUSE_OMNIVOICE)\n    find_package(Threads REQUIRED)\n\n    # Audio tokenizer",
    );
    upgraded = upgraded.replace(
      "    add_compile_definitions(GGML_MAX_NAME=128)\n\n    file(GLOB ELIZA_OMNIVOICE_SOURCES",
      "    add_compile_definitions(GGML_MAX_NAME=128)\n    foreach(_eliza_ggml_max_name_target\n            ggml ggml-base ggml-cpu ggml-blas ggml-metal ggml-vulkan ggml-cuda\n            llama common mtmd server-context)\n        if(TARGET ${_eliza_ggml_max_name_target})\n            target_compile_definitions(${_eliza_ggml_max_name_target}\n                PUBLIC GGML_MAX_NAME=128)\n        endif()\n    endforeach()\n\n    file(GLOB ELIZA_OMNIVOICE_SOURCES",
    );
    upgraded = upgraded.replace(
      "add_library(omnivoice-core STATIC ${ELIZA_OMNIVOICE_SOURCES})\n    target_include_directories(omnivoice-core PUBLIC",
      "add_library(omnivoice-core STATIC ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(omnivoice-core PUBLIC OMNIVOICE_STATIC)\n    target_compile_features(omnivoice-core PUBLIC cxx_std_17)\n    target_include_directories(omnivoice-core PUBLIC",
    );
    upgraded = upgraded.replace(
      "add_library(omnivoice-core STATIC ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(omnivoice-core PUBLIC OMNIVOICE_STATIC)\n    target_include_directories(omnivoice-core PUBLIC",
      "add_library(omnivoice-core STATIC ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(omnivoice-core PUBLIC OMNIVOICE_STATIC)\n    target_compile_features(omnivoice-core PUBLIC cxx_std_17)\n    target_include_directories(omnivoice-core PUBLIC",
    );
    upgraded = upgraded.replace(
      "add_library(elizainference SHARED\n        ${ELIZA_OMNIVOICE_SOURCES})\n    target_include_directories(elizainference PUBLIC",
      "add_library(elizainference SHARED\n        ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(elizainference PRIVATE OMNIVOICE_BUILD)\n    target_compile_features(elizainference PUBLIC cxx_std_17)\n    target_include_directories(elizainference PUBLIC",
    );
    upgraded = upgraded.replace(
      "add_library(elizainference SHARED\n        ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(elizainference PRIVATE OMNIVOICE_BUILD)\n    target_include_directories(elizainference PUBLIC",
      "add_library(elizainference SHARED\n        ${ELIZA_OMNIVOICE_SOURCES})\n    target_compile_definitions(elizainference PRIVATE OMNIVOICE_BUILD)\n    target_compile_features(elizainference PUBLIC cxx_std_17)\n    target_include_directories(elizainference PUBLIC",
    );
    upgraded = upgraded.replace(
      "            ${CMAKE_CURRENT_BINARY_DIR})\n        target_link_libraries(llama-omnivoice-server PRIVATE",
      "            ${CMAKE_CURRENT_BINARY_DIR})\n        target_compile_features(llama-omnivoice-server PRIVATE cxx_std_17)\n        target_link_libraries(llama-omnivoice-server PRIVATE",
    );
    upgraded = upgraded.replace(
      "target_link_libraries(elizainference PUBLIC llama)\n    target_link_libraries(elizainference PUBLIC ggml Threads::Threads)",
      'target_link_libraries(elizainference PUBLIC llama)\n    if(APPLE)\n        target_link_options(elizainference PRIVATE\n            "LINKER:-reexport_library,$<TARGET_FILE:llama>")\n    endif()\n    target_link_libraries(elizainference PUBLIC ggml Threads::Threads)',
    );
    upgraded = upgraded.replace(
      "target_link_libraries(elizainference PUBLIC llama)\n    if(APPLE)",
      "target_link_libraries(elizainference PUBLIC llama mtmd)\n    if(APPLE)",
    );
    upgraded = upgraded.replace(
      `        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_SOURCE_DIR}/include`,
      `        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_SOURCE_DIR}/tools/mtmd
        \${CMAKE_CURRENT_SOURCE_DIR}/include`,
    );
    upgraded = upgraded.replace(
      `        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_BINARY_DIR})`,
      `        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}
        \${CMAKE_CURRENT_SOURCE_DIR}/tools/mtmd
        \${CMAKE_CURRENT_SOURCE_DIR}/include
        \${CMAKE_CURRENT_BINARY_DIR})`,
    );
    upgraded = upgraded.replace(
      "target_include_directories(omnivoice-core SYSTEM PUBLIC\n        ${CMAKE_CURRENT_SOURCE_DIR}/ggml/include\n        ${CMAKE_CURRENT_SOURCE_DIR}/include)\n    target_link_libraries(omnivoice-core PUBLIC ggml Threads::Threads)",
      "target_include_directories(omnivoice-core SYSTEM PUBLIC\n        ${CMAKE_CURRENT_SOURCE_DIR}/ggml/include)\n    target_link_libraries(omnivoice-core PUBLIC llama mtmd ggml Threads::Threads)",
    );
    upgraded = upgraded.replace(
      "target_link_libraries(omnivoice-core PUBLIC ggml Threads::Threads)",
      "target_link_libraries(omnivoice-core PUBLIC llama mtmd ggml Threads::Threads)",
    );
    if (upgraded !== original) {
      fs.writeFileSync(cmakePath, upgraded, "utf8");
      return true;
    }
    return false;
  }
  fs.writeFileSync(cmakePath, original + buildGraftSnippet(), "utf8");
  return true;
}

/**
 * The CMake -D flags a fused build must add on top of the per-target
 * defaults. Returns an array of `-D…=…` strings.
 *
 * Kokoro shares the omnivoice-core static library — when the in-tree
 * `omnivoice/src/kokoro-*.cpp` sources exist, append
 * `-DELIZA_FUSE_KOKORO=ON` so the Kokoro graft block in CMakeLists.txt
 * kicks in. The block itself FATAL_ERRORs if ELIZA_FUSE_OMNIVOICE is
 * off, so the two flags are always consistent.
 */
export function fusedExtraCmakeFlags() {
  const flags = ["-DELIZA_FUSE_OMNIVOICE=ON", "-DBUILD_SHARED_LIBS=ON"];
  if (hasKokoroSourcesInTree()) {
    flags.push("-DELIZA_FUSE_KOKORO=ON");
  }
  return flags;
}

const KOKORO_SENTINEL = "# ELIZA-KOKORO-FUSION-GRAFT-V1";

/**
 * CMake snippet appended verbatim to llama.cpp's root CMakeLists.txt
 * after the OmniVoice graft block. The block declares an additional
 * source set inside the existing `omnivoice-core` STATIC library +
 * `elizainference` SHARED library, gated on `-DELIZA_FUSE_KOKORO=ON`.
 *
 * Why "compile into omnivoice-core" rather than a separate kokoro-core
 * archive: the Kokoro sources reuse the OmniVoice port's
 * `backend.h`/`gguf-weights.h`/`weight-ctx.h`/`ov-error.h` helpers. A
 * separate static library would either need to re-include those (and
 * collide at link time) or expose them as a public surface (and we
 * don't want a new internal-only ABI). One library, two source sets is
 * simpler.
 */
function buildKokoroGraftSnippet() {
  return `

${KOKORO_SENTINEL}
# ----------------------------------------------------------------------
# Source-level fusion of the Kokoro-82M TTS engine into the same
# libelizainference target the OmniVoice graft built above. See
# plugins/plugin-local-inference/native/reports/porting/2026-05-14/
# kokoro-llama-cpp-feasibility.md for the design (no new GGML op, no
# new model arch, free-standing ggml_backend graph mirroring OmniVoice's
# PipelineTTS).
#
# The Kokoro sources are staged by prepare.mjs into the same
# omnivoice/src/ directory as the OmniVoice port so they share the
# GGML_MAX_NAME=128 bump and the gguf-weights.h / weight-ctx.h /
# backend.h helpers.
#
# This block requires ELIZA_FUSE_OMNIVOICE=ON: Kokoro reuses the
# omnivoice-core build context and the OmniVoice FFI dispatcher
# (eliza_pick_kokoro_files() is called from eliza_load_tts() before
# falling through to OmniVoice's own picker).
# ----------------------------------------------------------------------

if(ELIZA_FUSE_KOKORO)
    if(NOT ELIZA_FUSE_OMNIVOICE)
        message(FATAL_ERROR
            "ELIZA_FUSE_KOKORO=ON requires ELIZA_FUSE_OMNIVOICE=ON: the "
            "Kokoro graft compiles into the same omnivoice-core static "
            "library and reuses its backend/weight-ctx helpers.")
    endif()

    file(GLOB ELIZA_KOKORO_SOURCES
        CONFIGURE_DEPENDS
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src/kokoro-*.cpp)
    file(GLOB ELIZA_KOKORO_HEADERS
        CONFIGURE_DEPENDS
        \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/src/kokoro-*.h)

    if(NOT ELIZA_KOKORO_SOURCES)
        message(FATAL_ERROR
            "ELIZA_FUSE_KOKORO=ON but no sources under "
            "${OMNIVOICE_GRAFT_SUBDIR}/src/kokoro-*.cpp. Re-run "
            "packages/app-core/scripts/omnivoice-fuse/prepare.mjs.")
    endif()

    # Compile Kokoro sources straight into the existing omnivoice-core
    # static library so they share its compile flags + GGML_MAX_NAME=128
    # bump + include path set. Avoids a parallel kokoro-core target with
    # a duplicate set of link rules to maintain.
    target_sources(omnivoice-core PRIVATE \${ELIZA_KOKORO_SOURCES})

    # Also compile them into the shared \`elizainference\` library so the
    # FFI symbol set is co-resident with the OmniVoice symbols (one
    # dlopen, one ABI surface; AGENTS.md §4 one-process rule).
    if(TARGET elizainference)
        target_sources(elizainference PRIVATE \${ELIZA_KOKORO_SOURCES})
        target_compile_definitions(elizainference PRIVATE ELIZA_FUSE_KOKORO)
    endif()

    # llama-server already links omnivoice-core (above); the Kokoro
    # sources are now compiled into that archive, so the route in
    # tools/server/server.cpp gated on \`#ifdef ELIZA_FUSE_KOKORO\` picks
    # up the new dispatcher without an additional target_link_libraries.
    if(TARGET llama-server)
        target_compile_definitions(llama-server PRIVATE ELIZA_FUSE_KOKORO)
    endif()

    # Optional: install the Python convert script alongside
    # convert_hf_to_gguf.py so deployments that ship the binary also
    # ship the GGUF generator.
    if(EXISTS \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/tools/convert_kokoro_to_gguf.py)
        install(
            FILES \${CMAKE_CURRENT_SOURCE_DIR}/${OMNIVOICE_GRAFT_SUBDIR}/tools/convert_kokoro_to_gguf.py
            PERMISSIONS
                OWNER_READ OWNER_WRITE OWNER_EXECUTE
                GROUP_READ GROUP_EXECUTE
                WORLD_READ WORLD_EXECUTE
            DESTINATION \${CMAKE_INSTALL_BINDIR})
    endif()
endif()
# ----------------------------------------------------------------------
# end ${KOKORO_SENTINEL}
`;
}

/**
 * Append the Kokoro graft snippet to `<llamaCppRoot>/CMakeLists.txt`
 * after the OmniVoice graft. Idempotent (sentinel-guarded). Returns
 * true when the snippet is written, false when the sentinel was
 * already present.
 *
 * Caller (prepare.mjs / build-llama-cpp-dflash.mjs) invokes this
 * after `appendCmakeGraft` once the Kokoro sources have been staged
 * into `omnivoice/src/`.
 */
export function appendKokoroCmakeGraft({ llamaCppRoot } = {}) {
  if (!llamaCppRoot) {
    throw new Error(
      "[omnivoice-fuse] appendKokoroCmakeGraft: llamaCppRoot is required",
    );
  }
  const cmakePath = path.join(llamaCppRoot, "CMakeLists.txt");
  const original = fs.readFileSync(cmakePath, "utf8");
  if (hasKokoroCmakeGraft(original)) return false;
  fs.writeFileSync(cmakePath, original + buildKokoroGraftSnippet(), "utf8");
  return true;
}

/**
 * True when the in-tree submodule has `omnivoice/src/kokoro-*.cpp`
 * sources staged. The Kokoro fuse step is opt-in based on this signal
 * so a fork checkout without the port still builds OmniVoice cleanly.
 */
export function hasKokoroSourcesInTree(forkRoot) {
  const root = forkRoot ?? defaultForkRoot();
  if (!root) return false;
  const dir = path.join(root, "omnivoice", "src");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(
    (name) => name.startsWith("kokoro-") && name.endsWith(".cpp"),
  );
}

function defaultForkRoot() {
  // Probe the standard in-tree location. Returns null when the
  // submodule has not been initialised.
  const candidate = path.resolve(
    process.cwd(),
    "plugins/plugin-local-inference/native/llama.cpp",
  );
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * True when the root CMakeLists.txt already contains the Kokoro graft
 * sentinel. Used by `applyKokoroCmakeGraft` to stay idempotent across
 * repeated runs of the orchestrator's fuse prep step.
 */
export function hasKokoroCmakeGraft(cmakeListsContents) {
  return cmakeListsContents.includes(KOKORO_SENTINEL);
}

export { KOKORO_SENTINEL as KOKORO_CMAKE_GRAFT_SENTINEL };

/**
 * Names of CMake build targets the fused build must produce. Caller
 * passes these to `cmake --build … --target …`.
 *
 * W3-3 (v1.0.1-eliza): the legacy `omnivoice/` graft tree was deleted
 * from the fork — there is no more `omnivoice-core` or `llama-omnivoice-
 * server` target. The fork's `tools/omnivoice/CMakeLists.txt` declares
 * `omnivoice_lib` (STATIC, underscore not hyphen), `elizainference`
 * (SHARED), `omnivoice-tts` / `omnivoice-codec` (CLIs), and patches the
 * /v1/audio/speech route into `llama-server`.
 *
 * The `legacy` flag is retained for one release as a deprecation
 * runway. Setting it currently has no effect on the produced target
 * list (the underlying CMake produces the merged-tree targets either
 * way — `ELIZA_FUSE_OMNIVOICE=ON` redirects to
 * `LLAMA_BUILD_OMNIVOICE=ON` in the fork's root CMakeLists.txt).
 * Callers still passing `legacy: true` get a warning logged at the
 * call site.
 */
export function fusedCmakeBuildTargets({ legacy: _legacy = false } = {}) {
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

export { SENTINEL as CMAKE_GRAFT_SENTINEL };
