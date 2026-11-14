cmake_minimum_required(VERSION 3.16)
project(doctr_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Current runtime: pure-C scalar reference detector + recognizer behind
# the public C ABI. ggml/SIMD dispatch can replace the internal kernels
# behind this source list without changing callers.
#
# Architecture portability: every TU below is plain scalar C with no
# x86/ARM/RVV intrinsics, so the same source list builds on x86_64,
# aarch64, and riscv64 without any CMAKE_SYSTEM_PROCESSOR branching.
# When SIMD or ggml-dispatch TUs are added, mirror the qjl-cpu
# pattern: separate per-arch TUs (avx2/neon/rvv), each compiled only
# for its own arch via a CMAKE_SYSTEM_PROCESSOR conditional, and
# runtime dispatch via cpuid/hwcap/riscv_hwprobe.
set(DOCTR_SRCS
    src/doctr_runtime.c
    src/doctr_gguf.c
    src/doctr_image.c
    src/doctr_kernels.c
    src/doctr_polygon.c
    src/doctr_ctc.c
    src/doctr_detector_ref.c
    src/doctr_recognizer_ref.c
)

add_library(doctr STATIC ${DOCTR_SRCS})
target_include_directories(doctr PUBLIC include)
target_compile_options(doctr PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
find_library(M_LIB m)
if(M_LIB)
    target_link_libraries(doctr PUBLIC ${M_LIB})
endif()

enable_testing()

add_executable(doctr_abi_smoke test/doctr_abi_smoke.c)
target_link_libraries(doctr_abi_smoke PRIVATE doctr)
target_compile_options(doctr_abi_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME doctr_abi_smoke COMMAND doctr_abi_smoke)
