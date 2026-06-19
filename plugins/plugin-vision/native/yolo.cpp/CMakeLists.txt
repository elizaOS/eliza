cmake_minimum_required(VERSION 3.20)
project(yolo LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(YOLO_WITH_METAL "Use Metal backend on macOS" OFF)
option(YOLO_WITH_CUDA  "Use CUDA backend"           OFF)

# Reuse ggml from llama.cpp's vendored copy.
set(YOLO_GGML_DIR "" CACHE PATH "Path to a ggml source tree")
if(NOT YOLO_GGML_DIR)
    set(YOLO_GGML_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../plugin-local-inference/native/llama.cpp/ggml")
endif()

set(_yolo_has_ggml FALSE)
if(EXISTS "${YOLO_GGML_DIR}/include/ggml.h")
    set(_yolo_has_ggml TRUE)
    # Build ggml STATICALLY and link it into libyolo so the FFI artifact is a
    # single self-contained shared library (no ggml.dll/.so co-location or
    # PATH/RPATH dance at load time). yolo itself stays SHARED below.
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(GGML_BACKEND_DL    OFF CACHE BOOL "" FORCE)
    add_subdirectory(${YOLO_GGML_DIR} ggml-build EXCLUDE_FROM_ALL)
endif()

# The FFI consumer (bun:ffi) dlopens this; it must be SHARED regardless of
# BUILD_SHARED_LIBS (which we forced OFF for the ggml subbuild above).
add_library(yolo SHARED src/yolo.cpp)
target_include_directories(yolo PUBLIC include)

if(_yolo_has_ggml)
    target_compile_definitions(yolo PRIVATE YOLO_HAVE_GGML=1)
    # Static link → GGML_API resolves to plain `extern` (no dllimport). Do NOT
    # define GGML_SHARED/GGML_BUILD here.
    target_link_libraries(yolo PRIVATE ggml)
    if(YOLO_WITH_METAL)
        target_compile_definitions(yolo PRIVATE GGML_USE_METAL=1)
    endif()
    if(YOLO_WITH_CUDA)
        target_compile_definitions(yolo PRIVATE GGML_USE_CUDA=1)
    endif()
endif()

# Emit as `libyolo.<ext>` in the build root on every platform/generator so the
# FFI loader (src/native/yolo-ffi.ts) finds it at a single stable path,
# regardless of the multi-config (Release/) subdir MSVC would otherwise use.
set_target_properties(yolo PROPERTIES
    PREFIX "lib"
    OUTPUT_NAME "yolo"
    RUNTIME_OUTPUT_DIRECTORY            "${CMAKE_CURRENT_SOURCE_DIR}/build"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE    "${CMAKE_CURRENT_SOURCE_DIR}/build"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG      "${CMAKE_CURRENT_SOURCE_DIR}/build"
    LIBRARY_OUTPUT_DIRECTORY            "${CMAKE_CURRENT_SOURCE_DIR}/build"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE    "${CMAKE_CURRENT_SOURCE_DIR}/build"
    LIBRARY_OUTPUT_DIRECTORY_DEBUG      "${CMAKE_CURRENT_SOURCE_DIR}/build")
