# Zig-driven riscv64 / linux-musl cross-compile toolchain.
#
# Usage:
#   ZIG_BIN=$(command -v zig) \
#     cmake -B build/riscv64 \
#       -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-riscv64-linux-musl.cmake
#
# Zig version policy
# ------------------
# Zig 0.14+ is the recommended floor for RVV builds: it accepts the
# GCC-style `-march=rv64gc[v_zfh_zvfh_zicbop_zihintpause]` ISA string the
# vendored llama.cpp's ggml-cpu/CMakeLists.txt hard-codes when
# GGML_RVV / GGML_RV_ZFH / etc. are ON, and ships an LLVM with full
# RVV 1.0 intrinsic support (the codepaths in
# ggml/src/ggml-cpu/arch/riscv/quants.c).
#
# Zig 0.13 only accepts CPU names via `-mcpu=` (e.g. `baseline_rv64`,
# `generic_rv64`) and rejects every `-march=rv64gc*` form with
# "unknown CPU". The default triple-derived CPU is already rv64gc/lp64d,
# so scalar parity works there too — but RVV is unreachable. The Android
# build path (packages/app-core/scripts/aosp/compile-libllama.mjs)
# detects the Zig version via resolveRiscv64BuildPlan() and forces every
# GGML_RV* option OFF below MIN_ZIG_RVV_VERSION (0.14.0) so MARCH_STR
# collapses to `rv64gc`, which the per-ABI zig-cc driver script then
# strips entirely.
#
# Override knob
# -------------
# Set MILADY_RISCV_MARCH at the cmake command line to pin a specific
# Zig-accepted march/mcpu (e.g. `-DMILADY_RISCV_MARCH=-mcpu=generic_rv64`
# on Zig 0.13, or `-DMILADY_RISCV_MARCH=-march=rv64gcv` on Zig 0.14+).
# Leave it unset to use Zig's triple-derived default (rv64gc/lp64d).
#
# GGML_CPU_ALL_VARIANTS
# ---------------------
# The vendored llama.cpp supports GGML_CPU_ALL_VARIANTS on Linux/riscv64
# (ggml/src/CMakeLists.txt:474-480): it builds two libggml-cpu-riscv64_*.so
# variants (scalar + RVV) and the loader picks one via riscv_hwprobe at
# runtime (ggml/src/ggml-cpu/arch/riscv/cpu-feats.cpp). Enabling it requires
# GGML_BACKEND_DL=ON, which changes the artifact layout. The Android build
# script keeps this opt-in via MILADY_GGML_CPU_ALL_VARIANTS=1 until the
# arm64/x86_64 loader plumbing for the DL-backend dispatch is verified too.
set(CMAKE_SYSTEM_NAME      Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)

if(NOT DEFINED ENV{ZIG_BIN})
    message(FATAL_ERROR
        "Set ZIG_BIN to a Zig 0.14+ binary path before invoking cmake "
        "(e.g. `ZIG_BIN=$(command -v zig)`). Zig 0.13 builds a scalar-only "
        "binary; pass -DMILADY_RISCV_MARCH=-mcpu=generic_rv64 there.")
endif()

# `zig cc` and `zig c++` are full cross-compilers; the target triple
# lives on the compiler command line so it is inherited by every TU.
# We leave -march/-mcpu unset by default so Zig uses its triple-default
# (rv64gc, lp64d) — that matches MIN_ZIG_VERSION=0.13 scalar parity.
# For an RVV build on Zig 0.14+, pass
# `-DMILADY_RISCV_MARCH=-march=rv64gcv_zfh_zvfh_zicbop_zihintpause`
# at the cmake command line (the Android wrapper sets this automatically
# via the per-ABI zig-cc driver script).
if(NOT DEFINED MILADY_RISCV_MARCH)
    set(MILADY_RISCV_MARCH "")
endif()
set(CMAKE_C_COMPILER   $ENV{ZIG_BIN} cc  -target riscv64-linux-musl ${MILADY_RISCV_MARCH})
set(CMAKE_CXX_COMPILER $ENV{ZIG_BIN} c++ -target riscv64-linux-musl ${MILADY_RISCV_MARCH})

# Standard CMake cross-compile root-path rules: host programs are still
# usable (so cmake's own utilities run), but libraries / headers are
# only picked up from the target sysroot. Zig manages the sysroot
# internally so we don't override CMAKE_FIND_ROOT_PATH.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
