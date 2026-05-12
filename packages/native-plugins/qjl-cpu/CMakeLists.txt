cmake_minimum_required(VERSION 3.16)
project(qjl_cpu C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Always-built scalar reference + projection helper + dispatch.
set(QJL_SRCS
    src/qjl_projection.c
    src/qjl_quantize_ref.c
    src/qjl_score_ref.c
    src/qjl_score_i8_ref.c
    src/qjl_dispatch.c
)

# Detect target arch and add the matching SIMD TUs. Each TU compiles only
# for its own arch; gcc/clang #if-out the body otherwise so a stray include
# of arm_neon.h on x86 (or vice-versa) is harmless. Within an arch the
# dispatcher picks AVX-VNNI vs AVX2 (resp. dotprod vs plain NEON) at
# runtime from cpuid/hwcap — see src/qjl_cpu_features.h.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    list(APPEND QJL_SRCS
        src/qjl_quantize_avx2.c src/qjl_score_avx2.c src/qjl_score_avxvnni.c)
    set(QJL_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    list(APPEND QJL_SRCS
        src/qjl_quantize_neon.c src/qjl_score_neon.c src/qjl_score_dotprod.c)
    set(QJL_ARM ON)
endif()

add_library(qjl STATIC ${QJL_SRCS})
target_include_directories(qjl PUBLIC include)
target_compile_options(qjl PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

if(QJL_X86)
    set_source_files_properties(
        src/qjl_quantize_avx2.c src/qjl_score_avx2.c
        PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma"
    )
    # AVX-VNNI: GCC 11+/Clang 12+ accept -mavxvnni. The TU also builds when
    # the toolchain only exposes the AVX512-VL VNNI flavour (the body picks
    # the right intrinsic). If neither is available the TU is a no-op.
    include(CheckCCompilerFlag)
    check_c_compiler_flag("-mavxvnni" QJL_CC_HAS_MAVXVNNI)
    target_compile_definitions(qjl PUBLIC QJL_HAVE_AVX2=1)
    if(QJL_CC_HAS_MAVXVNNI)
        set_source_files_properties(
            src/qjl_score_avxvnni.c
            PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma;-mavxvnni"
        )
        target_compile_definitions(qjl PUBLIC QJL_HAVE_AVXVNNI=1)
    else()
        set_source_files_properties(
            src/qjl_score_avxvnni.c PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma")
    endif()
endif()

# arm64 gcc/clang has NEON on by default; -mfpu=neon would be wrong on
# AArch64.
if(QJL_ARM)
    set_source_files_properties(
        src/qjl_quantize_neon.c src/qjl_score_neon.c
        PROPERTIES COMPILE_OPTIONS "-O3"
    )
    target_compile_definitions(qjl PUBLIC QJL_HAVE_NEON=1)
    include(CheckCCompilerFlag)
    check_c_compiler_flag("-march=armv8.4-a+dotprod" QJL_CC_HAS_DOTPROD)
    if(QJL_CC_HAS_DOTPROD)
        set_source_files_properties(
            src/qjl_score_dotprod.c
            PROPERTIES COMPILE_OPTIONS "-O3;-march=armv8.4-a+dotprod"
        )
        target_compile_definitions(qjl PUBLIC QJL_HAVE_NEON_DOTPROD=1)
    else()
        set_source_files_properties(
            src/qjl_score_dotprod.c PROPERTIES COMPILE_OPTIONS "-O3")
    endif()
endif()

add_executable(qjl_bench test/qjl_bench.c)
target_link_libraries(qjl_bench PRIVATE qjl m)
target_compile_options(qjl_bench PRIVATE -O3 -Wall -Wextra)

add_executable(qjl_int8_smoke test/qjl_int8_smoke.c)
target_link_libraries(qjl_int8_smoke PRIVATE qjl m)
target_compile_options(qjl_int8_smoke PRIVATE -O2 -Wall -Wextra)

add_executable(qjl_avxvnni_smoke test/qjl_avxvnni_smoke.c)
target_link_libraries(qjl_avxvnni_smoke PRIVATE qjl m)
target_compile_options(qjl_avxvnni_smoke PRIVATE -O2 -Wall -Wextra)

# qjl_fork_parity: dlopen the apothic/llama.cpp-1bit-turboquant fork's
# libggml-cpu.so and assert quantize_row_qjl1_256 produces bit-exact
# output against the standalone library's qjl_quantize_row_ref for 100
# random vectors. See test/qjl_fork_parity.c for usage.
add_executable(qjl_fork_parity test/qjl_fork_parity.c)
target_link_libraries(qjl_fork_parity PRIVATE qjl m ${CMAKE_DL_LIBS})
target_compile_options(qjl_fork_parity PRIVATE -O2 -Wall -Wextra)
