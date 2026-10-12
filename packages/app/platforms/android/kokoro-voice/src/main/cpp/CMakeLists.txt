cmake_minimum_required(VERSION 3.22)
project(kokorovoicejni CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Inputs from consumer.gradle:
#   KOKORO_VOICE_FFI_INCLUDE_DIR    llama.cpp fork tools/omnivoice/include
#   KOKORO_VOICE_INFERENCE_LIB_DIR  <abi>/libelizainference.so built with Kokoro
#   KOKORO_VOICE_ESPEAK_DIR         build-native.ts output: include/ and <abi>/lib*.a
foreach(var KOKORO_VOICE_FFI_INCLUDE_DIR KOKORO_VOICE_INFERENCE_LIB_DIR KOKORO_VOICE_ESPEAK_DIR)
    if(NOT DEFINED ${var} OR "${${var}}" STREQUAL "")
        message(FATAL_ERROR "[kokoro-voice] ${var} is not set")
    endif()
endforeach()

set(ESPEAK_LIB_DIR "${KOKORO_VOICE_ESPEAK_DIR}/${ANDROID_ABI}")
set(KOKORO_VOICE_INFERENCE_LIB "${KOKORO_VOICE_INFERENCE_LIB_DIR}/${ANDROID_ABI}/libelizainference.so")
foreach(path
        "${KOKORO_VOICE_FFI_INCLUDE_DIR}/eliza-inference-ffi.h"
        "${KOKORO_VOICE_INFERENCE_LIB}"
        "${KOKORO_VOICE_ESPEAK_DIR}/include/espeak-ng/speak_lib.h"
        "${ESPEAK_LIB_DIR}/libespeak-ng.a"
        "${ESPEAK_LIB_DIR}/libucd.a")
    if(NOT EXISTS "${path}")
        message(FATAL_ERROR "[kokoro-voice] missing ${path}; run packages/app/scripts/kokoro-voice/build-native.ts")
    endif()
endforeach()

add_library(elizainference SHARED IMPORTED)
set_target_properties(elizainference PROPERTIES IMPORTED_LOCATION "${KOKORO_VOICE_INFERENCE_LIB}")

add_library(espeak_ng STATIC IMPORTED)
set_target_properties(espeak_ng PROPERTIES IMPORTED_LOCATION "${ESPEAK_LIB_DIR}/libespeak-ng.a")
add_library(espeak_ucd STATIC IMPORTED)
set_target_properties(espeak_ucd PROPERTIES IMPORTED_LOCATION "${ESPEAK_LIB_DIR}/libucd.a")

find_library(LOG_LIB log)

add_library(kokorovoicejni SHARED kokoro-voice-jni.cpp kokoro-g2p.cpp)
target_include_directories(kokorovoicejni PRIVATE
    "${KOKORO_VOICE_FFI_INCLUDE_DIR}"
    "${KOKORO_VOICE_ESPEAK_DIR}/include")
target_compile_options(kokorovoicejni PRIVATE -O2 -fvisibility=hidden)
target_link_libraries(kokorovoicejni PRIVATE elizainference espeak_ng espeak_ucd ${LOG_LIB})
# 16 KiB page alignment for Android 15+ devices.
target_link_options(kokorovoicejni PRIVATE "-Wl,-z,max-page-size=16384")
