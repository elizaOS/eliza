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
 */
export function fusedExtraCmakeFlags() {
  return ["-DELIZA_FUSE_OMNIVOICE=ON", "-DBUILD_SHARED_LIBS=ON"];
}

/**
 * Names of CMake build targets the fused build must produce. Caller
 * passes these to `cmake --build … --target …`.
 */
export function fusedCmakeBuildTargets() {
  return [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
    // Non-interactive generation drivers used by the verify runners.
    "llama-bench",
    "llama-completion",
    "omnivoice-core",
    "elizainference",
    "llama-omnivoice-server",
  ];
}

export { SENTINEL as CMAKE_GRAFT_SENTINEL };
