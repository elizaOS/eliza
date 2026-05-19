cmake_minimum_required(VERSION 3.16)
project(doctr_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include)

# Stub-only build for now. The real implementation will add db_resnet50
# detection + crnn_vgg16_bn recognition translation units that link
# against the elizaOS/llama.cpp fork's ggml dispatcher; see AGENTS.md
# for the port plan.
#
# Architecture portability: every TU below is plain scalar C with no
# x86/ARM/RVV intrinsics, so the same source list builds on x86_64,
# aarch64, and riscv64 without any CMAKE_SYSTEM_PROCESSOR branching.
# When SIMD TUs are added (Phase 3 ggml dispatch), mirror the qjl-cpu
# pattern: separate per-arch TUs (avx2/neon/rvv), each compiled only
# for its own arch via a CMAKE_SYSTEM_PROCESSOR conditional, and
# runtime dispatch via cpuid/hwcap/riscv_hwprobe.
set(DOCTR_SRCS
    src/doctr_stub.c
)

add_library(doctr STATIC ${DOCTR_SRCS})
target_include_directories(doctr PUBLIC include)
target_compile_options(doctr PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)

enable_testing()

add_executable(doctr_stub_smoke test/doctr_stub_smoke.c)
target_link_libraries(doctr_stub_smoke PRIVATE doctr)
target_compile_options(doctr_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME doctr_stub_smoke COMMAND doctr_stub_smoke)
