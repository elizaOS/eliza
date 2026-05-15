cmake_minimum_required(VERSION 3.16)
project(face_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include)

# Stub-plus-helpers build. The model entries (face_detect_open / _embed_open /
# inference) are ENOSYS today; the model-independent helpers (anchor table +
# decode, 5-point alignment + bilinear sampler, cosine/L2 distance) are real
# and tested. The real ggml-backed model TUs replace face_stub.c without
# changing the ABI; see AGENTS.md for the port plan.
set(FACE_SRCS
    src/face_stub.c
    src/face_anchor_decode.c
    src/face_align.c
    src/face_distance.c
)

add_library(face STATIC ${FACE_SRCS})
target_include_directories(face PUBLIC include)
target_compile_options(face PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

# libm needed for sigmoidf/expf/sqrtf/floorf in the real helper TUs.
find_library(M_LIB m)
if(M_LIB)
    target_link_libraries(face PUBLIC ${M_LIB})
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
