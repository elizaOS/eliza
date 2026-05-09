/*
 * NEON GQA attention-score kernel.
 *
 * Same algorithm shape as the AVX2 path: expand each byte of packed
 * signs into 8 fp32 +/-1 lanes (= 2 NEON q-vectors), FMA against the
 * matching block of q_sketch, accumulate, scale by ||k|| * sqrt(pi/2)/proj.
 */

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <arm_neon.h>
#include <math.h>

/* Expand 4 of the 8 bits of a byte into 4 fp32 lanes of +/-1.
 * `bit_offset` is 0 (low nibble: bits 0..3) or 4 (high nibble: bits 4..7). */
static inline float32x4_t expand_signs_nibble(uint8_t b, int bit_offset) {
    /* Per-lane bit weights for the requested nibble. */
    uint32_t w0 = 1u << (bit_offset + 0);
    uint32_t w1 = 1u << (bit_offset + 1);
    uint32_t w2 = 1u << (bit_offset + 2);
    uint32_t w3 = 1u << (bit_offset + 3);
    uint32_t warr[4] = {w0, w1, w2, w3};
    uint32x4_t weights = vld1q_u32(warr);
    uint32x4_t bv      = vdupq_n_u32(b);
    uint32x4_t andv    = vandq_u32(bv, weights);
    uint32x4_t mask    = vceqq_u32(andv, weights);
    /* mask is 0xFFFFFFFF (set) or 0 (clear) per lane. Map to +1/-1. */
    float32x4_t one  = vdupq_n_f32(1.0f);
    float32x4_t none = vdupq_n_f32(-1.0f);
    return vbslq_f32(mask, one, none);
}

void qjl_score_qk_neon(const float *q_sketch,
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
            float32x4_t acc = vdupq_n_f32(0.0f);
            /* 32 bytes → 64 q-vectors of +/-1 → 64 fma's. */
            for (int b = 0; b < QJL_PACKED_BYTES; b++) {
                uint8_t byte = blk->qs[b];
                float32x4_t s_lo = expand_signs_nibble(byte, 0);
                float32x4_t s_hi = expand_signs_nibble(byte, 4);
                float32x4_t q_lo = vld1q_f32(qs + b * 8);
                float32x4_t q_hi = vld1q_f32(qs + b * 8 + 4);
                acc = vfmaq_f32(acc, s_lo, q_lo);
                acc = vfmaq_f32(acc, s_hi, q_hi);
            }
            float dot    = vaddvq_f32(acc);
            float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[hq * n_tokens + t] = scl_base * norm_k * dot;
        }
    }
}

#endif /* __ARM_NEON */
