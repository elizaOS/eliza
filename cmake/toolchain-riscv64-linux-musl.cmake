# Zig-driven riscv64 / linux-musl cross-compile toolchain.
#
# Usage:
#   ZIG_BIN=$(command -v zig) \
#     cmake -B build/riscv64 \
#       -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-riscv64-linux-musl.cmake
#
# Zig 0.14+ is the recommended floor: it accepts the GCC-style
# `-march=rv64gc` ISA string and ships an LLVM with RVV 1.0 support
# Wave 3 will rely on. Zig 0.13 only accepts CPU names via `-mcpu=`
# (e.g. `baseline_rv64`, `generic_rv64`) — the default triple-derived
# CPU is already rv64gc/lp64d, so Wave 1 scalar parity works there too.
# Override MILADY_RISCV_MARCH at the cmake command line if you want
# to pin a specific Zig-accepted march (e.g.
# `-DMILADY_RISCV_MARCH=-mcpu=generic_rv64`).
set(CMAKE_SYSTEM_NAME      Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)

if(NOT DEFINED ENV{ZIG_BIN})
    message(FATAL_ERROR
        "Set ZIG_BIN to a Zig 0.14+ binary path before invoking cmake "
        "(e.g. `ZIG_BIN=$(command -v zig)`).")
endif()

# `zig cc` and `zig c++` are full cross-compilers; the target triple
# lives on the compiler command line so it is inherited by every TU.
# Wave 1 leaves -march/-mcpu unset so Zig uses its triple-default
# (rv64gc, lp64d), which is what we want for scalar parity. Wave 3
# RVV work adds an explicit `-march=rv64gcv` (Zig 0.14+) by setting
# MILADY_RISCV_MARCH below.
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
