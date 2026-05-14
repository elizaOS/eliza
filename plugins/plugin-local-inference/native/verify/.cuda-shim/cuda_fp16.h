#pragma once
#include <cstdint>
typedef unsigned short __half;
typedef unsigned short __half_raw;
typedef struct { unsigned short x, y; } __half2;
static inline float __half2float(__half h) { return (float)h; }
static inline __half __float2half(float f) { return (__half)f; }
