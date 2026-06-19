cmake_minimum_required(VERSION 3.20)
project(iree_eliza_npu LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# This package builds the `elizanpu` MLIR dialect and its IREE lowering passes.
# It is intentionally a sibling source tree to LLVM/MLIR. The canonical build
# pipeline plugs this into an IREE source tree via `IREE_INPUT_SOURCES` (see
# docs/toolchain/iree-eliza-npu.md).
#
# Standalone build (for dialect-only smoke):
#   cmake -G Ninja -S . -B build \
#       -DMLIR_DIR=$STAGE2/lib/cmake/mlir \
#       -DLLVM_DIR=$STAGE2/lib/cmake/llvm
#   ninja -C build elizanpu-opt
#
# In-tree IREE build:
#   pass `-DIREE_EXTERNAL_HAL_DRIVERS=elizanpu` and add this directory to
#   `iree_compiler_external_dialects` per scripts/build_iree_eliza_npu.sh.

option(ELIZANPU_BUILD_STANDALONE "Build dialect-only opt tool without IREE" OFF)

find_package(MLIR REQUIRED CONFIG)
find_package(LLVM REQUIRED CONFIG)

list(APPEND CMAKE_MODULE_PATH "${MLIR_CMAKE_DIR}")
list(APPEND CMAKE_MODULE_PATH "${LLVM_CMAKE_DIR}")

include(TableGen)
include(AddLLVM)
include(AddMLIR)

include_directories(${LLVM_INCLUDE_DIRS})
include_directories(${MLIR_INCLUDE_DIRS})
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)
include_directories(${CMAKE_CURRENT_BINARY_DIR}/include)

add_subdirectory(include/elizanpu)
add_subdirectory(lib)
add_subdirectory(runtime)

if(ELIZANPU_BUILD_STANDALONE)
    add_subdirectory(tools)
endif()

enable_testing()
add_subdirectory(tests)
