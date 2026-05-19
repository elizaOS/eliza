# whisper-eliza-adapter — thin C ABI bridge sitting in front of whisper.cpp.
#
# Built as a sibling of whisper.cpp: the adapter takes the libwhisper target
# (or its imported equivalent) and produces a single libwhisper_eliza_adapter
# shared library that Eliza's JS-side bun:ffi loader binds against.
#
# Two consumption modes:
#
#   1. add_subdirectory: another CMakeLists already added whisper.cpp's
#      source tree, so the `whisper` target exists in this project.
#      WHISPER_CPP_SRC_DIR points at the whisper.cpp source root in that case.
#
#   2. find_package(Whisper): a pre-built libwhisper exposes WhisperConfig.cmake
#      on disk. Set CMAKE_PREFIX_PATH to the install prefix.

cmake_minimum_required(VERSION 3.16)
project(whisper-eliza-adapter LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(WHISPER_ELIZA_ADAPTER_USE_SUBDIR
    "Pull whisper.cpp in via add_subdirectory at WHISPER_CPP_SRC_DIR"
    ON)

if (WHISPER_ELIZA_ADAPTER_USE_SUBDIR)
    if (NOT DEFINED WHISPER_CPP_SRC_DIR)
        message(FATAL_ERROR
            "WHISPER_ELIZA_ADAPTER_USE_SUBDIR=ON but WHISPER_CPP_SRC_DIR is not set. "
            "Pass -DWHISPER_CPP_SRC_DIR=<path-to-whisper.cpp-checkout> or set "
            "WHISPER_ELIZA_ADAPTER_USE_SUBDIR=OFF and provide a pre-built libwhisper "
            "via CMAKE_PREFIX_PATH.")
    endif()
    if (NOT EXISTS "${WHISPER_CPP_SRC_DIR}/CMakeLists.txt")
        message(FATAL_ERROR
            "WHISPER_CPP_SRC_DIR=${WHISPER_CPP_SRC_DIR} does not contain a CMakeLists.txt")
    endif()
    # Build whisper as a shared library so the adapter inherits a dynamic
    # link the loader can dlopen separately.
    set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_EXAMPLES ON CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_SERVER  OFF CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_TESTS   OFF CACHE BOOL "" FORCE)
    add_subdirectory(${WHISPER_CPP_SRC_DIR} whisper-cpp-build)
else()
    find_package(Whisper REQUIRED)
endif()

add_library(whisper_eliza_adapter SHARED
    whisper_eliza_adapter.cpp)

target_include_directories(whisper_eliza_adapter PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(whisper_eliza_adapter PRIVATE WHISPER_ELIZA_ADAPTER_BUILD)

set_target_properties(whisper_eliza_adapter PROPERTIES
    C_VISIBILITY_PRESET       hidden
    CXX_VISIBILITY_PRESET     hidden
    VISIBILITY_INLINES_HIDDEN ON)

target_link_libraries(whisper_eliza_adapter PRIVATE whisper)
