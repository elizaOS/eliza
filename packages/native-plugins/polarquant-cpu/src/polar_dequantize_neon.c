/* polar_dequantize_neon.c - ARM NEON decoder for block_q4_polar.
 *
 * Mirrors polar_dequantize_avx2.c.  NEON fp32 vectors are 4 lanes
 * wide, so 128 floats live in 32 q-vectors.  The Hadamard butterfly
 * has 7 stages; stages h=1, h=2 fit inside one q-vector, and the
 * remaining stages are cross-vector add/sub between pairs of q-regs.
 */

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include <arm_neon.h>
#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

/* Scalar nibble unpack — small, bandwidth-bound, not worth vectorising
 * relative to the butterfly that consumes its output.  The compiler
 * will keep the LUT in registers across the loop.
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

/* In-place WHT for a single 4-lane q-vector handling stages h=1, h=2.
 *
 * h=1 inside (a0, a1, a2, a3): want (a0+a1, a0-a1, a2+a3, a2-a3).
 *   partner = (a1, a0, a3, a2)  -> vrev64q_f32 swaps adjacent lanes
 *   xor signs (+, -, +, -) into a, then add partner.
 * h=2 inside the result (b0, b1, b2, b3): want (b0+b2, b1+b3, b0-b2, b1-b3).
 *   partner = (b2, b3, b0, b1)  -> vextq_f32(v, v, 2)
 *   xor signs (+, +, -, -) into b, then add partner.
 */
static inline float32x4_t hadamard_q_h1_h2(float32x4_t a) {
    /* h=1 */
    float32x4_t partner = vrev64q_f32(a);
    /* sign vector (1, -1, 1, -1) via reinterpret + xor with sign-bit mask. */
    static const uint32_t sgn_h1_arr[4] = {0u, 0x80000000u, 0u, 0x80000000u};
    uint32x4_t sgn_h1 = vld1q_u32(sgn_h1_arr);
    float32x4_t a_signed = vreinterpretq_f32_u32(
        veorq_u32(vreinterpretq_u32_f32(a), sgn_h1));
    float32x4_t b = vaddq_f32(a_signed, partner);

    /* h=2 */
    float32x4_t partner2 = vextq_f32(b, b, 2);
    static const uint32_t sgn_h2_arr[4] = {0u, 0u, 0x80000000u, 0x80000000u};
    uint32x4_t sgn_h2 = vld1q_u32(sgn_h2_arr);
    float32x4_t b_signed = vreinterpretq_f32_u32(
        veorq_u32(vreinterpretq_u32_f32(b), sgn_h2));
    return vaddq_f32(b_signed, partner2);
}

/* Vectorised in-place Walsh-Hadamard butterfly of size 128. */
static inline void hadamard_inplace_neon(float * x) {
    /* Stages h=1, h=2: intra-vector. */
    for (int v = 0; v < QK_POLAR; v += 4) {
        float32x4_t a = vld1q_f32(x + v);
        a = hadamard_q_h1_h2(a);
        vst1q_f32(x + v, a);
    }
    /* Stage h=4: cross-vector between adjacent 4-lane vectors. */
    for (int g = 0; g < QK_POLAR; g += 8) {
        float32x4_t a = vld1q_f32(x + g);
        float32x4_t b = vld1q_f32(x + g + 4);
        vst1q_f32(x + g,     vaddq_f32(a, b));
        vst1q_f32(x + g + 4, vsubq_f32(a, b));
    }
    /* Stage h=8. */
    for (int g = 0; g < QK_POLAR; g += 16) {
        for (int j = 0; j < 8; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 8);
            vst1q_f32(x + g + j,     vaddq_f32(a, b));
            vst1q_f32(x + g + j + 8, vsubq_f32(a, b));
        }
    }
    /* Stage h=16. */
    for (int g = 0; g < QK_POLAR; g += 32) {
        for (int j = 0; j < 16; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 16);
            vst1q_f32(x + g + j,      vaddq_f32(a, b));
            vst1q_f32(x + g + j + 16, vsubq_f32(a, b));
        }
    }
    /* Stage h=32. */
    for (int g = 0; g < QK_POLAR; g += 64) {
        for (int j = 0; j < 32; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 32);
            vst1q_f32(x + g + j,      vaddq_f32(a, b));
            vst1q_f32(x + g + j + 32, vsubq_f32(a, b));
        }
    }
    /* Stage h=64. */
    for (int j = 0; j < 64; j += 4) {
        float32x4_t a = vld1q_f32(x + j);
        float32x4_t b = vld1q_f32(x + j + 64);
        vst1q_f32(x + j,      vaddq_f32(a, b));
        vst1q_f32(x + j + 64, vsubq_f32(a, b));
    }
}

void dequantize_row_q4_polar_neon(
    const block_q4_polar * x,
    float * y,
    int64_t k,
    int use_qjl)
{
    if (k <= 0 || (k % QK_POLAR) != 0) {
        return;
    }
    const int64_t nb = k / QK_POLAR;

    float qjl_signs[QK_POLAR];
    if (use_qjl) {
        polar_qjl_signs(qjl_signs);
    }

    const float inv_d = 1.0f / (float)QK_POLAR;

    for (int64_t b = 0; b < nb; b++) {
        const block_q4_polar * src = x + b;
        float * dst = y + b * QK_POLAR;

        const float l2 = polar_fp16_to_fp32(src->d);
        const float scale = inv_d * l2;

        float buf[QK_POLAR];
        unpack_codes_to_floats(src->qs, buf);

        if (use_qjl) {
            const uint8_t bit = (uint8_t)(src->qjl[0] & 1u);
            const float sign  = bit ? 1.0f : -1.0f;
            const float mag   = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);
            const float32x4_t vsm = vdupq_n_f32(sign * mag);
            for (int i = 0; i < QK_POLAR; i += 4) {
                float32x4_t v = vld1q_f32(buf + i);
                float32x4_t s = vld1q_f32(qjl_signs + i);
                v = vfmaq_f32(v, vsm, s);
                vst1q_f32(buf + i, v);
            }
        }

        hadamard_inplace_neon(buf);

        const float32x4_t vscale = vdupq_n_f32(scale);
        for (int i = 0; i < QK_POLAR; i += 4) {
            float32x4_t v = vld1q_f32(buf + i);
            v = vmulq_f32(v, vscale);
            vst1q_f32(dst + i, v);
        }
    }
}

#endif /* __ARM_NEON */
