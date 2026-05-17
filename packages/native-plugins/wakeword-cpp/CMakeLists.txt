cmake_minimum_required(VERSION 3.16)
project(wakeword_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Phase 2: real runtime (`wakeword_runtime.c`) replaces the ENOSYS stub.
# The melspec + window TUs are pure-C utilities the runtime uses.
set(WAKEWORD_SRCS
    src/wakeword_runtime.c
    src/wakeword_melspec.c
    src/wakeword_window.c
)

# Build BOTH a static library (consumed by ctest binaries and any
# in-tree caller) and a shared library (dlopen'd by the bun:ffi
# binding in `plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts`).
add_library(wakeword        STATIC ${WAKEWORD_SRCS})
add_library(wakeword_shared SHARED ${WAKEWORD_SRCS})
set_target_properties(wakeword_shared PROPERTIES
    OUTPUT_NAME wakeword
    POSITION_INDEPENDENT_CODE ON
)
target_include_directories(wakeword        PUBLIC include)
target_include_directories(wakeword_shared PUBLIC include)
target_compile_options(wakeword        PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_compile_options(wakeword_shared PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# libm for cosf/sinf/logf/expf/sqrtf/log10f/powf used by the runtime kernels.
target_link_libraries(wakeword        PUBLIC m)
target_link_libraries(wakeword_shared PUBLIC m)

enable_testing()

# Build-only smoke for the public ABI (now backed by the real runtime —
# `wakeword_open` against a missing path returns -ENOENT, etc.).
add_executable(wakeword_stub_smoke test/wakeword_stub_smoke.c)
target_link_libraries(wakeword_stub_smoke PRIVATE wakeword)
target_compile_options(wakeword_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_stub_smoke COMMAND wakeword_stub_smoke)

# Spectral correctness: legacy mode (no GGUF) on a 1 kHz / 4 kHz tone.
add_executable(wakeword_melspec_test test/wakeword_melspec_test.c)
target_link_libraries(wakeword_melspec_test PRIVATE wakeword)
target_compile_options(wakeword_melspec_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_melspec_test COMMAND wakeword_melspec_test)

# Sliding-window framing correctness.
add_executable(wakeword_window_test test/wakeword_window_test.c)
target_link_libraries(wakeword_window_test PRIVATE wakeword)
target_compile_options(wakeword_window_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_window_test COMMAND wakeword_window_test)

# Phase 2 runtime test: opens the three GGUFs the converter writes,
# pushes silence + a synthetic chirp, asserts honest score gates. The
# test refuses to run without the GGUFs (a missing fixture must NOT
# pass for "OK"). Drop them under ${CMAKE_BINARY_DIR}/wakeword/<phrase>.{melspec,embedding,classifier}.gguf
# before running ctest by invoking
#   python3 packages/native-plugins/wakeword-cpp/scripts/wakeword_to_gguf.py \
#     --melspec-onnx ... --embedding-onnx ... --classifier-onnx ... \
#     --phrase "hey eliza" --out-dir <CMAKE_BINARY_DIR>/wakeword
add_executable(wakeword_runtime_test test/wakeword_runtime_test.c)
target_link_libraries(wakeword_runtime_test PRIVATE wakeword)
target_compile_options(wakeword_runtime_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_runtime_test
         COMMAND wakeword_runtime_test
                 ${CMAKE_BINARY_DIR}/wakeword/hey-eliza.melspec.gguf
                 ${CMAKE_BINARY_DIR}/wakeword/hey-eliza.embedding.gguf
                 ${CMAKE_BINARY_DIR}/wakeword/hey-eliza.classifier.gguf)

# Optional parity test: drives the C runtime AND the openWakeWord
# ONNX bundle through onnxruntime, asserts agreement within ±0.15 per
# chunk on three synthetic clips. Requires `python3`, `onnxruntime`,
# `numpy`, `onnx`, the three GGUFs, and the matching ONNX bundle.
# The test exit-codes 77 (CMake's SKIP) when prerequisites are
# missing, so a CI without onnxruntime + ONNX bundle does not block
# the rest of the suite.
find_package(Python3 COMPONENTS Interpreter)
if(Python3_Interpreter_FOUND)
    add_test(NAME wakeword_parity_test
             COMMAND ${Python3_EXECUTABLE}
                     ${CMAKE_CURRENT_SOURCE_DIR}/test/wakeword_parity_test.py
                     --libwakeword       ${CMAKE_BINARY_DIR}/libwakeword.so
                     --gguf-dir          ${CMAKE_BINARY_DIR}/wakeword
                     --phrase-slug       hey-eliza
                     --onnx-dir          ${CMAKE_SOURCE_DIR}/../../../artifacts/hf-eliza1-voice-consolidation/voice/wakeword
                     --classifier-onnx   hey-eliza-int8.onnx)
    set_tests_properties(wakeword_parity_test PROPERTIES SKIP_RETURN_CODE 77)
endif()
