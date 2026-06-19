/* polar_dequantize_avx2.c - AVX2 decoder for block_q4_polar.
 *
 * Algorithm shape mirrors polar_dequantize_ref.c.  What we vectorize:
 *
 *   1. Nibble unpack + centroid LUT lookup.  16 centroids fit in 4 ymm
 *      vectors; we use two _mm256_permutevar8x32_ps gathers per byte
 *      (low nibble + high nibble) to materialise 8 fp32 centroid
 *      values per 4 bytes of input.  Faster than scalar mostly because
 *      it overlaps with the next stage.
 *   2. Walsh-Hadamard butterfly.  The first 5 butterfly stages
 *      (h = 1, 2, 4, 8, 16) operate on element distances <= 16, so
 *      they fit inside a single 8-lane vector pair using vector
 *      shuffle/blend.  The last 2 stages (h = 32, 64) operate across
 *      adjacent ymm pairs and use straight vector add/sub.
 *   3. Final scale `inv_d * l2`: a fused FMA loop.
 *
 * Throughput: 16 fp32 lanes (2 ymm) per stage × 7 stages = ~14 vector
 * ops per block for the butterfly, vs 384 scalar adds in the ref path.
 *
 * The QJL residual correction stays scalar — it's a 128-iter loop
 * touching the same buffer once and is bandwidth-bound either way; no
 * meaningful win from vectorising it inside this kernel.
 */

#if defined(__AVX2__)

#include <math.h>
#include <stdint.h>
#include <string.h>

#include <immintrin.h>

#include "polarquant/polarquant.h"

/* Materialise 128 centroid floats from 64 packed nibble bytes.
 *
 * The unpack stage is small (128 lookups, < 1 KB scratch) and the LUT
 * is just 16 floats.  Vectorising the lookup itself is more code than
 * it is worth here — the hot path is the Hadamard butterfly that
 * follows.  We do the 64-byte unpack in tight scalar code so the
 * compiler can keep the centroid LUT in a couple of ymm registers
 * across iterations.
 *
 * Lane order matches the scalar path: code at index 2*i comes from
 * the low nibble of qs[i], 2*i+1 from the high nibble.
 */
static inline void unpack_codes_to_floats(
    const uint8_t * qs,
    float * dst)
{
    for (int i = 0; i < QK_POLAR / 2; i++) {
        const uint8_t byte = qs[i];
        dst[2 * i]     = POLAR_Q4_CENTROIDS[byte & 0x0F];
        dst[2 * i + 1] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0F];
    }
}

/* Vectorised in-place Walsh-Hadamard butterfly of size 128.
 *
 * Stages h = 1, 2, 4, 8, 16: handled with vector shuffles inside
 * 8-lane ymm vectors so each stage reduces to 16 ymm reads + 16 ymm
 * writes.  Stage h = 32: cross-vector add/sub between the two halves
 * of each 64-element half.  Stage h = 64: cross-vector add/sub between
 * the two 64-element halves.
 *
 * Layout: 16 ymm vectors of 8 floats each = 128 floats.
 */
