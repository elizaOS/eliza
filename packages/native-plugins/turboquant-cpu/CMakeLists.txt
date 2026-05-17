cmake_minimum_required(VERSION 3.16)
project(turboquant_cpu C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Always-built scalar reference. SIMD lanes will land beside the ref
# files (tbq_block_avx2.c / tbq_block_neon.c) and follow the qjl-cpu
# per-arch dispatch pattern. Until then this library is scalar-only.
set(TURBOQUANT_SRCS
    src/tbq_block_ref.c
)

add_library(turboquant STATIC ${TURBOQUANT_SRCS})
target_include_directories(turboquant PUBLIC include)
target_compile_options(turboquant PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(turboquant PUBLIC m)

# turboquant_smoke: block-encode/decode round-trip for TBQ3/TBQ4. Asserts
# block sizes match the fork's ggml-common.h (14 / 18 bytes) and the
# reference round-trip stays inside the per-block error band. Required
# by the W3 quant-matrix audit (packages/training/reports/eliza1-quant-matrix-2026-05-14.md).
add_executable(turboquant_smoke test/turboquant_smoke.c)
target_link_libraries(turboquant_smoke PRIVATE turboquant)
target_compile_options(turboquant_smoke PRIVATE -O2 -Wall -Wextra)

enable_testing()
add_test(NAME turboquant_smoke COMMAND turboquant_smoke)
