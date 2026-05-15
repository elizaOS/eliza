cmake_minimum_required(VERSION 3.16)
project(wakeword_cpp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include_directories(include src)

# The public C ABI is currently a stub (every entry point returns
# `-ENOSYS`). The melspectrogram + sliding-window TUs are real and
# tested in isolation; they will be wired into a non-stub
# `wakeword_*` implementation as Phase 2 brings up the embedding +
# classifier ggml graphs (see AGENTS.md for the port plan).
set(WAKEWORD_SRCS
    src/wakeword_stub.c
    src/wakeword_melspec.c
    src/wakeword_window.c
)

add_library(wakeword STATIC ${WAKEWORD_SRCS})
target_include_directories(wakeword PUBLIC include)
target_compile_options(wakeword PRIVATE -O3 -Wall -Wextra -Wno-unused-parameter)
# Math library is needed for the melspectrogram (cosf/sinf/logf/powf).
target_link_libraries(wakeword PUBLIC m)

enable_testing()

add_executable(wakeword_stub_smoke test/wakeword_stub_smoke.c)
target_link_libraries(wakeword_stub_smoke PRIVATE wakeword)
target_compile_options(wakeword_stub_smoke PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_stub_smoke COMMAND wakeword_stub_smoke)

add_executable(wakeword_melspec_test test/wakeword_melspec_test.c)
target_link_libraries(wakeword_melspec_test PRIVATE wakeword)
target_compile_options(wakeword_melspec_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_melspec_test COMMAND wakeword_melspec_test)

add_executable(wakeword_window_test test/wakeword_window_test.c)
target_link_libraries(wakeword_window_test PRIVATE wakeword)
target_compile_options(wakeword_window_test PRIVATE -O2 -Wall -Wextra)
add_test(NAME wakeword_window_test COMMAND wakeword_window_test)
