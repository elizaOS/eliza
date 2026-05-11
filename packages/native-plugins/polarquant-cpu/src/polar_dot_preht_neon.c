/* polar_dot_preht_neon.c - ARM NEON pre-Hadamard-query Polar dot.
 *
 * Same algebra as polar_dot_preht_avx2.c: caller supplies q_preht = H*q
 * so each block becomes  unpack centroids -> (+residual) -> dot q_preht
 * -> accumulate (norm/128). No per-block inverse Hadamard, no decode
 * scratch. Exact relative to ggml_vec_dot_q4_polar_preht_f32_ref.
 *
 * Centroid lookup uses two vqtbl2q_u8 (16-byte table x 2) over the
 * nibble indices, then widens int8 indices? No — centroids are fp32, so
 * we keep an fp32 table and gather scalar-friendly here; the win is
 * folding the residual + dot + scale into one vectorised pass over q.
 *
 * Review-only build in this environment (no ARM hardware) — written so
 * an ARM agent can build/verify against polar_simd_parity_test.
 */

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include <arm_neon.h>
#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

/* Unpack 64 nibble bytes (qs) into 128 centroid floats in dst, in the
 * [lo0,hi0,lo1,hi1,...] order the reference uses. */
static inline void unpack_centroids_neon(const uint8_t * qs, float * dst) {
    for (int i = 0; i < QK_POLAR / 2; i++) {
        const uint8_t byte = qs[i];
        dst[2 * i]     = POLAR_Q4_CENTROIDS[byte & 0x0F];
        dst[2 * i + 1] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0F];
    }
}

void ggml_vec_dot_q4_polar_preht_f32_neon(
    int n, float * s, const block_q4_polar * x, const float * q_preht, int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) return;

    float signs[QK_POLAR];
    if (use_qjl) polar_qjl_signs(signs);
    const float residual_mag = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);

    const int nb = n / QK_POLAR;
    double acc_total = 0.0;

    for (int b = 0; b < nb; ++b) {
        const block_q4_polar *blk = x + b;
        const float *q = q_preht + b * QK_POLAR;
        const float norm_scale = polar_fp16_to_fp32(blk->d) * (1.0f / (float)QK_POLAR);
        const int  residual_bit = blk->qjl[0] & 1;
        const float residual = (residual_bit ? 1.0f : -1.0f) * residual_mag;
        const float32x4_t vres = vdupq_n_f32(residual);

        float cbuf[QK_POLAR];
        unpack_centroids_neon(blk->qs, cbuf);

        float32x4_t acc0 = vdupq_n_f32(0.0f);
        float32x4_t acc1 = vdupq_n_f32(0.0f);
        for (int i = 0; i < QK_POLAR; i += 8) {
            float32x4_t c0 = vld1q_f32(cbuf + i);
            float32x4_t c1 = vld1q_f32(cbuf + i + 4);
            if (use_qjl) {
                c0 = vfmaq_f32(c0, vres, vld1q_f32(signs + i));
                c1 = vfmaq_f32(c1, vres, vld1q_f32(signs + i + 4));
            }
            acc0 = vfmaq_f32(acc0, c0, vld1q_f32(q + i));
            acc1 = vfmaq_f32(acc1, c1, vld1q_f32(q + i + 4));
        }
        const float d = vaddvq_f32(vaddq_f32(acc0, acc1));
        acc_total += (double)norm_scale * (double)d;
    }
    *s = (float)acc_total;
}

#endif /* __ARM_NEON */
