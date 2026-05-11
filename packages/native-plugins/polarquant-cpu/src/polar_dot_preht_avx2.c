/* polar_dot_preht_avx2.c - AVX2 pre-Hadamard-query Polar dot.
 *
 * Computes  s = sum_b dequant_q4_polar(block_b) . q[b*128 .. b*128+127]
 * using the algebra  dot(H*x, q) == dot(x, H*q):  the caller supplies
 * q_preht = H*q (one Hadamard per query head/chunk, reused across many K
 * rows), so each block reduces to:
 *
 *   1. unpack 64 nibble bytes -> 128 centroid floats (16-entry LUT)
 *   2. (optional) add the per-block 1-bit QJL residual along the seeded
 *      +/-1 sign vector
 *   3. dot directly against q_preht
 *   4. accumulate  (norm/128) * dot
 *
 * No per-block inverse Hadamard, no 128-float decode-to-scratch followed
 * by a separate FMA pass. Exact relative to ggml_vec_dot_q4_polar_preht_f32_ref.
 */

#if defined(__AVX2__)

#include <immintrin.h>
#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

/* Gather 8 centroid floats given 8 four-bit indices (0..15). `clo`/`chi`
 * are the low/high halves of POLAR_Q4_CENTROIDS, hoisted by the caller
 * so they stay in registers across the block loop. vpermps already uses
 * only the low 3 bits of each index, so no `& 7`; bit-3 is shifted to
 * the sign bit so vblendvps picks the high half. */
static inline __m256 centroid_gather8(__m256i idx, __m256 clo, __m256 chi) {
    __m256 vlo = _mm256_permutevar8x32_ps(clo, idx);
    __m256 vhi = _mm256_permutevar8x32_ps(chi, idx);
    __m256 sel = _mm256_castsi256_ps(_mm256_slli_epi32(idx, 28));
    return _mm256_blendv_ps(vlo, vhi, sel);
}

/* Unpack 4 packed bytes (qs+o) -> 8 centroid floats, in the
 * [lo0,hi0,lo1,hi1,...] (= natural element) order. */
static inline __m256 unpack8_centroids(const uint8_t *qs4, __m256 clo, __m256 chi) {
    uint32_t w;
    __builtin_memcpy(&w, qs4, 4);
    __m128i b = _mm_cvtsi32_si128((int)w);                 /* 4 bytes */
    /* duplicate each byte into two adjacent lanes */
    __m128i dup = _mm_shuffle_epi8(b, _mm_setr_epi8(0,0,1,1,2,2,3,3,
                                                    -1,-1,-1,-1,-1,-1,-1,-1));
    __m256i wide = _mm256_cvtepu8_epi32(dup);              /* 8 x u32 */
    /* even lanes keep low nibble, odd lanes shift down by 4 */
    __m256i shifts = _mm256_setr_epi32(0,4,0,4,0,4,0,4);
    __m256i nib = _mm256_and_si256(_mm256_srlv_epi32(wide, shifts),
                                   _mm256_set1_epi32(0x0F));
    return centroid_gather8(nib, clo, chi);
}

void ggml_vec_dot_q4_polar_preht_f32_avx2(
    int n, float * s, const block_q4_polar * x, const float * q_preht, int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) return;

    const float * const signs = use_qjl ? polar_qjl_signs_cached() : NULL;
    const float residual_mag = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);
    /* 16-entry centroid LUT split into two ymm halves — loop-invariant. */
    const __m256 clo = _mm256_loadu_ps(POLAR_Q4_CENTROIDS);
    const __m256 chi = _mm256_loadu_ps(POLAR_Q4_CENTROIDS + 8);

    const int nb = n / QK_POLAR;
    double acc_total = 0.0;

    for (int b = 0; b < nb; ++b) {
        const block_q4_polar *blk = x + b;
        const float *q = q_preht + b * QK_POLAR;
        const float norm_scale = polar_fp16_to_fp32(blk->d) * (1.0f / (float)QK_POLAR);
        const int  residual_bit = blk->qjl[0] & 1;
        const float residual = (residual_bit ? 1.0f : -1.0f) * residual_mag;
        const __m256 vres = _mm256_set1_ps(residual);

        /* QK_POLAR = 128 -> 8 chunks of 16 elements; unroll by 2 over
         * four fp32 accumulators so each chain is 4 FMAs deep, not 8 —
         * hides the ~4c FMA latency at 2 FMA/c throughput. */
        __m256 acc0 = _mm256_setzero_ps();
        __m256 acc1 = _mm256_setzero_ps();
        __m256 acc2 = _mm256_setzero_ps();
        __m256 acc3 = _mm256_setzero_ps();
        for (int i = 0; i < QK_POLAR; i += 32) {
            __m256 c0 = unpack8_centroids(blk->qs + i / 2);
            __m256 c1 = unpack8_centroids(blk->qs + i / 2 + 4);
            __m256 c2 = unpack8_centroids(blk->qs + i / 2 + 8);
            __m256 c3 = unpack8_centroids(blk->qs + i / 2 + 12);
            if (use_qjl) {
                c0 = _mm256_fmadd_ps(vres, _mm256_loadu_ps(signs + i),      c0);
                c1 = _mm256_fmadd_ps(vres, _mm256_loadu_ps(signs + i + 8),  c1);
                c2 = _mm256_fmadd_ps(vres, _mm256_loadu_ps(signs + i + 16), c2);
                c3 = _mm256_fmadd_ps(vres, _mm256_loadu_ps(signs + i + 24), c3);
            }
            acc0 = _mm256_fmadd_ps(c0, _mm256_loadu_ps(q + i),      acc0);
            acc1 = _mm256_fmadd_ps(c1, _mm256_loadu_ps(q + i + 8),  acc1);
            acc2 = _mm256_fmadd_ps(c2, _mm256_loadu_ps(q + i + 16), acc2);
            acc3 = _mm256_fmadd_ps(c3, _mm256_loadu_ps(q + i + 24), acc3);
        }
        __m256 acc = _mm256_add_ps(_mm256_add_ps(acc0, acc1), _mm256_add_ps(acc2, acc3));
        __m128 v = _mm_add_ps(_mm256_castps256_ps128(acc), _mm256_extractf128_ps(acc, 1));
        v = _mm_hadd_ps(v, v);
        v = _mm_hadd_ps(v, v);
        acc_total += (double)norm_scale * (double)_mm_cvtss_f32(v);
    }
    *s = (float)acc_total;
}

#endif /* __AVX2__ */
