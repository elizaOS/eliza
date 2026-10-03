/* polar_dot_avx2.c - AVX2 dot product between a Q4_POLAR row and a Q8_0 row.
 *
 * Layout: QK_POLAR (128) = 4 * QK8_0 (32).  Each Q4_POLAR block lines
 * up with 4 consecutive Q8_0 blocks.
 *
 * Strategy:
 *   - Per-block: call the AVX2 dequantizer to materialise 128 fp32 weights.
 *   - For each of the 4 matching Q8_0 sub-blocks, expand 32 int8 codes to
 *     fp32 in two ymm vectors and FMA against the dequantized weight tile.
 *   - Multiply the 32-element partial dot by the Q8_0's per-block fp16 scale,
 *     accumulate into a double-precision running sum.  Mirrors the pattern
 *     in upstream `ggml_vec_dot_q4_K_q8_K` (per-Q8_0-block scaling, not
 *     per-Q4_POLAR-block).
 *
 * The dequant tile itself is the dominant cost; the FMA accumulate is
 * the bandwidth-light follow-up.
 */

#if defined(__AVX2__)

#include <immintrin.h>
#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

/* Expand 32 int8 codes into 4 ymm fp32 vectors of 8 lanes each. */
static inline void load_q8_chunk(const int8_t * src,
                                 __m256 out[4]) {
    __m128i bytes_lo = _mm_loadu_si128((const __m128i *)src);        /* 16 bytes */
    __m128i bytes_hi = _mm_loadu_si128((const __m128i *)(src + 16)); /* 16 bytes */

    /* Sign-extend 8 -> 32 bits, four 8-lane ymm vectors. */
    __m256i i0 = _mm256_cvtepi8_epi32(bytes_lo);
    __m256i i1 = _mm256_cvtepi8_epi32(_mm_unpackhi_epi64(bytes_lo, bytes_lo));
    __m256i i2 = _mm256_cvtepi8_epi32(bytes_hi);
    __m256i i3 = _mm256_cvtepi8_epi32(_mm_unpackhi_epi64(bytes_hi, bytes_hi));

    out[0] = _mm256_cvtepi32_ps(i0);
    out[1] = _mm256_cvtepi32_ps(i1);
    out[2] = _mm256_cvtepi32_ps(i2);
    out[3] = _mm256_cvtepi32_ps(i3);
}

void ggml_vec_dot_q4_polar_q8_0_avx2(
    int n,
    float * s,
    const block_q4_polar * x,
    const struct block_q8_0 * y,
    int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) {
        return;
    }

    const int nb_polar       = n / QK_POLAR;
    const int n_q8_per_polar = QK_POLAR / QK8_0; /* = 4 */

    _Alignas(32) float buf[QK_POLAR];
    double acc = 0.0;

    for (int b = 0; b < nb_polar; b++) {
        dequantize_row_q4_polar_avx2(x + b, buf, QK_POLAR, use_qjl);

        for (int qb = 0; qb < n_q8_per_polar; qb++) {
            const struct block_q8_0 * yb = y + b * n_q8_per_polar + qb;
            const float scale = polar_fp16_to_fp32(yb->d);
            const float * xchunk = buf + qb * QK8_0;

            __m256 q[4];
            load_q8_chunk(yb->qs, q);

            __m256 w0 = _mm256_load_ps(xchunk +  0);
            __m256 w1 = _mm256_load_ps(xchunk +  8);
            __m256 w2 = _mm256_load_ps(xchunk + 16);
            __m256 w3 = _mm256_load_ps(xchunk + 24);

            __m256 a0 = _mm256_mul_ps(w0, q[0]);
            __m256 a1 = _mm256_fmadd_ps(w1, q[1], a0);
            __m256 a2 = _mm256_fmadd_ps(w2, q[2], a1);
            __m256 a3 = _mm256_fmadd_ps(w3, q[3], a2);

            /* Horizontal sum of 8 lanes. */
            __m128 lo = _mm256_castps256_ps128(a3);
            __m128 hi = _mm256_extractf128_ps(a3, 1);
            __m128 v  = _mm_add_ps(lo, hi);
            v = _mm_hadd_ps(v, v);
            v = _mm_hadd_ps(v, v);
            const float local = _mm_cvtss_f32(v);

            acc += (double)scale * (double)local;
        }
    }

    *s = (float)acc;
}

#endif /* __AVX2__ */
