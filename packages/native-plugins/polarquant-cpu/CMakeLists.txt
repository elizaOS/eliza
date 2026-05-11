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

# Detect target arch and add the matching SIMD TU.  Each TU compiles
# only for its own arch; gcc/clang #if-out the body otherwise so a
# stray include of arm_neon.h on x86 (or vice-versa) is harmless.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    list(APPEND POLARQUANT_SRCS
        src/polar_dequantize_avx2.c
        src/polar_dot_avx2.c)
    set(POLARQUANT_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    list(APPEND POLARQUANT_SRCS
        src/polar_dequantize_neon.c
        src/polar_dot_neon.c)
    set(POLARQUANT_ARM ON)
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
        src/polar_dequantize_avx2.c src/polar_dot_avx2.c
        PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma"
    )
    target_compile_definitions(polarquant PUBLIC POLARQUANT_HAVE_AVX2=1)
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
