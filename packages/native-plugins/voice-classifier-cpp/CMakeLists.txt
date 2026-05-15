cmake_minimum_required(VERSION 3.16)
project(voice_classifier_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include)

# One library, three model heads. Today the model entry points
# (`voice_emotion_*`, `voice_eot_*`, `voice_speaker_open` /
# `voice_speaker_embed` / `voice_speaker_close`) are stubbed in
# `src/voice_classifier_stub.c`; the class-name table, the cosine
# distance helper, and the mel front-end are real implementations and
# stay in their own translation units. The eventual ggml-backed port
# replaces the stub TU with three model TUs without changing the ABI.
set(VOICE_CLASSIFIER_SRCS
    src/voice_classifier_stub.c
    src/voice_emotion_classes.c
    src/voice_speaker_distance.c
    src/voice_mel_features.c
)

add_library(voice_classifier STATIC ${VOICE_CLASSIFIER_SRCS})
target_include_directories(voice_classifier PUBLIC include)
target_compile_options(voice_classifier PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# `voice_mel_features.c` and `voice_speaker_distance.c` use libm; on
# Linux that requires an explicit link.
target_link_libraries(voice_classifier PUBLIC m)

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
