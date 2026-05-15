cmake_minimum_required(VERSION 3.20)
project(yolo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(YOLO_BUILD_SHARED "Build shared library (bun:ffi)" ON)
option(YOLO_WITH_METAL   "Use Metal backend on macOS"     OFF)
option(YOLO_WITH_CUDA    "Use CUDA backend"               OFF)

# Reuse ggml from llama.cpp's vendored copy. Same pattern as doctr.cpp.
set(YOLO_GGML_DIR "" CACHE PATH "Path to a ggml source tree")
if(NOT YOLO_GGML_DIR)
    set(YOLO_GGML_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../plugin-local-inference/native/llama.cpp/ggml")
endif()

set(_yolo_has_ggml FALSE)
if(EXISTS "${YOLO_GGML_DIR}/include/ggml.h")
    set(_yolo_has_ggml TRUE)
    add_subdirectory(${YOLO_GGML_DIR} ggml-build EXCLUDE_FROM_ALL)
endif()

if(YOLO_BUILD_SHARED)
    add_library(yolo SHARED src/yolo.cpp)
else()
    add_library(yolo STATIC src/yolo.cpp)
endif()

target_include_directories(yolo PUBLIC include)

if(_yolo_has_ggml)
    target_compile_definitions(yolo PRIVATE YOLO_HAVE_GGML=1)
    target_link_libraries(yolo PRIVATE ggml)
    if(YOLO_WITH_METAL)
        target_compile_definitions(yolo PRIVATE GGML_USE_METAL=1)
    endif()
    if(YOLO_WITH_CUDA)
        target_compile_definitions(yolo PRIVATE GGML_USE_CUDA=1)
    endif()
endif()
