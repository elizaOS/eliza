cmake_minimum_required(VERSION 3.16)
project(polarquant_cpu C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(
    -Wall
    -Wextra
    -Wpedantic
    -Wno-unused-parameter
    -O3
    -ffast-math
)

add_library(polarquant STATIC
    src/polar_hadamard.c
    src/polar_qjl.c
    src/polar_quantize_ref.c
    src/polar_dequantize_ref.c
    src/polar_dot_ref.c
)
target_include_directories(polarquant PUBLIC include)
target_link_libraries(polarquant PUBLIC m)

enable_testing()

add_executable(polar_roundtrip_test test/polar_roundtrip_test.c)
target_link_libraries(polar_roundtrip_test PRIVATE polarquant)
add_test(NAME polar_roundtrip COMMAND polar_roundtrip_test)

add_executable(polar_dot_test test/polar_dot_test.c)
target_link_libraries(polar_dot_test PRIVATE polarquant)
add_test(NAME polar_dot COMMAND polar_dot_test)
