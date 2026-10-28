cmake_minimum_required(VERSION 3.22)

set(ANDROID_STL c++_shared)
project(elizavoice-jni)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JNI bridge from Java to the prebuilt fused `libelizainference.so` (the fork
# omnivoice `elizainference` target). The bridge binds its natives with
# RegisterNatives from JNI_OnLoad and exports nothing else, so a consumer
# picks its Java class here instead of rewriting the source:
#
#   ELIZA_VOICE_JNI_CLASS    JNI class name that declares the natives.
#   ELIZA_VOICE_JNI_SUBSET   full  = every native (the ai.elizaos.app host).
#                            voice = context, Paradee TTS, ASR (batch and
#                                    streaming), cancel and memory regions
#                                    (paradee-voice library).
#   ELIZA_VOICE_JNI_LIBRARY  Output library name (System.loadLibrary name).
#   ELIZAVOICE_FFI_INCLUDE_DIR      Fork tools/omnivoice/include.
#   ELIZAVOICE_INFERENCE_LIB_DIR    Directory with <abi>/libelizainference.so,
#                                   staged by stage-elizavoice-lib.ts.
set(ELIZA_VOICE_JNI_CLASS "ai/elizaos/app/ElizaVoiceNative" CACHE STRING
    "JNI class whose natives JNI_OnLoad registers")
set(ELIZA_VOICE_JNI_SUBSET "full" CACHE STRING "Native method set: full or voice")
set_property(CACHE ELIZA_VOICE_JNI_SUBSET PROPERTY STRINGS full voice)
set(ELIZA_VOICE_JNI_LIBRARY "elizavoicejni" CACHE STRING "Output library name")

if(NOT ELIZA_VOICE_JNI_CLASS MATCHES "^[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*$")
    message(FATAL_ERROR "[elizavoice-jni] ELIZA_VOICE_JNI_CLASS must be a JNI class name such as ai/elizaos/app/ElizaVoiceNative, got '${ELIZA_VOICE_JNI_CLASS}'")
endif()
if(ELIZA_VOICE_JNI_SUBSET STREQUAL "full")
    set(ELIZA_VOICE_JNI_FULL 1)
elseif(ELIZA_VOICE_JNI_SUBSET STREQUAL "voice")
    set(ELIZA_VOICE_JNI_FULL 0)
else()
    message(FATAL_ERROR "[elizavoice-jni] ELIZA_VOICE_JNI_SUBSET must be full or voice, got '${ELIZA_VOICE_JNI_SUBSET}'")
endif()

if(NOT ANDROID_ABI STREQUAL "arm64-v8a" AND NOT ANDROID_ABI STREQUAL "x86_64")
    # arm64-v8a and x86_64 use the real bridge. Other ABIs get a stub so the
    # multi-ABI app build does not fail before the per-ABI .so is staged.
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/elizavoice-stub.cpp"
        "extern \"C\" int elizavoice_jni_stub() { return 0; }\n")
    add_library(${ELIZA_VOICE_JNI_LIBRARY} SHARED "${CMAKE_CURRENT_BINARY_DIR}/elizavoice-stub.cpp")
    find_library(LOG_LIB log)
    target_link_libraries(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE ${LOG_LIB})
    message(STATUS "[elizavoice-jni] building no-op stub for ${ANDROID_ABI} (unsupported ABI)")
    return()
endif()

