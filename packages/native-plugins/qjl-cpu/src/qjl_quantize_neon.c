/*
 * ARM NEON quantize / dequantize for block_qjl1_256.
 *
 * NEON fp32 vectors are 4 lanes wide. proj_dim=256 → 64 fp32 vectors of
 * sketch lanes. We tile by 16 vectors per pass (64 lanes per pass) and
 * loop 4 passes to cover proj_dim. Inner: broadcast key[i] and FMA.
 *
 * Sign extraction: vcgtq_f32(acc, zero) → uint32x4_t mask per lane.
 * To pack 8 lanes into a byte LSB-first, we collapse two q-vectors into
 * a u8 byte via per-lane bit weights and a horizontal reduction.
 *
 * Reference for the sign-pack technique: the NEON port shape was sketched
 * in docs/porting/on-device-quantization-porting-plan.md ("vshrn_n_u16
 * + vorr_u8" idiom). The implementation here uses a per-lane weighted
 * sum because that maps 1:1 to the LSB-first encoding the Python
 * reference uses (`(bits * (1<<arange(8))).sum(-1)`).
 */

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <arm_neon.h>
#include <math.h>
#include <string.h>

/* Pack 8 fp32 lanes (two q-regs of 4 lanes) into one byte LSB-first.
 * lane j (0..7) → bit j of the output byte iff that lane is > 0. */
static inline uint8_t pack8_signs_neon(float32x4_t lo, float32x4_t hi) {
    /* Compare > 0; result is uint32x4_t with 0xFFFFFFFF or 0 per lane. */
    uint32x4_t mlo = vcgtq_f32(lo, vdupq_n_f32(0.0f));
    uint32x4_t mhi = vcgtq_f32(hi, vdupq_n_f32(0.0f));
    /* Per-lane bit weights: lane k of mlo → bit k; lane k of mhi → bit k+4. */
    static const uint32_t wlo_arr[4] = {1u, 2u, 4u, 8u};
    static const uint32_t whi_arr[4] = {16u, 32u, 64u, 128u};
    uint32x4_t wlo = vld1q_u32(wlo_arr);
    uint32x4_t whi = vld1q_u32(whi_arr);
    uint32x4_t blo = vandq_u32(mlo, wlo);
    uint32x4_t bhi = vandq_u32(mhi, whi);
    uint32x4_t sum = vaddq_u32(blo, bhi);
    /* Horizontal sum across the 4 lanes → 8-bit byte. */
    uint32x2_t s2 = vadd_u32(vget_low_u32(sum), vget_high_u32(sum));
    return (uint8_t)(vget_lane_u32(s2, 0) + vget_lane_u32(s2, 1));
}

void qjl_quantize_row_neon(const float *key, const float *prj,
                           qjl_block_qjl1_256 *out) {
    /* L2 norm. */
    float32x4_t nsum = vdupq_n_f32(0.0f);
    for (int i = 0; i < QJL_HEAD_DIM; i += 4) {
        float32x4_t k = vld1q_f32(key + i);
        nsum = vfmaq_f32(nsum, k, k);
    }
    float norm_sq = vaddvq_f32(nsum);
    out->norm_bf16 = qjl_fp32_to_bf16(sqrtf(norm_sq));

    /* Project. proj_dim=256 = 4 passes of 64 lanes (16 q-vectors per pass). */
    float32x4_t acc[16];
    for (int pass = 0; pass < 4; pass++) {
        for (int b = 0; b < 16; b++) acc[b] = vdupq_n_f32(0.0f);

        const float *prj_base = prj + pass * 64;
        for (int i = 0; i < QJL_HEAD_DIM; i++) {
            float32x4_t ki = vdupq_n_f32(key[i]);
            const float *row = prj_base + i * QJL_PROJECTION_DIM;
            for (int b = 0; b < 16; b++) {
                float32x4_t p = vld1q_f32(row + b * 4);
                acc[b] = vfmaq_f32(acc[b], ki, p);
            }
        }
        /* Pack pairs of q-vectors into bytes. 16 q-vectors → 8 bytes. */
        for (int b = 0; b < 8; b++) {
            out->qs[pass * 8 + b] = pack8_signs_neon(acc[b * 2], acc[b * 2 + 1]);
        }
    }
}

void qjl_quantize_rows_neon(const float *keys, const float *prj,
                            qjl_block_qjl1_256 *out, size_t n_rows) {
    for (size_t r = 0; r < n_rows; r++) {
        qjl_quantize_row_neon(keys + r * QJL_HEAD_DIM, prj, out + r);
    }
}

void qjl_dequantize_row_neon(const qjl_block_qjl1_256 *blk, const float *prj,
                             float *out) {
    const float scl = 1.2533141373155003f / (float)QJL_PROJECTION_DIM
                      * qjl_bf16_to_fp32(blk->norm_bf16);
    /* Pre-expand signs to fp32 +/-1. */
    float signs[QJL_PROJECTION_DIM];
    for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
        int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
        signs[j] = bit ? 1.0f : -1.0f;
    }
    for (int i = 0; i < QJL_HEAD_DIM; i++) {
        const float *row = prj + i * QJL_PROJECTION_DIM;
        float32x4_t acc = vdupq_n_f32(0.0f);
        for (int j = 0; j < QJL_PROJECTION_DIM; j += 4) {
            float32x4_t p = vld1q_f32(row + j);
            float32x4_t s = vld1q_f32(signs + j);
            acc = vfmaq_f32(acc, p, s);
        }
        out[i] = scl * vaddvq_f32(acc);
    }
}

#endif /* __ARM_NEON */
