cmake_minimum_required(VERSION 3.16)
project(face_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Phase 2: real BlazeFace + face-embed forward graphs (pure-C scalar
# reference today; the elizaOS/llama.cpp ggml dispatch is a Phase 3
# swap behind the same C ABI). The model entries (face_detect_open /
# face_embed_open / forward + post-process) live in face_model.c. The
# model-independent helpers (anchors, alignment, distance) keep their
# Phase 1 implementations.
set(FACE_SRCS
    src/face_model.c
    src/face_blazeface.c
    src/face_embed.c
    src/face_kernels.c
    src/face_image.c
    src/face_gguf.c
    src/face_nms.c
    src/face_anchor_decode.c
    src/face_align.c
    src/face_distance.c
)

# Build a static library AND a shared library so the TS bindings in
# plugins/plugin-vision can `dlopen` the .so / .dylib at runtime.
add_library(face STATIC ${FACE_SRCS})
target_include_directories(face PUBLIC include)
target_compile_options(face PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

add_library(face_shared SHARED ${FACE_SRCS})
target_include_directories(face_shared PUBLIC include)
set_target_properties(face_shared PROPERTIES
    OUTPUT_NAME face
    POSITION_INDEPENDENT_CODE ON)
target_compile_options(face_shared PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

# libm needed for sigmoidf/expf/sqrtf/floorf in the helpers.
find_library(M_LIB m)
if(M_LIB)
    target_link_libraries(face PUBLIC ${M_LIB})
    target_link_libraries(face_shared PUBLIC ${M_LIB})
endif()

enable_testing()

add_executable(face_stub_smoke test/face_stub_smoke.c)
target_link_libraries(face_stub_smoke PRIVATE face)
target_compile_options(face_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME face_stub_smoke COMMAND face_stub_smoke)

add_executable(face_anchor_test test/face_anchor_test.c)
target_link_libraries(face_anchor_test PRIVATE face)
target_compile_options(face_anchor_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME face_anchor_test COMMAND face_anchor_test)

add_executable(face_align_test test/face_align_test.c)
target_link_libraries(face_align_test PRIVATE face)
target_compile_options(face_align_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME face_align_test COMMAND face_align_test)

add_executable(face_distance_test test/face_distance_test.c)
target_link_libraries(face_distance_test PRIVATE face)
target_compile_options(face_distance_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME face_distance_test COMMAND face_distance_test)

add_executable(face_runtime_test test/face_runtime_test.c)
target_link_libraries(face_runtime_test PRIVATE face)
target_include_directories(face_runtime_test PRIVATE test src)
target_compile_options(face_runtime_test PRIVATE -O2 -Wall -Wextra -Wno-unused-parameter)
add_test(NAME face_runtime_test COMMAND face_runtime_test)

add_executable(face_embed_runtime_test test/face_embed_runtime_test.c)
target_link_libraries(face_embed_runtime_test PRIVATE face)
target_include_directories(face_embed_runtime_test PRIVATE test src)
target_compile_options(face_embed_runtime_test PRIVATE -O2 -Wall -Wextra -Wno-unused-parameter)
add_test(NAME face_embed_runtime_test COMMAND face_embed_runtime_test)