# Resolve the fused-fork FFI header. build.gradle passes the absolute repo
# path; fall back to the in-repo submodule path for a standalone configure.
if(NOT DEFINED ELIZAVOICE_FFI_INCLUDE_DIR OR ELIZAVOICE_FFI_INCLUDE_DIR STREQUAL "")
    set(ELIZAVOICE_FFI_INCLUDE_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include")
endif()
if(NOT EXISTS "${ELIZAVOICE_FFI_INCLUDE_DIR}/eliza-inference-ffi.h")
    message(FATAL_ERROR
        "[elizavoice-jni] eliza-inference-ffi.h not found under "
        "${ELIZAVOICE_FFI_INCLUDE_DIR}; pass -DELIZAVOICE_FFI_INCLUDE_DIR=<fork>/tools/omnivoice/include")
endif()

if(NOT DEFINED ELIZAVOICE_INFERENCE_LIB_DIR OR ELIZAVOICE_INFERENCE_LIB_DIR STREQUAL "")
    set(ELIZAVOICE_INFERENCE_LIB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs")
endif()
set(ELIZAVOICE_LIB_DIR "${ELIZAVOICE_INFERENCE_LIB_DIR}/${ANDROID_ABI}")
set(ELIZAVOICE_PREBUILT_SO "${ELIZAVOICE_LIB_DIR}/libelizainference.so")
if(NOT EXISTS "${ELIZAVOICE_PREBUILT_SO}")
    message(FATAL_ERROR
        "[elizavoice-jni] prebuilt libelizainference.so missing at "
        "${ELIZAVOICE_PREBUILT_SO}; run packages/app/scripts/stage-elizavoice-lib.ts first.")
endif()

add_library(elizainference SHARED IMPORTED)
set_target_properties(elizainference PROPERTIES
    IMPORTED_LOCATION "${ELIZAVOICE_PREBUILT_SO}")

# The DYNAMIC-Vulkan variant of libelizainference.so links its ggml/llama/mtmd
# backends as separate .so files (so libggml-vulkan.so can dlopen the device's
# libvulkan.so in the bionic app process). Import each one staged alongside so
# the link resolves libelizainference's DT_NEEDED. The CPU static-fused
# variant has none of these, so each import is guarded on the file existing.
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
find_library(DL_LIB dl)

# Export JNI_OnLoad and nothing else.
set(ELIZAVOICE_VERSION_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/elizavoice-jni.map")
file(WRITE "${ELIZAVOICE_VERSION_SCRIPT}" "{\n  global: JNI_OnLoad;\n  local: *;\n};\n")

add_library(${ELIZA_VOICE_JNI_LIBRARY} SHARED "${CMAKE_CURRENT_LIST_DIR}/elizavoice-jni.cpp")
target_include_directories(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE "${ELIZAVOICE_FFI_INCLUDE_DIR}")
target_compile_definitions(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE
    "ELIZA_VOICE_JNI_CLASS=\"${ELIZA_VOICE_JNI_CLASS}\""
    "ELIZA_VOICE_JNI_FULL=${ELIZA_VOICE_JNI_FULL}")
target_compile_options(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE
    -O2 -DNDEBUG -fvisibility=hidden -fvisibility-inlines-hidden)
# --allow-shlib-undefined: libggml-vulkan.so NEEDs the device's libvulkan.so,
# which is not a link input (it resolves from /system/lib64 at runtime). The
# bridge never calls vulkan symbols directly.
# max-page-size=16384: 16 KiB page alignment for Android 15+ devices.
target_link_libraries(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE
    elizainference ${ELIZAVOICE_DEP_TARGETS} ${LOG_LIB} ${DL_LIB})
target_link_options(${ELIZA_VOICE_JNI_LIBRARY} PRIVATE
    "-Wl,--allow-shlib-undefined"
    "-Wl,--version-script=${ELIZAVOICE_VERSION_SCRIPT}"
    "-Wl,-z,max-page-size=16384")

message(STATUS "[elizavoice-jni] ${ELIZA_VOICE_JNI_LIBRARY} for ${ANDROID_ABI}: class ${ELIZA_VOICE_JNI_CLASS}, ${ELIZA_VOICE_JNI_SUBSET} natives")
message(STATUS "[elizavoice-jni] FFI header: ${ELIZAVOICE_FFI_INCLUDE_DIR}")
message(STATUS "[elizavoice-jni] prebuilt voice .so: ${ELIZAVOICE_PREBUILT_SO}")
