/* polar_dot_neon.c - ARM NEON dot product between Q4_POLAR and Q8_0 rows.
 *
 * Same shape as polar_dot_avx2.c.  NEON int8 -> fp32 expansion uses
 * vmovl_s8 + vmovl_s16 + vcvtq_f32_s32 to widen 8 codes per ld + cvt
 * pair.
 */

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include <arm_neon.h>
#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

/* Expand 32 int8 codes into 8 fp32 q-vectors of 4 lanes each. */
static inline void load_q8_chunk(const int8_t * src, float32x4_t out[8]) {
    int8x16_t a = vld1q_s8(src);       /* bytes 0..15 */
    int8x16_t b = vld1q_s8(src + 16);  /* bytes 16..31 */

    int16x8_t a_lo = vmovl_s8(vget_low_s8(a));
    int16x8_t a_hi = vmovl_s8(vget_high_s8(a));
    int16x8_t b_lo = vmovl_s8(vget_low_s8(b));
    int16x8_t b_hi = vmovl_s8(vget_high_s8(b));

    out[0] = vcvtq_f32_s32(vmovl_s16(vget_low_s16(a_lo)));
    out[1] = vcvtq_f32_s32(vmovl_s16(vget_high_s16(a_lo)));
    out[2] = vcvtq_f32_s32(vmovl_s16(vget_low_s16(a_hi)));
    out[3] = vcvtq_f32_s32(vmovl_s16(vget_high_s16(a_hi)));
    out[4] = vcvtq_f32_s32(vmovl_s16(vget_low_s16(b_lo)));
    out[5] = vcvtq_f32_s32(vmovl_s16(vget_high_s16(b_lo)));
    out[6] = vcvtq_f32_s32(vmovl_s16(vget_low_s16(b_hi)));
    out[7] = vcvtq_f32_s32(vmovl_s16(vget_high_s16(b_hi)));
}

void ggml_vec_dot_q4_polar_q8_0_neon(
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

    float buf[QK_POLAR];
    double acc = 0.0;

    for (int b = 0; b < nb_polar; b++) {
        dequantize_row_q4_polar_neon(x + b, buf, QK_POLAR, use_qjl);

        for (int qb = 0; qb < n_q8_per_polar; qb++) {
            const struct block_q8_0 * yb = y + b * n_q8_per_polar + qb;
            const float scale = polar_fp16_to_fp32(yb->d);
            const float * xchunk = buf + qb * QK8_0;

            float32x4_t q[8];
            load_q8_chunk(yb->qs, q);

            float32x4_t a = vdupq_n_f32(0.0f);
            for (int i = 0; i < 8; i++) {
                float32x4_t w = vld1q_f32(xchunk + i * 4);
                a = vfmaq_f32(a, w, q[i]);
            }
            const float local = vaddvq_f32(a);
            acc += (double)scale * (double)local;
        }
    }

    *s = (float)acc;
}

#endif /* __ARM_NEON */
