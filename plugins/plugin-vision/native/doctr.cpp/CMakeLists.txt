cmake_minimum_required(VERSION 3.20)
project(doctr LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(DOCTR_BUILD_SHARED "Build shared library (bun:ffi)" ON)
option(DOCTR_WITH_METAL   "Use Metal backend on macOS"     OFF)
option(DOCTR_WITH_CUDA    "Use CUDA backend"               OFF)

# ----------------------------------------------------------------------------
# ggml dependency
# ----------------------------------------------------------------------------
# The runtime depends on ggml. The expected layout is:
#   plugins/plugin-local-inference/native/llama.cpp/ggml/  (existing submodule)
# We point at that to avoid pinning a second copy. If the path is missing the
# build still produces libdoctr.<ext> as a stub (DOCTR_HAVE_GGML undefined) so
# the FFI surface exists for the JS layer to call into — it will throw a
# clear "GGUF not ready" at runtime.

set(DOCTR_GGML_DIR "" CACHE PATH "Path to a ggml source tree (defaults to llama.cpp's vendored copy)")
if(NOT DOCTR_GGML_DIR)
    set(DOCTR_GGML_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../plugin-local-inference/native/llama.cpp/ggml")
endif()

set(_doctr_has_ggml FALSE)
if(EXISTS "${DOCTR_GGML_DIR}/include/ggml.h")
    set(_doctr_has_ggml TRUE)
    add_subdirectory(${DOCTR_GGML_DIR} ggml-build EXCLUDE_FROM_ALL)
endif()

# ----------------------------------------------------------------------------
# Library
# ----------------------------------------------------------------------------
set(_doctr_sources
    src/doctr_det.cpp
    src/doctr_rec.cpp
)

if(DOCTR_BUILD_SHARED)
    add_library(doctr SHARED ${_doctr_sources})
else()
    add_library(doctr STATIC ${_doctr_sources})
endif()

target_include_directories(doctr PUBLIC include)

if(_doctr_has_ggml)
    target_compile_definitions(doctr PRIVATE DOCTR_HAVE_GGML=1)
    target_link_libraries(doctr PRIVATE ggml)
    if(DOCTR_WITH_METAL)
        target_compile_definitions(doctr PRIVATE GGML_USE_METAL=1)
    endif()
    if(DOCTR_WITH_CUDA)
        target_compile_definitions(doctr PRIVATE GGML_USE_CUDA=1)
    endif()
endif()
