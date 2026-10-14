cmake_minimum_required(VERSION 3.22)
project(paradeevoicejni CXX)

# libparadeevoicejni.so: the shared app bridge (elizavoice-jni.cpp) bound to
# ai.eliza.voice.VoiceNative with only the voice natives. Inputs from
# consumer.gradle:
#   ELIZAVOICE_FFI_INCLUDE_DIR     llama.cpp fork tools/omnivoice/include
#   ELIZAVOICE_INFERENCE_LIB_DIR   <abi>/libelizainference.so built with Paradee
#                                  and misaki G2P (build-native.ts)
#   ELIZA_VOICE_JNI_SOURCE_DIR     app/src/main/elizavoice-jni
foreach(var ELIZAVOICE_FFI_INCLUDE_DIR ELIZAVOICE_INFERENCE_LIB_DIR ELIZA_VOICE_JNI_SOURCE_DIR)
    if(NOT DEFINED ${var} OR "${${var}}" STREQUAL "")
        message(FATAL_ERROR "[paradee-voice] ${var} is not set")
    endif()
endforeach()

set(ELIZA_VOICE_JNI_CLASS "ai/eliza/voice/VoiceNative")
set(ELIZA_VOICE_JNI_SUBSET "voice")
set(ELIZA_VOICE_JNI_LIBRARY "paradeevoicejni")
add_subdirectory("${ELIZA_VOICE_JNI_SOURCE_DIR}" elizavoice-jni)
