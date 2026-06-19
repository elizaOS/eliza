# Android NDK arm64-v8a (aarch64) cross-compile toolchain.
#
# Usage:
#   ANDROID_NDK_ROOT=/path/to/android-ndk \
#     cmake -B build/android-arm64 \
#       -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-android-arm64.cmake \
#       -S packages/native/plugins/<silero-vad-cpp|voice-classifier-cpp>
#
# This targets `arm64-v8a` — the ABI of every shipping Android phone (incl.
# the Pixel 9a). The voice native libs (silero-vad-cpp, voice-classifier-cpp)
# are pure scalar C with NO arch intrinsics, so the same source list that
# builds on x86_64/riscv64 builds here unchanged — only the toolchain differs.
#
# NDK floor: any r23+ NDK has a stable aarch64-linux-android sysroot. The
# API level floor is 26 (Android 8) — comfortably below the app's minSdk and
# the lowest level the WeSpeaker/Silero scalar kernels need. Override
# CMAKE_ANDROID_API on the command line to match a different minSdk.
set(CMAKE_SYSTEM_NAME       Android)
set(CMAKE_SYSTEM_PROCESSOR  aarch64)
set(CMAKE_ANDROID_ARCH_ABI  arm64-v8a)

if(NOT DEFINED ENV{ANDROID_NDK_ROOT})
    message(FATAL_ERROR
        "Set ANDROID_NDK_ROOT to an Android NDK install before invoking cmake.")
endif()
set(CMAKE_ANDROID_NDK $ENV{ANDROID_NDK_ROOT})

# These libs are pure C; c++_shared is harmless but unnecessary. The default
# STL is fine. Pin the API level the same way the riscv64 toolchain does.
set(CMAKE_ANDROID_API       26)
