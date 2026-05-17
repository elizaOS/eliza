cmake_minimum_required(VERSION 3.16)
project(yolo_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Phase 2 build: real classes table, real NMS, real decoupled-head
# decode, real GGUF reader, real letterbox preprocessing, scalar-C NN
# kernels, and the runtime entry points (yolo_open / yolo_detect /
# yolo_close / yolo_active_backend) backed by yolo_runtime.c.
#
# yolo_detect's full forward pass is staged — it returns -ENOSYS today;
# see yolo_runtime.c's TU header for the honest rationale and the
# Phase 3 plan (ggml dispatch or im2col + SIMD).
set(YOLO_SRCS
    src/yolo_classes.c
    src/yolo_nms.c
    src/yolo_postprocess.c
    src/yolo_gguf.c
    src/yolo_letterbox.c
    src/yolo_kernels.c
    src/yolo_runtime.c
)

# Static archive for tests + future static linking.
add_library(yolo STATIC ${YOLO_SRCS})
target_include_directories(yolo PUBLIC include)
target_compile_options(yolo PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# math is pulled in by every TU that uses sqrtf/expf.
target_link_libraries(yolo PUBLIC m)

# Shared library for bun:ffi dlopen from plugins/plugin-vision.
# Same source set, position-independent, exports the public C ABI from
# include/yolo/yolo.h. Phase 2 of the TS binding (yolo-detector-ggml.ts)
# loads this directly.
add_library(yolo_shared SHARED ${YOLO_SRCS})
target_include_directories(yolo_shared PUBLIC include)
target_compile_options(yolo_shared PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter -fPIC)
target_link_libraries(yolo_shared PUBLIC m)
set_target_properties(yolo_shared PROPERTIES OUTPUT_NAME "yolo")

enable_testing()

add_executable(yolo_stub_smoke test/yolo_stub_smoke.c)
target_link_libraries(yolo_stub_smoke PRIVATE yolo)
target_compile_options(yolo_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_stub_smoke COMMAND yolo_stub_smoke)

add_executable(yolo_nms_test test/yolo_nms_test.c)
target_link_libraries(yolo_nms_test PRIVATE yolo)
target_compile_options(yolo_nms_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_nms_test COMMAND yolo_nms_test)

add_executable(yolo_classes_test test/yolo_classes_test.c)
target_link_libraries(yolo_classes_test PRIVATE yolo)
target_compile_options(yolo_classes_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_classes_test COMMAND yolo_classes_test)

add_executable(yolo_letterbox_test test/yolo_letterbox_test.c)
target_link_libraries(yolo_letterbox_test PRIVATE yolo)
target_compile_options(yolo_letterbox_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_letterbox_test COMMAND yolo_letterbox_test)

# Runtime smoke test. Opens a real GGUF (path passed at run time via
# YOLO_TEST_GGUF env var) and verifies open/close + the metadata
# refusal path. When YOLO_TEST_GGUF is unset the test passes the
# refusal-path checks only; the open-the-real-file half is skipped
# with a clear log so CI without the converter run reports green.
add_executable(yolo_runtime_test test/yolo_runtime_test.c)
target_link_libraries(yolo_runtime_test PRIVATE yolo)
target_compile_options(yolo_runtime_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_runtime_test COMMAND yolo_runtime_test)
