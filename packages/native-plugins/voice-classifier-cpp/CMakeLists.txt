cmake_minimum_required(VERSION 3.16)
project(voice_classifier_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include)

# ---------------------------------------------------------------------------
# Source files
# ---------------------------------------------------------------------------
#
# One library, three model heads. Each head lives in its own translation
# unit so the J1.a/J1.b/J1.c real GGML graphs can replace them
# independently without touching the others. The shared utilities
# (class-name table, cosine distance helper, mel front-end,
# diagnostics) stay in their own TUs.
#
# Today the per-head TUs are GGUF-aware loaders that validate the
# bundle's metadata block and return `-ENOSYS` from the forward-pass
# entry points (real graphs come in J1.a / J1.b / J1.c). The TS GGML
# surfaces (`*-ggml.ts`) can still dlopen the SHARED library, call
# `*_open(gguf_path, &h)` to validate that the GGUF parses, and surface
# a structured error (rather than the bare construction-time exception
# they raise today) when the forward graph is missing.

set(VOICE_CLASSIFIER_SRCS
    src/voice_emotion.c
    src/voice_speaker.c
    src/voice_eot.c
    src/voice_diarizer.c
    src/voice_classifier_diagnostics.c
    src/voice_emotion_classes.c
    src/voice_speaker_distance.c
    src/voice_mel_features.c
    src/voice_gguf_loader.c
    src/voice_gguf_tensors.c
)

# ---------------------------------------------------------------------------
# Shared + static targets
# ---------------------------------------------------------------------------
#
# The SHARED library is what `bun:ffi` dlopens from the TS GGML
# surfaces (mirrors silero-vad-cpp's two-target layout). The STATIC
# variant is kept for ctest harnesses that prefer it (smaller binaries,
# no rpath gymnastics).

add_library(voice_classifier_shared SHARED ${VOICE_CLASSIFIER_SRCS})
set_target_properties(voice_classifier_shared PROPERTIES
    OUTPUT_NAME "voice_classifier"
    C_VISIBILITY_PRESET hidden)
target_include_directories(voice_classifier_shared PUBLIC include)
target_compile_options(voice_classifier_shared PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter -fvisibility=hidden)
target_compile_definitions(voice_classifier_shared PRIVATE VOICE_CLASSIFIER_BUILD_SHARED=1)
target_link_libraries(voice_classifier_shared PUBLIC m)

add_library(voice_classifier STATIC ${VOICE_CLASSIFIER_SRCS})
target_include_directories(voice_classifier PUBLIC include)
target_compile_options(voice_classifier PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(voice_classifier PUBLIC m)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

enable_testing()

add_executable(voice_classifier_stub_smoke test/voice_classifier_stub_smoke.c)
target_link_libraries(voice_classifier_stub_smoke PRIVATE voice_classifier)
target_compile_options(voice_classifier_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_classifier_stub_smoke COMMAND voice_classifier_stub_smoke)

add_executable(voice_emotion_classes_test test/voice_emotion_classes_test.c)
target_link_libraries(voice_emotion_classes_test PRIVATE voice_classifier)
target_compile_options(voice_emotion_classes_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_emotion_classes_test COMMAND voice_emotion_classes_test)

add_executable(voice_speaker_distance_test test/voice_speaker_distance_test.c)
target_link_libraries(voice_speaker_distance_test PRIVATE voice_classifier)
target_compile_options(voice_speaker_distance_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_speaker_distance_test COMMAND voice_speaker_distance_test)

add_executable(voice_mel_features_test test/voice_mel_features_test.c)
target_link_libraries(voice_mel_features_test PRIVATE voice_classifier)
target_compile_options(voice_mel_features_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_mel_features_test COMMAND voice_mel_features_test)

# GGUF-loader smoke test: confirms the metadata-validation path is
# real (opens a hand-rolled GGUF with the right metadata block,
# rejects ones with wrong sample rate / class count / etc).
add_executable(voice_gguf_loader_test test/voice_gguf_loader_test.c)
target_link_libraries(voice_gguf_loader_test PRIVATE voice_classifier)
target_compile_options(voice_gguf_loader_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_gguf_loader_test COMMAND voice_gguf_loader_test)

# K3 — pyannote-3 forward parity gate. Loads the GGUF emitted by
# scripts/voice_diarizer_to_gguf.py and asserts ≥ 99% per-frame label
# agreement against the ONNX reference (labels precomputed into
# test/voice_diarizer_parity_fixtures.h). Skipped when GGUF/fixtures
# are absent so devs without HF_TOKEN can still run the unit suite.
add_executable(voice_diarizer_parity_test test/voice_diarizer_parity_test.c)
target_link_libraries(voice_diarizer_parity_test PRIVATE voice_classifier)
target_compile_options(voice_diarizer_parity_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME voice_diarizer_parity_test COMMAND voice_diarizer_parity_test)
set_tests_properties(voice_diarizer_parity_test PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
)
