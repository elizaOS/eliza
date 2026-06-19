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
# only for its own arch; gcc/clang #if-out the body otherwise so a
# stray include of riscv_vector.h on x86 (or vice-versa) is harmless.
# Within an arch the dispatcher picks the available lane at runtime
# from cpuid / hwcap / hwprobe (see src/tbq_cpu_features.h).
#
# Today only the riscv64 RVV TUs exist. The dispatch shell handles all
# four lanes (REF / NEON / AVX2 / RVV) so NEON / AVX2 sister kernels
# can slot in later without rewiring call sites.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|amd64|AMD64)")
    set(TURBOQUANT_X86 ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(aarch64|arm64)")
    set(TURBOQUANT_ARM ON)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "(riscv64|riscv|rv64)")
    list(APPEND TURBOQUANT_SRCS
        src/tbq_encode_rvv.c
        src/tbq_decode_rvv.c)
    set(TURBOQUANT_RISCV ON)
endif()

add_library(turboquant STATIC ${TURBOQUANT_SRCS})
target_include_directories(turboquant PUBLIC include)
target_compile_options(turboquant PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(turboquant PUBLIC m)

# riscv64: RVV intrinsic kernels need an ISA string that enables the V
# extension. Two compiler dialects exist:
#
#   * gcc / clang >= 15 / zig >= 0.14 accept the GCC-style
#     `-march=rv64gcv1p0`. This makes no assumption about VLEN beyond
#     the RVV spec minimum (VLEN >= 128) so the resulting code is
#     portable across every conforming RVV 1.0 implementation.
#
#   * zig 0.13's bundled clang only accepts `-mcpu=` CPU names; the
#     gcc-style march is rejected with "unknown CPU". Use the generic
#     `-mcpu=generic_rv64+v+m+a+f+d+c` (rv64gc + V), which also avoids
#     the per-CPU VLEN assumptions LLVM bakes in for named cores
#     (`-mcpu=sifive_x280` advertises VLEN=512 via the zvl512b
#     attribute; LLVM's loop vectoriser emits unrolled m1/m2 sequences
#     that silently truncate at VLEN=128, e.g. under qemu-user). The
#     generic CPU has no zvl* attribute so the auto-vectoriser uses
#     vsetvli loops that are correct at every VLEN >= 128.
#
# Override knob: pass `-DTURBOQUANT_RVV_FLAGS=...` at the cmake command
# line to pin a specific flag (e.g. for a known target microarch).
if(TURBOQUANT_RISCV)
    target_compile_definitions(turboquant PUBLIC TBQ_HAVE_RVV=1)
    target_compile_definitions(turboquant PRIVATE TBQ_ARCH_RISCV=1)
    if(NOT DEFINED TURBOQUANT_RVV_FLAGS)
        # Detect whether the active compiler accepts -march=rv64gcv1p0;
        # if not, fall back to zig 0.13's -mcpu=generic_rv64+v form.
        include(CheckCSourceCompiles)
        set(CMAKE_REQUIRED_FLAGS "-march=rv64gcv1p0 -mabi=lp64d")
        check_c_source_compiles("int main(void){return 0;}" TURBOQUANT_RVV_MARCH_OK)
        unset(CMAKE_REQUIRED_FLAGS)
        if(TURBOQUANT_RVV_MARCH_OK)
            set(TURBOQUANT_RVV_FLAGS "-march=rv64gcv1p0;-mabi=lp64d")
        else()
            set(TURBOQUANT_RVV_FLAGS "-mcpu=generic_rv64+v+m+a+f+d+c")
        endif()
    endif()
    set_source_files_properties(
        src/tbq_encode_rvv.c src/tbq_decode_rvv.c
        PROPERTIES COMPILE_OPTIONS "${TURBOQUANT_RVV_FLAGS}"
    )
endif()

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
# and the currently linked SIMD path (RVV on riscv64, ref-only on x86 /
# ARM until those sister kernels land). Cross-checks encode-ref / decode-
# SIMD and encode-SIMD / decode-ref against the scalar round-trip across
# the canonical block lengths 32..1024.
add_executable(turboquant_simd_parity test/turboquant_simd_parity.c)
target_link_libraries(turboquant_simd_parity PRIVATE turboquant)
target_compile_options(turboquant_simd_parity PRIVATE -O2 -Wall -Wextra)

enable_testing()
add_test(NAME turboquant_smoke COMMAND turboquant_smoke)
add_test(NAME turboquant_simd_parity COMMAND turboquant_simd_parity)
