/*
 * AVX2 quantize / dequantize for block_qjl1_256 (head_dim=128, proj_dim=256).
 *
 * Algorithm shape mirrors the scalar reference. The projection matrix is
 * row-major (head_dim, proj_dim) so contiguous loads along the proj_dim
 * axis vectorize cleanly: for each outer key index i, broadcast key[i]
 * and FMA into N ymm accumulators that span the full proj_dim.
 *
 * Layout:
 *   - Outer loop: i in [0, head_dim) (128 iterations)
 *   - Inner: 32 ymm accumulators each holding 8 lanes of sketch[j..j+7].
 *
 * 32 ymm regs > 16 hardware ymms — we tile by 16 ymm at a time,
 * one half of proj_dim per pass (128 lanes per pass).
 */

#if defined(__AVX2__)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <immintrin.h>
#include <math.h>
#include <string.h>

/* Pack 8 sketch lanes (one ymm of fp32) into one byte: bit j set iff lane j > 0. */
static inline uint8_t pack8_signs(__m256 v) {
    /* movemask of compare: bit j = (lane j is < 0) according to _CMP_LT.
       We want bit j = (lane j > 0). Compare > 0 with a zero vector. */
    __m256 zero = _mm256_setzero_ps();
    __m256 cmp  = _mm256_cmp_ps(v, zero, _CMP_GT_OQ);
    /* movemask_ps gives an 8-bit mask, lane 0 -> bit 0, exactly what we want. */
    return (uint8_t)_mm256_movemask_ps(cmp);
}

void qjl_quantize_row_avx2(const float *key, const float *prj,
                           qjl_block_qjl1_256 *out) {
    /* L2 norm via 16 ymm fmas. */
    __m256 nsum = _mm256_setzero_ps();
    for (int i = 0; i < QJL_HEAD_DIM; i += 8) {
        __m256 k = _mm256_loadu_ps(key + i);
        nsum = _mm256_fmadd_ps(k, k, nsum);
    }
    /* horizontal sum */
    __m128 lo = _mm256_castps256_ps128(nsum);
    __m128 hi = _mm256_extractf128_ps(nsum, 1);
    __m128 s  = _mm_add_ps(lo, hi);
    s = _mm_hadd_ps(s, s);
    s = _mm_hadd_ps(s, s);
    float norm_sq = _mm_cvtss_f32(s);
    out->norm_bf16 = qjl_fp32_to_bf16(sqrtf(norm_sq));

    /*
     * Project. Two passes over 128 lanes each (proj_dim=256 = 2 * 128).
     * Per pass: 16 ymm accumulators (acc[0..15]), each holds lanes
     * [j..j+7] for j = pass*128 + b*8.
     */
    __m256 acc[16];
    for (int pass = 0; pass < 2; pass++) {
        for (int b = 0; b < 16; b++) acc[b] = _mm256_setzero_ps();

        const float *prj_base = prj + pass * 128;
        for (int i = 0; i < QJL_HEAD_DIM; i++) {
            __m256 ki = _mm256_set1_ps(key[i]);
            const float *row = prj_base + i * QJL_PROJECTION_DIM;
            for (int b = 0; b < 16; b++) {
                __m256 p = _mm256_loadu_ps(row + b * 8);
                acc[b] = _mm256_fmadd_ps(ki, p, acc[b]);
            }
        }
        for (int b = 0; b < 16; b++) {
            out->qs[pass * 16 + b] = pack8_signs(acc[b]);
        }
    }
}

void qjl_quantize_rows_avx2(const float *keys, const float *prj,
                            qjl_block_qjl1_256 *out, size_t n_rows) {
    for (size_t r = 0; r < n_rows; r++) {
        qjl_quantize_row_avx2(keys + r * QJL_HEAD_DIM, prj, out + r);
    }
}

void qjl_dequantize_row_avx2(const qjl_block_qjl1_256 *blk, const float *prj,
                             float *out) {
    const float scl = 1.2533141373155003f / (float)QJL_PROJECTION_DIM
                      * qjl_bf16_to_fp32(blk->norm_bf16);
    /* Pre-expand the 256 sign bits into 256 fp32 lanes of +/-1. */
    float signs[QJL_PROJECTION_DIM];
    for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
        int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
        signs[j] = bit ? 1.0f : -1.0f;
    }
    for (int i = 0; i < QJL_HEAD_DIM; i++) {
        const float *row = prj + i * QJL_PROJECTION_DIM;
        __m256 acc = _mm256_setzero_ps();
        for (int j = 0; j < QJL_PROJECTION_DIM; j += 8) {
            __m256 p = _mm256_loadu_ps(row + j);
            __m256 s = _mm256_loadu_ps(signs + j);
            acc = _mm256_fmadd_ps(p, s, acc);
        }
        __m128 lo = _mm256_castps256_ps128(acc);
        __m128 hi = _mm256_extractf128_ps(acc, 1);
        __m128 v  = _mm_add_ps(lo, hi);
        v = _mm_hadd_ps(v, v);
        v = _mm_hadd_ps(v, v);
        out[i] = scl * _mm_cvtss_f32(v);
    }
}

#endif /* __AVX2__ */
