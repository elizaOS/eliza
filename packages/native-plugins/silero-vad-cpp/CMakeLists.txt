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
# directly (the eventual ggml-backed session will live in `src/` and
# include the same header).
include_directories(include src)

# The library mixes a stub for the model entry points with two real
# (non-stubbed) TUs:
#   * silero_vad_stub.c     — `open` / `reset_state` / `process` /
#                             `close` return -ENOSYS until the
#                             ggml-backed port lands. See AGENTS.md.
#   * silero_vad_state.c    — pure-C LSTM hidden/cell state helpers.
#                             Real today; the port consumes them.
#   * silero_vad_resample.c — pure-C linear PCM resampler. Real today;
#                             callers can use it before the model
#                             entry points become non-stub.
set(SILERO_VAD_SRCS
    src/silero_vad_stub.c
    src/silero_vad_state.c
    src/silero_vad_resample.c
)

add_library(silero_vad STATIC ${SILERO_VAD_SRCS})
target_include_directories(silero_vad PUBLIC include)
target_compile_options(silero_vad PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

enable_testing()

# Build-only smoke for the public stub ABI.
add_executable(silero_vad_stub_smoke test/silero_vad_stub_smoke.c)
target_link_libraries(silero_vad_stub_smoke PRIVATE silero_vad)
target_compile_options(silero_vad_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_stub_smoke COMMAND silero_vad_stub_smoke)

# Real test for the LSTM state helpers.
add_executable(silero_vad_state_test test/silero_vad_state_test.c)
target_link_libraries(silero_vad_state_test PRIVATE silero_vad)
target_compile_options(silero_vad_state_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_state_test COMMAND silero_vad_state_test)

# Real test for the linear PCM resampler. Links the math library for
# `fabsf`.
add_executable(silero_vad_resample_test test/silero_vad_resample_test.c)
target_link_libraries(silero_vad_resample_test PRIVATE silero_vad m)
target_compile_options(silero_vad_resample_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME silero_vad_resample_test COMMAND silero_vad_resample_test)
