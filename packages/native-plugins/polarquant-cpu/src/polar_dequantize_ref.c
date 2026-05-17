/* polar_dequantize_ref.c - reference decoder for block_q4_polar.
 *
 * Per block:
 *   1. Unpack 4-bit codes (low nibble first).
 *   2. Look up centroid value.
 *   3. (optional) apply 1-bit QJL residual correction.
 *   4. Apply inverse Hadamard rotation, with the correct
 *      compensation for the in-place butterfly's implicit scale.
 *   5. Multiply by per-block L2 norm.
 *
 * Hadamard scaling (mirrors polar_quantize_ref.c):
 *
 *   polar_hadamard_inplace(centroids) = centroids @ (sqrt(d) * H_ortho)
 *
 * Python decoder target (polar_quant.py:206):
 *   recon_norm = (centroids / sqrt(d)) @ H_ortho
 *              = (1/d) * (centroids @ (sqrt(d) * H_ortho))
 *              = (1/d) * polar_hadamard_inplace(centroids)
 *
 * So we divide by QK_POLAR after the butterfly, then multiply by the
 * stored fp16 L2 norm.
 */

#include <math.h>
#include <stdint.h>

#include "polarquant/polarquant.h"

void dequantize_row_q4_polar_ref(
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

        /* 1+2. Unpack codes -> centroid values. */
        float buf[QK_POLAR];
        for (int i = 0; i < QK_POLAR / 2; i++) {
            const uint8_t byte = src->qs[i];
            const uint8_t lo = (uint8_t)(byte & 0x0Fu);
            const uint8_t hi = (uint8_t)((byte >> 4) & 0x0Fu);
            buf[2 * i]     = POLAR_Q4_CENTROIDS[lo];
            buf[2 * i + 1] = POLAR_Q4_CENTROIDS[hi];
        }

        /* 3. Optional QJL residual correction.
         *
         * Encoder stored a single +/-1 sign bit (in qjl[0] bit 0)
         * representing sign(<residual, sign_vector>).  Decoder adds
         * that sign times a fixed magnitude along sign_vector.
         *
         * Magnitude divisor sqrt(QK_POLAR) matches the Python
         * reference (polar_quant.py:197): correction_dir =
         * random_signs / sqrt(bs).
         */
        if (use_qjl) {
            const uint8_t bit = (uint8_t)(src->qjl[0] & 1u);
            const float sign  = bit ? 1.0f : -1.0f;
            const float mag   = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);
            for (int i = 0; i < QK_POLAR; i++) {
                buf[i] += sign * mag * qjl_signs[i];
            }
        }

        /* 4. Inverse Hadamard.  See header comment for the (1/d)
         * compensation that turns the butterfly into the orthonormal
         * inverse the Python decoder uses.
         */
        polar_hadamard_inplace(buf);
        for (int i = 0; i < QK_POLAR; i++) {
            buf[i] *= inv_d;
        }

        /* 5. Per-block L2 rescale. */
        for (int i = 0; i < QK_POLAR; i++) {
            dst[i] = buf[i] * l2;
        }
    }
}
