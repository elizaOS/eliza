/*
 * ARMv8.4 dot-product (UDOT/SDOT) GQA attention-score kernel for the
 * experimental int8 query sketch.
 *
 * Same algebra as qjl_score_avxvnni.c:
 *   raw = 2 * sum_j bit_j * q_i8[j] - sum_j q_i8[j]
 * `sum_j bit_j * q_i8[j]` is an unsigned*signed dot — bits are {0,1}
 * u8, q values i8 — and `vdotq_lane_s32` / `vdotq_s32` (UDOT mixed not
 * available, so we cast bits to s8 since they are 0/1 and never negative
 * as s8 either) computes 4 products + accumulate per 32-bit lane.
 *
 * Built only on AArch64 (NEON baseline); the body is gated on
 * __ARM_FEATURE_DOTPROD so a binary built without +dotprod still links
 * but the dispatcher won't call this entry. Review-only build: no ARM
 * hardware available in this environment.
 */

#if defined(__aarch64__) && defined(__ARM_FEATURE_DOTPROD)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <arm_neon.h>
#include <stdint.h>

/* Expand 16 packed sign bits (2 source bytes) into 16 {0,1} s8 bytes. */
static inline int8x16_t expand_16_bits(const uint8_t *src2) {
    /* Broadcast byte 0 to lanes 0..7 and byte 1 to lanes 8..15. */
    uint8x16_t b0 = vdupq_n_u8(src2[0]);
    uint8x16_t b1 = vdupq_n_u8(src2[1]);
    static const uint8_t mask_arr[16] = {
        1,2,4,8,16,32,64,128, 0,0,0,0,0,0,0,0 };
    static const uint8_t mask_arr_hi[16] = {
        0,0,0,0,0,0,0,0, 1,2,4,8,16,32,64,128 };
    uint8x16_t sel_lo = vld1q_u8(mask_arr);
    uint8x16_t sel_hi = vld1q_u8(mask_arr_hi);
    uint8x16_t lo = vandq_u8(b0, sel_lo);
    uint8x16_t hi = vandq_u8(b1, sel_hi);
    uint8x16_t a  = vorrq_u8(lo, hi);
    uint8x16_t sel = vorrq_u8(sel_lo, sel_hi);
    uint8x16_t m  = vceqq_u8(a, sel);          /* 0xFF where set */
    return vreinterpretq_s8_u8(vandq_u8(m, vdupq_n_u8(1)));
}

void qjl_score_qk_i8_dotprod(const qjl_i8_sketch_256 *q_sketch_i8,
                             const qjl_block_qjl1_256 *packed_k,
                             int n_heads, int n_kv_heads, int n_tokens,
                             float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    for (int hq = 0; hq < n_heads; ++hq) {
        const int hk = hq / gqa;
        const qjl_i8_sketch_256 *qs = q_sketch_i8 + hq;

        /* sum_j q_i8[j] via SDOT against an all-ones s8 vector. */
        int32x4_t sumv = vdupq_n_s32(0);
        const int8x16_t ones_s8 = vdupq_n_s8(1);
        for (int j = 0; j < QJL_PROJECTION_DIM; j += 16) {
            int8x16_t qv = vld1q_s8(qs->values + j);
            sumv = vdotq_s32(sumv, ones_s8, qv);
        }
        const int32_t sum_q = vaddvq_s32(sumv);

        for (int t = 0; t < n_tokens; ++t) {
            const qjl_block_qjl1_256 *blk = packed_k + hk * n_tokens + t;
            int32x4_t acc = vdupq_n_s32(0);
            for (int r = 0; r < QJL_PACKED_BYTES / 2; ++r) {
                int8x16_t bits = expand_16_bits(blk->qs + r * 2);
                int8x16_t qv   = vld1q_s8(qs->values + r * 16);
                acc = vdotq_s32(acc, bits, qv);
            }
            const int32_t dot_pos = vaddvq_s32(acc);
            const int32_t raw = 2 * dot_pos - sum_q;
            const float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[hq * n_tokens + t] = scl_base * norm_k * qs->scale * (float)raw;
        }
    }
}

#endif /* __aarch64__ && __ARM_FEATURE_DOTPROD */
