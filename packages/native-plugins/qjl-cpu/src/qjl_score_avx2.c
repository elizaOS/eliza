/*
 * AVX2 GQA attention-score kernel.
 *
 * For each (h_q, t) pair:
 *   acc = sum_j sign_packed[t, j] * q_sketch[h_q, j]
 * where the sign bits live in 32 bytes of `packed_k[hk, t].qs`.
 *
 * Strategy: expand each 32-byte sign mask into 256 fp32 +/-1 lanes
 * (32 ymm registers' worth) by table-lookup, then dot against q_sketch
 * via 32 fmadds. We do the expansion in 8-bit groups via the pdep-style
 * trick: an 8-element u8->fp32 +/-1 LUT.
 */

#if defined(__AVX2__)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <immintrin.h>
#include <math.h>

/* Expand one byte of sign bits into 8 fp32 lanes of +/-1. */
static inline __m256 expand_signs_byte(uint8_t b) {
    /* Build 8 lanes where lane j = bit j of b. Use a broadcast + AND + cmp.
       This avoids a 256-entry LUT and is branchless. */
    __m256i v = _mm256_set1_epi32((int)b);
    /* per-lane bit selector: 1, 2, 4, 8, 16, 32, 64, 128 */
    const __m256i bits = _mm256_setr_epi32(1, 2, 4, 8, 16, 32, 64, 128);
    __m256i andv = _mm256_and_si256(v, bits);
    /* lane mask: all-ones if bit set, else zero */
    __m256i mask = _mm256_cmpeq_epi32(andv, bits);
    /* convert to fp32: -1.0 + 2.0 * (mask?1:0) → +1 if set, -1 if not */
    __m256 ones    = _mm256_set1_ps(1.0f);
    __m256 negones = _mm256_set1_ps(-1.0f);
    /* blendv selects b when mask high-bit set */
    return _mm256_blendv_ps(negones, ones, _mm256_castsi256_ps(mask));
}

void qjl_score_qk_avx2(const float *q_sketch,
                       const qjl_block_qjl1_256 *packed_k,
                       int n_heads, int n_kv_heads, int n_tokens,
                       float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    for (int hq = 0; hq < n_heads; hq++) {
        int hk = hq / gqa;
        const float *qs = q_sketch + hq * QJL_PROJECTION_DIM;

        for (int t = 0; t < n_tokens; t++) {
            const qjl_block_qjl1_256 *blk = packed_k + hk * n_tokens + t;
            __m256 acc = _mm256_setzero_ps();
            /* 32 bytes of signs → 32 ymm of +/-1 → 32 fma with q_sketch */
            for (int b = 0; b < QJL_PACKED_BYTES; b++) {
                __m256 sgn = expand_signs_byte(blk->qs[b]);
                __m256 q   = _mm256_loadu_ps(qs + b * 8);
                acc = _mm256_fmadd_ps(sgn, q, acc);
            }
            __m128 lo = _mm256_castps256_ps128(acc);
            __m128 hi = _mm256_extractf128_ps(acc, 1);
            __m128 v  = _mm_add_ps(lo, hi);
            v = _mm_hadd_ps(v, v);
            v = _mm_hadd_ps(v, v);
            float dot = _mm_cvtss_f32(v);
            float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[hq * n_tokens + t] = scl_base * norm_k * dot;
        }
    }
}

#endif /* __AVX2__ */