static inline void hadamard_inplace_avx2(float * x) {
    /* Stages h=1, h=2, h=4: pure intra-ymm butterflies via shuffles. */
    for (int v = 0; v < QK_POLAR; v += 8) {
        __m256 a = _mm256_loadu_ps(x + v);

        /* h=1: pairs (0,1) (2,3) (4,5) (6,7). */
        {
            __m256 b = _mm256_shuffle_ps(a, a, _MM_SHUFFLE(2, 3, 0, 1));
            __m256 sgn = _mm256_castsi256_ps(
                _mm256_setr_epi32(0, 0x80000000, 0, 0x80000000,
                                  0, 0x80000000, 0, 0x80000000));
            __m256 a_signed = _mm256_xor_ps(a, sgn);
            a = _mm256_add_ps(a_signed, b);
        }
        /* h=2: pairs (0,2) (1,3) (4,6) (5,7). */
        {
            __m256 b = _mm256_shuffle_ps(a, a, _MM_SHUFFLE(1, 0, 3, 2));
            __m256 sgn = _mm256_castsi256_ps(
                _mm256_setr_epi32(0, 0, 0x80000000, 0x80000000,
                                  0, 0, 0x80000000, 0x80000000));
            __m256 a_signed = _mm256_xor_ps(a, sgn);
            a = _mm256_add_ps(a_signed, b);
        }
        /* h=4: pairs (0,4) (1,5) (2,6) (3,7) — across the 128-bit halves. */
        {
            __m256 b = _mm256_permute2f128_ps(a, a, 0x01);
            __m256 sgn = _mm256_castsi256_ps(
                _mm256_setr_epi32(0, 0, 0, 0,
                                  0x80000000, 0x80000000, 0x80000000, 0x80000000));
            __m256 a_signed = _mm256_xor_ps(a, sgn);
            a = _mm256_add_ps(a_signed, b);
        }
        _mm256_storeu_ps(x + v, a);
    }

    /* Stage h=8: cross-vector between adjacent 8-lane vectors. */
    for (int g = 0; g < QK_POLAR; g += 16) {
        __m256 a = _mm256_loadu_ps(x + g);
        __m256 b = _mm256_loadu_ps(x + g + 8);
        _mm256_storeu_ps(x + g,     _mm256_add_ps(a, b));
        _mm256_storeu_ps(x + g + 8, _mm256_sub_ps(a, b));
    }
    /* Stage h=16: cross-vector between groups of 16. */
    for (int g = 0; g < QK_POLAR; g += 32) {
        for (int j = 0; j < 16; j += 8) {
            __m256 a = _mm256_loadu_ps(x + g + j);
            __m256 b = _mm256_loadu_ps(x + g + j + 16);
            _mm256_storeu_ps(x + g + j,      _mm256_add_ps(a, b));
            _mm256_storeu_ps(x + g + j + 16, _mm256_sub_ps(a, b));
        }
    }
    /* Stage h=32. */
    for (int g = 0; g < QK_POLAR; g += 64) {
        for (int j = 0; j < 32; j += 8) {
            __m256 a = _mm256_loadu_ps(x + g + j);
            __m256 b = _mm256_loadu_ps(x + g + j + 32);
            _mm256_storeu_ps(x + g + j,      _mm256_add_ps(a, b));
            _mm256_storeu_ps(x + g + j + 32, _mm256_sub_ps(a, b));
        }
    }
    /* Stage h=64. */
    for (int j = 0; j < 64; j += 8) {
        __m256 a = _mm256_loadu_ps(x + j);
        __m256 b = _mm256_loadu_ps(x + j + 64);
        _mm256_storeu_ps(x + j,      _mm256_add_ps(a, b));
        _mm256_storeu_ps(x + j + 64, _mm256_sub_ps(a, b));
    }
}

void dequantize_row_q4_polar_avx2(
    const block_q4_polar * x,
    float * y,
    int64_t k,
    int use_qjl)
{
    if (k <= 0 || (k % QK_POLAR) != 0) {
        return;
    }
    const int64_t nb = k / QK_POLAR;

    /* Memoized — dequantize is called per K-row from the q8_0 dot path;
     * don't regenerate the 128-element xorshift stream each time. */
    const float * const qjl_signs = use_qjl ? polar_qjl_signs_cached() : NULL;

    const float inv_d = 1.0f / (float)QK_POLAR;

    for (int64_t b = 0; b < nb; b++) {
        const block_q4_polar * src = x + b;
        float * dst = y + b * QK_POLAR;

        const float l2 = polar_fp16_to_fp32(src->d);
        const float scale = inv_d * l2;

        _Alignas(32) float buf[QK_POLAR];
        unpack_codes_to_floats(src->qs, buf);

        if (use_qjl) {
            const uint8_t bit = (uint8_t)(src->qjl[0] & 1u);
            const float sign  = bit ? 1.0f : -1.0f;
            const float mag   = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);
            const __m256 vsm  = _mm256_set1_ps(sign * mag);
            for (int i = 0; i < QK_POLAR; i += 8) {
                __m256 v = _mm256_load_ps(buf + i);
                __m256 s = _mm256_loadu_ps(qjl_signs + i);
                v = _mm256_fmadd_ps(vsm, s, v);
                _mm256_store_ps(buf + i, v);
            }
        }

        hadamard_inplace_avx2(buf);

        const __m256 vscale = _mm256_set1_ps(scale);
        for (int i = 0; i < QK_POLAR; i += 8) {
            __m256 v = _mm256_load_ps(buf + i);
            v = _mm256_mul_ps(v, vscale);
            _mm256_storeu_ps(dst + i, v);
        }
    }
}

#endif /* __AVX2__ */
