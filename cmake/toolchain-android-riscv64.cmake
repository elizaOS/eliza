# Android NDK riscv64 cross-compile toolchain.
#
# Usage:
#   ANDROID_NDK_ROOT=/path/to/android-ndk-r27 \
#     cmake -B build/android-riscv64 \
#       -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-android-riscv64.cmake
#
# NDK floor: r27 (Sep-2024) is the first stable NDK with first-class
# riscv64-linux-android sysroots and an unprefixed `riscv64` ABI name.
# r26 shipped a developer-preview riscv64 sysroot only and the NDK
# tooling required out-of-tree patches; we explicitly do NOT support
# r26 here. The platform API level floor is 35 (Android 15) since that
# is the minimum riscv64 device target Google ships official images
# for. Override CMAKE_ANDROID_API on the command line if your project
# pins a different minSdk.
set(CMAKE_SYSTEM_NAME       Android)
set(CMAKE_SYSTEM_PROCESSOR  riscv64)
set(CMAKE_ANDROID_ARCH_ABI  riscv64)

if(NOT DEFINED ENV{ANDROID_NDK_ROOT})
    message(FATAL_ERROR
        "Set ANDROID_NDK_ROOT to an NDK r27+ install before invoking cmake.")
endif()
set(CMAKE_ANDROID_NDK $ENV{ANDROID_NDK_ROOT})

set(CMAKE_ANDROID_STL_TYPE  c++_shared)
set(CMAKE_ANDROID_API       35)

# rv64gcv1p0 = rv64gc + V 1.0 (the ratified vector extension Android NDK
# r27 ships clang support for). lp64d is the standard double-precision
# ILP64 ABI; the NDK only supports lp64d. Wave 1 builds run scalar but
# we still enable V at the codegen level so the same toolchain works
# unchanged when Wave 3 lights up the RVV TUs.
set(CMAKE_C_FLAGS_INIT   "-march=rv64gcv1p0 -mabi=lp64d")
set(CMAKE_CXX_FLAGS_INIT "-march=rv64gcv1p0 -mabi=lp64d")
