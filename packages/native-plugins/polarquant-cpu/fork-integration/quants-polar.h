// quants-polar.h - PolarQuant Q4 quant block kernels for ggml-cpu.
//
// Drops next to ggml/src/ggml-cpu/quants.c; included by ggml-cpu.c so
// the type-traits table can bind the dispatcher entry points.
//
// The block layout (`block_q4_polar`) lives in ggml-common.h.  This
// header only declares the kernel entry points.  Reference / parity
// gates live in
//   packages/native-plugins/polarquant-cpu/test/polar_simd_parity_test.c
// in the milady repo (the standalone library is the source of truth).
#pragma once

#include "ggml-common.h"
#include "ggml-impl.h"
#include "ggml-cpu-impl.h"

#ifdef __cplusplus
extern "C" {
#endif

// Encoder: scalar.  Runs at convert time, not in the inference hot path.
void quantize_row_q4_polar    (const float * x, void * y, int64_t k);
void quantize_row_q4_polar_ref(const float * x, void * y, int64_t k);

// Decoder + dot: SIMD-dispatched at compile time (AVX2 / NEON / scalar).
void dequantize_row_q4_polar  (const block_q4_polar * x, float * y, int64_t k);

void ggml_vec_dot_q4_polar_q8_0(int n, float * s, size_t bs,
                                const void * vx, size_t bx,
                                const void * vy, size_t by, int nrc);

#ifdef __cplusplus
}
#endif
