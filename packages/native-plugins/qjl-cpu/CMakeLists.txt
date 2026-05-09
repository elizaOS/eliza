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
    src/qjl_dispatch.c
)

# Detect target arch and add the matching SIMD TU. Each TU compiles only
# for its own arch; gcc/clang #if-out the body otherwise so a stray include
# of arm_neon.h on x86 (or vice-versa) is harmless.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    list(APPEND QJL_SRCS src/qjl_quantize_avx2.c src/qjl_score_avx2.c)
    set(QJL_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    list(APPEND QJL_SRCS src/qjl_quantize_neon.c src/qjl_score_neon.c)
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
    target_compile_definitions(qjl PUBLIC QJL_HAVE_AVX2=1)
endif()

# arm64 gcc/clang has NEON on by default; -mfpu=neon would be wrong on
# AArch64. We do, however, want -mcpu=generic+fp+simd for clarity.
if(QJL_ARM)
    set_source_files_properties(
        src/qjl_quantize_neon.c src/qjl_score_neon.c
        PROPERTIES COMPILE_OPTIONS "-O3"
    )
    target_compile_definitions(qjl PUBLIC QJL_HAVE_NEON=1)
endif()

add_executable(qjl_bench test/qjl_bench.c)
target_link_libraries(qjl_bench PRIVATE qjl m)
target_compile_options(qjl_bench PRIVATE -O3 -Wall -Wextra)
