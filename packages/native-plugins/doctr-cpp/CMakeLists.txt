cmake_minimum_required(VERSION 3.16)
project(doctr_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include)

# ── Phase 1: ENOSYS stub library ────────────────────────────────────────────
# Preserves the original ABI-only linkage path. The stub library returns
# -ENOSYS for every entry point and is what plugin-vision links against
# until the runtime is wired through to the real reference impl.
set(DOCTR_STUB_SRCS
    src/doctr_stub.c
)

add_library(doctr STATIC ${DOCTR_STUB_SRCS})
target_include_directories(doctr PUBLIC include)
target_compile_options(doctr PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

# ── Phase 2: pure-C reference library ───────────────────────────────────────
# libdoctr_ref.a satisfies the same C ABI as libdoctr.a but actually
# performs db_resnet50 detection + crnn_vgg16_bn recognition against a
# GGUF emitted by scripts/doctr_to_gguf.py. Scalar C only — no SIMD,
# no OpenMP. Phase 3 will swap the conv/gemm kernels for AVX2/NEON
# dispatchers behind the same internal API in src/doctr_internal.h.
set(DOCTR_REF_SRCS
    src/doctr_ref_api.c
    src/doctr_image.c
    src/doctr_kernels.c
    src/doctr_detector_ref.c
    src/doctr_recognizer_ref.c
    src/doctr_polygon.c
    src/doctr_ctc.c
    src/doctr_gguf.c
)

add_library(doctr_ref STATIC ${DOCTR_REF_SRCS})
target_include_directories(doctr_ref PUBLIC include)
target_include_directories(doctr_ref PRIVATE src)
target_compile_options(doctr_ref PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# libm for sqrtf/expf/tanhf/floorf in the kernels.
target_link_libraries(doctr_ref PUBLIC m)

enable_testing()

# Phase 1 stub link smoke test.
add_executable(doctr_stub_smoke test/doctr_stub_smoke.c)
target_link_libraries(doctr_stub_smoke PRIVATE doctr)
target_compile_options(doctr_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME doctr_stub_smoke COMMAND doctr_stub_smoke)

# Phase 2 ref-impl smoke tests. These exercise the postprocess +
# preprocess paths against a synthetic image. Without a real GGUF on
# disk the test asserts the library returns the documented missing-file
# error code rather than fabricating output.
add_executable(doctr_detector_ref_test test/doctr_detector_ref_test.c)
target_link_libraries(doctr_detector_ref_test PRIVATE doctr_ref)
target_include_directories(doctr_detector_ref_test PRIVATE src)
target_compile_options(doctr_detector_ref_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME doctr_detector_ref_test COMMAND doctr_detector_ref_test)

add_executable(doctr_recognizer_ref_test test/doctr_recognizer_ref_test.c)
target_link_libraries(doctr_recognizer_ref_test PRIVATE doctr_ref)
target_include_directories(doctr_recognizer_ref_test PRIVATE src)
target_compile_options(doctr_recognizer_ref_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME doctr_recognizer_ref_test COMMAND doctr_recognizer_ref_test)
