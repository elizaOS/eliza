cmake_minimum_required(VERSION 3.16)
project(yolo_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# Phase 1 build: real classes table, real NMS, real decoupled-head
# decode, plus an ENOSYS stub for the ggml-graph-backed entry points
# (yolo_open / yolo_detect / yolo_close / yolo_active_backend). Phase 2
# replaces yolo_stub.c with a yolo_runtime.c that links the
# elizaOS/llama.cpp fork's ggml dispatcher; see AGENTS.md for the port
# plan. The other TUs port forward unchanged.
set(YOLO_SRCS
    src/yolo_classes.c
    src/yolo_nms.c
    src/yolo_postprocess.c
    src/yolo_stub.c
)

add_library(yolo STATIC ${YOLO_SRCS})
target_include_directories(yolo PUBLIC include)
target_compile_options(yolo PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

enable_testing()

add_executable(yolo_stub_smoke test/yolo_stub_smoke.c)
target_link_libraries(yolo_stub_smoke PRIVATE yolo)
target_compile_options(yolo_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_stub_smoke COMMAND yolo_stub_smoke)

add_executable(yolo_nms_test test/yolo_nms_test.c)
target_link_libraries(yolo_nms_test PRIVATE yolo m)
target_compile_options(yolo_nms_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_nms_test COMMAND yolo_nms_test)

add_executable(yolo_classes_test test/yolo_classes_test.c)
target_link_libraries(yolo_classes_test PRIVATE yolo)
target_compile_options(yolo_classes_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME yolo_classes_test COMMAND yolo_classes_test)
