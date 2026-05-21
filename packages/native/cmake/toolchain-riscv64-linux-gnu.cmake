# Zig-driven riscv64 / linux-gnu cross-compile toolchain.
#
# Sibling of toolchain-riscv64-linux-musl.cmake — same Zig driver, same
# scalar-first policy, but targets the GNU/glibc ABI for desktop Linux
# riscv64 distros (Debian sid, Fedora rawhide, Ubuntu 24.04 riscv64) and
# the Node.js unofficial-builds tarballs (linux-riscv64-glibc — see
# https://unofficial-builds.nodejs.org/). Use this when the consumer is
# a glibc-linked process (Node 24, system bun source-build, llama.cpp
# linked to system OpenBLAS) rather than the bun-on-Android musl path.
#
# Usage:
#   ZIG_BIN=$(command -v zig) \
#     cmake -B build/riscv64-gnu \
#       -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-riscv64-linux-gnu.cmake
#
# Zig 0.14+ is the recommended floor (same reasoning as the musl variant:
# `-march=rv64gc` accepted directly, LLVM ships RVV 1.0 codegen). Override
# ELIZA_RISCV_MARCH on the command line to pin a specific ISA string;
# Wave 1 leaves it empty so Zig's triple-default rv64gc/lp64d wins.
set(CMAKE_SYSTEM_NAME      Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)

if(NOT DEFINED ENV{ZIG_BIN})
    message(FATAL_ERROR
        "Set ZIG_BIN to a Zig 0.14+ binary path before invoking cmake "
        "(e.g. `ZIG_BIN=$(command -v zig)`).")
endif()

if(NOT DEFINED ELIZA_RISCV_MARCH)
    set(ELIZA_RISCV_MARCH "")
endif()
set(CMAKE_C_COMPILER   $ENV{ZIG_BIN} cc  -target riscv64-linux-gnu ${ELIZA_RISCV_MARCH})
set(CMAKE_CXX_COMPILER $ENV{ZIG_BIN} c++ -target riscv64-linux-gnu ${ELIZA_RISCV_MARCH})

# Zig bundles a glibc sysroot internally — same root-path policy as the
# musl variant: host programs callable, target libraries / headers only.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
