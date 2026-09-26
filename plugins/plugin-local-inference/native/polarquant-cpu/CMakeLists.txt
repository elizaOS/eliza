cmake_minimum_required(VERSION 3.16)
project(polarquant_cpu C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Always-built scalar reference + dispatcher.
set(POLARQUANT_SRCS
    src/polar_hadamard.c
    src/polar_qjl.c
    src/polar_quantize_ref.c
    src/polar_dequantize_ref.c
    src/polar_dot_ref.c
    src/polar_dot_preht_ref.c
    src/polar_dispatch.c
)

# Detect target arch and add the matching SIMD TUs.  Each TU compiles
# only for its own arch; gcc/clang #if-out the body otherwise so a
# stray include of arm_neon.h on x86 (or vice-versa) is harmless.
# Within an arch the dispatcher picks AVX-VNNI vs AVX2 (resp. dotprod
# vs plain NEON) at runtime from cpuid/hwcap (see src/polar_cpu_features.h).
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    list(APPEND POLARQUANT_SRCS
        src/polar_dequantize_avx2.c
        src/polar_dot_avx2.c
        src/polar_dot_preht_avx2.c)
    set(POLARQUANT_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    list(APPEND POLARQUANT_SRCS
        src/polar_dequantize_neon.c
        src/polar_dot_neon.c
        src/polar_dot_preht_neon.c)
    set(POLARQUANT_ARM ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(riscv64|riscv|rv64)")
    # Wave 3: RVV 1.0 kernels.  The TUs themselves are gated on
    # __riscv_v_intrinsic so a host-CPU build without -march=rv64gcv
    # still produces empty objects; per-source COMPILE_OPTIONS below
    # add the RVV march/abi for these TUs only.
    list(APPEND POLARQUANT_SRCS
        src/polar_dequant_rvv.c
        src/polar_dot_rvv.c
        src/polar_dot_preht_rvv.c)
    set(POLARQUANT_RISCV ON)
endif()

add_library(polarquant STATIC ${POLARQUANT_SRCS})
target_include_directories(polarquant PUBLIC include)
target_link_libraries(polarquant PUBLIC m)

target_compile_options(polarquant PRIVATE
    -Wall
    -Wextra
    -Wpedantic
    -Wno-unused-parameter
    -O3
    -ffast-math
)

if(POLARQUANT_X86)
    set_source_files_properties(
        src/polar_dequantize_avx2.c src/polar_dot_avx2.c src/polar_dot_preht_avx2.c
        PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma"
    )
    target_compile_definitions(polarquant PUBLIC POLARQUANT_HAVE_AVX2=1)
endif()

# riscv64 path with RVV 1.0 kernels.
#
# We pin per-source compile options to a portable rv64gcv string so the
# RVV TUs always see the V extension regardless of whatever -march the
# rest of the library was built with (the scalar TUs intentionally stay
# at rv64gc so they run on hosts without RVV; the dispatcher reads
# has_rvv via riscv_hwprobe(2) to decide which path to call).
#
# Zig 0.14+: gcc-style `-march=rv64gcv1p0` is accepted.  Zig 0.13 only
# takes CPU names via `-mcpu`; we use `-mcpu=generic_rv64+v` there.
# ELIZA_RISCV_RVV_FLAG lets the caller override (e.g. `-march=rv64gcv`
# for native GCC/Clang).
if(POLARQUANT_RISCV)
    target_compile_definitions(polarquant PUBLIC POLARQUANT_HAVE_RVV=1)
    target_compile_definitions(polarquant PRIVATE POLARQUANT_ARCH_RISCV=1)

    if(NOT DEFINED ELIZA_RISCV_RVV_FLAGS)
        # Detect whether the active compiler accepts -march=rv64gcv1p0;
        # if not, fall back to Zig 0.13's `-mcpu=generic_rv64+v`.
        include(CheckCSourceCompiles)
        set(CMAKE_REQUIRED_FLAGS "-march=rv64gcv1p0 -mabi=lp64d")
        check_c_source_compiles("int main(void){return 0;}" POLARQUANT_RVV_MARCH_OK)
        unset(CMAKE_REQUIRED_FLAGS)
        if(POLARQUANT_RVV_MARCH_OK)
            set(ELIZA_RISCV_RVV_FLAGS "-march=rv64gcv1p0;-mabi=lp64d")
        else()
            set(ELIZA_RISCV_RVV_FLAGS "-mcpu=generic_rv64+v")
        endif()
    endif()

    set_source_files_properties(
        src/polar_dequant_rvv.c
        src/polar_dot_rvv.c
        src/polar_dot_preht_rvv.c
        PROPERTIES COMPILE_OPTIONS "${ELIZA_RISCV_RVV_FLAGS}"
    )
endif()

# AArch64 gcc/clang has NEON on by default; -mfpu=neon would be wrong
# on AArch64.  We do still want the public POLARQUANT_HAVE_NEON define
# so the dispatcher routes to it.
if(POLARQUANT_ARM)
    set_source_files_properties(
        src/polar_dequantize_neon.c src/polar_dot_neon.c
        PROPERTIES COMPILE_OPTIONS "-O3"
    )
    target_compile_definitions(polarquant PUBLIC POLARQUANT_HAVE_NEON=1)
endif()

enable_testing()

add_executable(polar_roundtrip_test test/polar_roundtrip_test.c)
target_link_libraries(polar_roundtrip_test PRIVATE polarquant)
add_test(NAME polar_roundtrip COMMAND polar_roundtrip_test)

add_executable(polar_dot_test test/polar_dot_test.c)
target_link_libraries(polar_dot_test PRIVATE polarquant)
add_test(NAME polar_dot COMMAND polar_dot_test)

add_executable(polar_preht_dot_test test/polar_preht_dot_test.c)
target_link_libraries(polar_preht_dot_test PRIVATE polarquant)
add_test(NAME polar_preht_dot COMMAND polar_preht_dot_test)

add_executable(polar_simd_parity_test test/polar_simd_parity_test.c)
target_link_libraries(polar_simd_parity_test PRIVATE polarquant)
add_test(NAME polar_simd_parity COMMAND polar_simd_parity_test)

add_executable(polar_preht_simd_parity_test test/polar_preht_simd_parity_test.c)
target_link_libraries(polar_preht_simd_parity_test PRIVATE polarquant)
add_test(NAME polar_preht_simd_parity COMMAND polar_preht_simd_parity_test)

# Microbenchmark (not a CTest — run manually with --throughput).
add_executable(polar_bench test/polar_bench.c)
target_link_libraries(polar_bench PRIVATE polarquant)
target_compile_options(polar_bench PRIVATE -O3)
