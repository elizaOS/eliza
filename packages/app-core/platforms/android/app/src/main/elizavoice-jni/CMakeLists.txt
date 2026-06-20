cmake_minimum_required(VERSION 3.22)

project(elizavoice-jni)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Phase 3a JNI host: a tiny bionic .so (built by the app module's NDK
# externalNativeBuild) that links the prebuilt, self-contained
# `libelizainference.so` (the fused fork omnivoice `elizainference` target,
# ABI v7, all four voice runtimes) and exposes a couple of native methods to
# the ai.elizaos.app Capacitor process. This proves the fused voice .so loads
# + runs IN-PROCESS in the normal APK (bionic), replacing the musl bun-agent
# path for the voice runtimes.
#
# Layout (mirrors llama-cpp-capacitor's IMPORTED-prebuilt pattern):
#   - libelizainference.so is staged into src/main/jniLibs/${ANDROID_ABI}
#     by stage-elizavoice-lib.mjs (cross-built via the NDK from the fork's
#     tools/omnivoice, statically linking ggml/llama/mtmd so it has NO
#     external NEEDED deps beyond bionic libc/libm/libdl).
#   - the FFI header lives in the fork tree; we point at it via
#     ELIZAVOICE_FFI_INCLUDE_DIR (passed from build.gradle) with a sane
#     in-tree fallback.

if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    # Phase 3a only validates arm64-v8a. Other ABIs get a no-op stub so the
    # multi-ABI app build does not fail before the per-ABI .so is staged.
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/elizavoice-stub.cpp"
        "extern \"C\" int elizavoice_jni_stub() { return 0; }\n")
    add_library(elizavoicejni SHARED "${CMAKE_CURRENT_BINARY_DIR}/elizavoice-stub.cpp")
    find_library(LOG_LIB log)
    target_link_libraries(elizavoicejni PRIVATE ${LOG_LIB})
    message(STATUS "[elizavoice-jni] building no-op stub for ${ANDROID_ABI} (Phase 3a: arm64-v8a only)")
    return()
endif()

# Resolve the fused-fork FFI header. build.gradle passes the absolute repo
# path; fall back to the conventional in-repo submodule path so a standalone
# cmake invocation still configures.
if(NOT DEFINED ELIZAVOICE_FFI_INCLUDE_DIR OR ELIZAVOICE_FFI_INCLUDE_DIR STREQUAL "")
    set(ELIZAVOICE_FFI_INCLUDE_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include")
endif()

if(NOT EXISTS "${ELIZAVOICE_FFI_INCLUDE_DIR}/eliza-inference-ffi.h")
    message(FATAL_ERROR
        "[elizavoice-jni] eliza-inference-ffi.h not found under "
        "${ELIZAVOICE_FFI_INCLUDE_DIR}; pass -DELIZAVOICE_FFI_INCLUDE_DIR=<fork>/tools/omnivoice/include")
endif()

# The prebuilt fused voice library, staged into jniLibs by
# stage-elizavoice-lib.mjs before the native build runs.
set(ELIZAVOICE_PREBUILT_SO
    "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libelizainference.so")
if(NOT EXISTS "${ELIZAVOICE_PREBUILT_SO}")
    message(FATAL_ERROR
        "[elizavoice-jni] prebuilt libelizainference.so missing at "
        "${ELIZAVOICE_PREBUILT_SO}; run "
        "packages/app-core/scripts/stage-elizavoice-lib.mjs first.")
endif()

add_library(elizainference SHARED IMPORTED)
set_target_properties(elizainference PROPERTIES
    IMPORTED_LOCATION "${ELIZAVOICE_PREBUILT_SO}")

# The DYNAMIC-Vulkan variant of libelizainference.so links its ggml/llama/mtmd
# backends as separate .so (so the GPU backend libggml-vulkan.so can dlopen the
# device's libvulkan.so at runtime — only possible in the bionic app process,
# never the musl agent). Import each dep that is staged alongside so the
# elizavoicejni link resolves libelizainference's DT_NEEDED; the bionic loader
# pulls them in when System.loadLibrary("elizainference") runs. A CPU-only
# static-fused libelizainference.so has none of these siblings, so each import
# is guarded on the file existing — both variants build from this one list.
set(ELIZAVOICE_LIB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}")
set(ELIZAVOICE_DEP_TARGETS "")
foreach(dep ggml ggml-base ggml-cpu ggml-vulkan llama llama-common mtmd)
    if(EXISTS "${ELIZAVOICE_LIB_DIR}/lib${dep}.so")
        add_library(eliza_dep_${dep} SHARED IMPORTED)
        set_target_properties(eliza_dep_${dep} PROPERTIES
            IMPORTED_LOCATION "${ELIZAVOICE_LIB_DIR}/lib${dep}.so")
        list(APPEND ELIZAVOICE_DEP_TARGETS eliza_dep_${dep})
    endif()
endforeach()

find_library(LOG_LIB log)

add_library(elizavoicejni SHARED elizavoice-jni.cpp)
target_include_directories(elizavoicejni PRIVATE "${ELIZAVOICE_FFI_INCLUDE_DIR}")
target_compile_options(elizavoicejni PRIVATE -O2 -DNDEBUG)
# --allow-shlib-undefined: libggml-vulkan.so NEEDs the device's libvulkan.so,
# which isn't a link input (it resolves from /system/lib64 at runtime in the
# app process). The shim never calls vulkan symbols directly, so leaving that
# transitive NEEDED unresolved at link time is correct.
target_link_libraries(elizavoicejni PRIVATE
    elizainference ${ELIZAVOICE_DEP_TARGETS} ${LOG_LIB})
target_link_options(elizavoicejni PRIVATE "-Wl,--allow-shlib-undefined")

message(STATUS "[elizavoice-jni] building bionic JNI bridge for ${ANDROID_ABI}")
message(STATUS "[elizavoice-jni] FFI header: ${ELIZAVOICE_FFI_INCLUDE_DIR}")
message(STATUS "[elizavoice-jni] prebuilt voice .so: ${ELIZAVOICE_PREBUILT_SO}")
