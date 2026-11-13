cmake_minimum_required(VERSION 3.16)
project(turboquant_cpu C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Always-built scalar reference + dispatcher.
set(TURBOQUANT_SRCS
    src/tbq_block_ref.c
    src/tbq_dispatch.c
)

# Detect target arch and add the matching SIMD TUs. Each TU compiles
# only for its own arch. Within an arch the dispatcher picks the
# available lane at runtime from cpuid / hwcap (see
# src/tbq_cpu_features.h).
#
# Today only the scalar reference exists. The dispatch shell handles
# three lanes (REF / NEON / AVX2) so NEON / AVX2 kernels can slot in
# later without rewiring call sites.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    set(TURBOQUANT_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    set(TURBOQUANT_ARM ON)
endif()

add_library(turboquant STATIC ${TURBOQUANT_SRCS})
target_include_directories(turboquant PUBLIC include)
target_compile_options(turboquant PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(turboquant PUBLIC m)

# x86 / arm host builds intentionally do not yet list NEON or AVX2 TUs:
# only the scalar reference and the dispatcher get linked. Sister tasks
# add tbq_*_neon.c / tbq_*_avx2.c here.
if(TURBOQUANT_X86)
    # x86 currently links the scalar reference through the dispatcher.
    # Add tbq_*_avx2.c here when the AVX2 lane is added.
endif()
if(TURBOQUANT_ARM)
    # ARM currently links the scalar reference through the dispatcher.
    # Add tbq_*_neon.c here when the NEON lane is added.
endif()

# turboquant_smoke: block-encode/decode round-trip for TBQ3/TBQ4. Asserts
# block sizes match the fork's ggml-common.h (14 / 18 bytes) and the
# reference round-trip stays inside the per-block error band. Required
# by the W3 quant-matrix audit (packages/training/reports/eliza1-quant-matrix-2026-05-14.md).
add_executable(turboquant_smoke test/turboquant_smoke.c)
target_link_libraries(turboquant_smoke PRIVATE turboquant)
target_compile_options(turboquant_smoke PRIVATE -O2 -Wall -Wextra)

# turboquant_simd_parity: end-to-end parity between the scalar reference
# and the currently linked SIMD path (ref-only until NEON / AVX2
# kernels land). Cross-checks encode-ref / decode-
# SIMD and encode-SIMD / decode-ref against the scalar round-trip across
# the canonical block lengths 32..1024.
add_executable(turboquant_simd_parity test/turboquant_simd_parity.c)
target_link_libraries(turboquant_simd_parity PRIVATE turboquant)
target_compile_options(turboquant_simd_parity PRIVATE -O2 -Wall -Wextra)

enable_testing()
add_test(NAME turboquant_smoke COMMAND turboquant_smoke)
add_test(NAME turboquant_simd_parity COMMAND turboquant_simd_parity)
