cmake_minimum_required(VERSION 3.16)
project(silero_vad_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# `include` for the public ABI; `src` so the state-management TU can
# expose its internal header to the unit test that exercises it
# directly (the runtime in `silero_vad_runtime.c` includes the same
# header).
include_directories(include src)

# Phase 2: the model entry points are real. The stub is gone. We keep
# the resampler + state-management TUs as they were — both are still
# pure-C utilities the runtime uses.
set(SILERO_VAD_SRCS
    src/silero_vad_runtime.c
    src/silero_vad_state.c
    src/silero_vad_resample.c
)

# Build BOTH a static library (consumed by ctest binaries and any
# in-tree C++ caller) and a shared library (dlopen'd by the bun:ffi
# binding in `plugins/plugin-local-inference/src/services/voice/vad-ggml.ts`).
add_library(silero_vad        STATIC ${SILERO_VAD_SRCS})
add_library(silero_vad_shared SHARED ${SILERO_VAD_SRCS})
set_target_properties(silero_vad_shared PROPERTIES
    OUTPUT_NAME silero_vad
    POSITION_INDEPENDENT_CODE ON
)
target_include_directories(silero_vad        PUBLIC include)
target_include_directories(silero_vad_shared PUBLIC include)
target_compile_options(silero_vad        PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_compile_options(silero_vad_shared PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# libm for sqrtf/expf/tanhf used by the runtime kernels.
target_link_libraries(silero_vad        PUBLIC m)
target_link_libraries(silero_vad_shared PUBLIC m)

enable_testing()

# Build-only smoke for the public ABI (now backed by the real runtime —
# `silero_vad_open` against a missing path returns -ENOENT, etc.).
add_executable(silero_vad_stub_smoke test/silero_vad_stub_smoke.c)
target_link_libraries(silero_vad_stub_smoke PRIVATE silero_vad)
target_compile_options(silero_vad_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_stub_smoke COMMAND silero_vad_stub_smoke)

# Real test for the LSTM state helpers.
add_executable(silero_vad_state_test test/silero_vad_state_test.c)
target_link_libraries(silero_vad_state_test PRIVATE silero_vad)
target_compile_options(silero_vad_state_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_state_test COMMAND silero_vad_state_test)

# Real test for the linear PCM resampler.
add_executable(silero_vad_resample_test test/silero_vad_resample_test.c)
target_link_libraries(silero_vad_resample_test PRIVATE silero_vad)
target_compile_options(silero_vad_resample_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_resample_test COMMAND silero_vad_resample_test)

# Phase 2 runtime test: load a fixture GGUF (dropped by the converter
# into ${CMAKE_BINARY_DIR}/silero-vad-v5.gguf if the operator runs the
# converter before ctest), run two windows (silence + synthetic
# speech-like noise), assert the silence prob < the noise prob and
# both stay in [0, 1]. The test refuses to run without the fixture so
# a missing GGUF cannot pass for "OK".
add_executable(silero_vad_runtime_test test/silero_vad_runtime_test.c)
target_link_libraries(silero_vad_runtime_test PRIVATE silero_vad)
target_compile_options(silero_vad_runtime_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_runtime_test
         COMMAND silero_vad_runtime_test
                 ${CMAKE_BINARY_DIR}/silero-vad-v5.gguf)
