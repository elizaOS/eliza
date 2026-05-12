#!/usr/bin/env node
/**
 * Expand `llama-cpp-capacitor` ABI filters to include x86_64 alongside arm64-v8a.
 *
 * `llama-cpp-capacitor@0.1.5/android/build.gradle` ships with
 *   ndk { abiFilters 'arm64-v8a' }
 *
 * That is correct for production phone builds (Pixel / Galaxy / Moto G are
 * all arm64), but it leaves the Capacitor APK incompatible with x86_64
 * emulators and Cuttlefish virtual devices — `MainActivity.onCreate` calls
 * `System.loadLibrary("llama-cpp-x86_64")` and crashes with
 * `UnsatisfiedLinkError: dlopen failed: library "libllama-cpp-x86_64.so" not
 * found` on those environments.
 *
 * This postinstall step rewrites the installed `build.gradle` to also build
 * `x86_64` (CMake then cross-compiles llama.cpp for x86_64 too). Production
 * release APKs stay arm64-by-default because the App Bundle splits per ABI
 * (`bundle { abi { enableSplit = true } }` in `packages/app/android/app/
 * build.gradle`) — the Play Store still ships only the matching ABI to a
 * given device.
 *
 * Idempotent: detects the patched marker (`'x86_64'` in the abiFilters
 * line) and exits early.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const ORIGINAL = "abiFilters 'arm64-v8a'";
const PATCHED = "abiFilters 'arm64-v8a', 'x86_64'";

// CMakeLists.txt ships hardcoded for arm64. We swap it for an ABI-aware
// version that builds either `llama-cpp-arm64` (arm64-v8a) or
// `llama-cpp-x86_64` (x86_64) based on the gradle-injected `ANDROID_ABI`.
// `LlamaCpp.java` picks the matching `System.loadLibrary(...)` name from
// `Build.SUPPORTED_64_BIT_ABIS`, so a single APK supports both targets and
// real arm64 phones still get the same arm-tuned binary.
const CMAKE_PATCHED_MARKER =
  "Dispatch on the gradle-injected `ANDROID_ABI` so the same build invocation";

const CMAKE_PATCHED_CONTENT = `cmake_minimum_required(VERSION 3.10)

project(llama-cpp)

set(CMAKE_CXX_STANDARD 17)
set(LLAMACPP_LIB_DIR \${CMAKE_SOURCE_DIR}/../../../cpp)

include_directories(
    \${LLAMACPP_LIB_DIR}
    \${LLAMACPP_LIB_DIR}/ggml-cpu
    \${LLAMACPP_LIB_DIR}/tools/mtmd
)

set(
    SOURCE_FILES
    \${LLAMACPP_LIB_DIR}/ggml.c
    \${LLAMACPP_LIB_DIR}/ggml-alloc.c
    \${LLAMACPP_LIB_DIR}/ggml-backend.cpp
    \${LLAMACPP_LIB_DIR}/ggml-backend-reg.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/amx/amx.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/amx/mmq.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/ggml-cpu.c
    \${LLAMACPP_LIB_DIR}/ggml-cpu/ggml-cpu.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/quants.c
    \${LLAMACPP_LIB_DIR}/ggml-cpu/traits.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/repack.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/unary-ops.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/binary-ops.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/vec.cpp
    \${LLAMACPP_LIB_DIR}/ggml-cpu/ops.cpp
    \${LLAMACPP_LIB_DIR}/ggml-opt.cpp
    \${LLAMACPP_LIB_DIR}/ggml-threading.cpp
    \${LLAMACPP_LIB_DIR}/ggml-quants.c
    \${LLAMACPP_LIB_DIR}/gguf.cpp
    \${LLAMACPP_LIB_DIR}/log.cpp
    \${LLAMACPP_LIB_DIR}/llama-impl.cpp
    \${LLAMACPP_LIB_DIR}/chat-parser.cpp
    \${LLAMACPP_LIB_DIR}/json-partial.cpp
    \${LLAMACPP_LIB_DIR}/regex-partial.cpp
    # Multimodal support
    \${LLAMACPP_LIB_DIR}/tools/mtmd/mtmd.cpp
    \${LLAMACPP_LIB_DIR}/tools/mtmd/mtmd-audio.cpp
    \${LLAMACPP_LIB_DIR}/tools/mtmd/clip.cpp
    \${LLAMACPP_LIB_DIR}/tools/mtmd/mtmd-helper.cpp
    \${LLAMACPP_LIB_DIR}/llama-grammar.cpp
    \${LLAMACPP_LIB_DIR}/llama-sampling.cpp
    \${LLAMACPP_LIB_DIR}/llama-vocab.cpp
    \${LLAMACPP_LIB_DIR}/llama-adapter.cpp
    \${LLAMACPP_LIB_DIR}/llama-chat.cpp
    \${LLAMACPP_LIB_DIR}/llama-context.cpp
    \${LLAMACPP_LIB_DIR}/llama-arch.cpp
    \${LLAMACPP_LIB_DIR}/llama-batch.cpp
    \${LLAMACPP_LIB_DIR}/llama-cparams.cpp
    \${LLAMACPP_LIB_DIR}/llama-hparams.cpp
    \${LLAMACPP_LIB_DIR}/llama.cpp
    \${LLAMACPP_LIB_DIR}/llama-model.cpp
    \${LLAMACPP_LIB_DIR}/llama-model-loader.cpp
    \${LLAMACPP_LIB_DIR}/llama-model-saver.cpp
    \${LLAMACPP_LIB_DIR}/llama-kv-cache.cpp
    \${LLAMACPP_LIB_DIR}/llama-kv-cache-iswa.cpp
    \${LLAMACPP_LIB_DIR}/llama-memory-hybrid.cpp
    \${LLAMACPP_LIB_DIR}/llama-memory-recurrent.cpp
    \${LLAMACPP_LIB_DIR}/llama-mmap.cpp
    \${LLAMACPP_LIB_DIR}/llama-vocab.cpp
    \${LLAMACPP_LIB_DIR}/llama-memory.cpp
    \${LLAMACPP_LIB_DIR}/llama-io.cpp
    \${LLAMACPP_LIB_DIR}/llama-graph.cpp
    \${LLAMACPP_LIB_DIR}/sampling.cpp
    \${LLAMACPP_LIB_DIR}/unicode-data.cpp
    \${LLAMACPP_LIB_DIR}/unicode.cpp
    \${LLAMACPP_LIB_DIR}/common.cpp
    \${LLAMACPP_LIB_DIR}/chat.cpp
    \${LLAMACPP_LIB_DIR}/json-schema-to-grammar.cpp
    \${LLAMACPP_LIB_DIR}/nlohmann/json.hpp
    \${LLAMACPP_LIB_DIR}/nlohmann/json_fwd.hpp
    \${LLAMACPP_LIB_DIR}/minja/minja.hpp
    \${LLAMACPP_LIB_DIR}/minja/chat-template.hpp
    \${LLAMACPP_LIB_DIR}/anyascii.c
    \${LLAMACPP_LIB_DIR}/cap-llama.cpp
    \${LLAMACPP_LIB_DIR}/cap-completion.cpp
    \${LLAMACPP_LIB_DIR}/cap-tts.cpp
    \${CMAKE_SOURCE_DIR}/jni-utils.h
    \${CMAKE_SOURCE_DIR}/jni.cpp
)

# Find Android libraries
find_library(LOG_LIB log)
find_library(ANDROID_LIB android)

# ARM64 specific build function for real devices
function(build_library_arm64 target_name)
    add_library(
        \${target_name}
        SHARED
        \${SOURCE_FILES}
    )

    target_compile_options(\${target_name} PRIVATE
        -march=armv8-a
        -mtune=cortex-a76
        -O3
        -DNDEBUG
        -DLM_GGML_USE_CPU
        -DLM_GGML_CPU_GENERIC
        -fno-finite-math-only
        -funroll-loops
    )

    target_link_libraries(\${target_name}
        \${LOG_LIB}
        \${ANDROID_LIB}
    )

    set_target_properties(\${target_name} PROPERTIES
        OUTPUT_NAME "llama-cpp-arm64"
        LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_CURRENT_SOURCE_DIR}/jniLibs/arm64-v8a"
    )
endfunction()

# x86_64 build function for emulators / Cuttlefish.
function(build_library_x86_64 target_name)
    add_library(
        \${target_name}
        SHARED
        \${SOURCE_FILES}
    )

    target_compile_options(\${target_name} PRIVATE
        -march=x86-64
        -mtune=generic
        -mavx2
        -mavx
        -msse3
        -msse
        -mfma
        -mf16c
        -O3
        -DNDEBUG
        -DLM_GGML_USE_CPU
        -DLM_GGML_CPU_GENERIC
        -DLM_GGML_USE_AVX2
        -DLM_GGML_USE_AVX
        -DLM_GGML_USE_SSE3
        -DLM_GGML_USE_SSE
        -DLM_GGML_USE_FMA
        -DLM_GGML_USE_F16C
    )

    target_link_libraries(\${target_name}
        \${LOG_LIB}
        \${ANDROID_LIB}
    )

    set_target_properties(\${target_name} PROPERTIES
        OUTPUT_NAME "llama-cpp-x86_64"
        LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_CURRENT_SOURCE_DIR}/jniLibs/x86_64"
    )
endfunction()

# Dispatch on the gradle-injected \`ANDROID_ABI\` so the same build invocation
# produces the right artifact per ABI.
if(ANDROID_ABI STREQUAL "arm64-v8a")
    build_library_arm64(llama-cpp-arm64)
    message(STATUS "Building llama-cpp for Android ARM64 (real devices)")
elseif(ANDROID_ABI STREQUAL "x86_64")
    build_library_x86_64(llama-cpp-x86_64)
    message(STATUS "Building llama-cpp for Android x86_64 (emulator / Cuttlefish)")
else()
    message(FATAL_ERROR "Unsupported ANDROID_ABI: \${ANDROID_ABI} (expected arm64-v8a or x86_64)")
endif()
`;

function* llamaCppPackageRoots() {
  const bunDir = join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("llama-cpp-capacitor@")) continue;
      const pkg = join(bunDir, entry, "node_modules", "llama-cpp-capacitor");
      if (existsSync(join(pkg, "package.json"))) yield pkg;
    }
  }
  const hoisted = join(repoRoot, "node_modules", "llama-cpp-capacitor");
  if (existsSync(join(hoisted, "package.json"))) yield hoisted;
}

function patchGradle(pkgRoot) {
  const buildGradle = join(pkgRoot, "android", "build.gradle");
  if (!existsSync(buildGradle)) return false;
  const text = readFileSync(buildGradle, "utf8");
  if (text.includes(PATCHED)) return false;
  if (!text.includes(ORIGINAL)) {
    console.warn(
      `[patch-llama-cpp-capacitor-x86_64] expected literal not found in ${buildGradle}; abi expansion skipped`,
    );
    return false;
  }
  writeFileSync(buildGradle, text.replace(ORIGINAL, PATCHED), "utf8");
  return true;
}

function patchCMake(pkgRoot) {
  const cmakeFile = join(pkgRoot, "android", "src", "main", "CMakeLists.txt");
  if (!existsSync(cmakeFile)) return false;
  const text = readFileSync(cmakeFile, "utf8");
  if (text.includes(CMAKE_PATCHED_MARKER)) return false;
  writeFileSync(cmakeFile, CMAKE_PATCHED_CONTENT, "utf8");
  return true;
}

function main() {
  let applied = 0;
  for (const pkgRoot of llamaCppPackageRoots()) {
    let touched = false;
    if (patchGradle(pkgRoot)) {
      touched = true;
      console.log(
        `[patch-llama-cpp-capacitor-x86_64] expanded abiFilters in ${pkgRoot}`,
      );
    }
    if (patchCMake(pkgRoot)) {
      touched = true;
      console.log(
        `[patch-llama-cpp-capacitor-x86_64] installed ABI-aware CMakeLists.txt in ${pkgRoot}`,
      );
    }
    if (touched) applied += 1;
  }
  if (applied === 0) {
    // Quiet on the steady-state case so postinstall stays low-noise.
  }
}

main();
