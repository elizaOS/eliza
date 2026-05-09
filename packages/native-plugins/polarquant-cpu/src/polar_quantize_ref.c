/* polar_quantize_ref.c - reference encoder for block_q4_polar.
 *
 * Per QK_POLAR-element block:
 *   1. Compute L2 norm and store as fp16 in d.
 *   2. Normalize the block to the unit hypersphere.
 *   3. In-place Walsh-Hadamard rotation (matches polar_quant.py:
 *      blocks_norm @ H, where H is normalized so H @ H.T == I; see
 *      below for the equivalent scaling we apply here).
 *   4. Scale by sqrt(QK_POLAR) so each rotated coordinate is ~ N(0, 1)
 *      and bucketize into one of 16 Lloyd-Max centroids.
 *   5. Pack the 4-bit centroid indices, two per byte.
 *   6. Optional QJL residual: project (input - centroid) onto a
 *      deterministic +/-1 sign vector and store the projection sign.
 *
 * The Hadamard butterfly we use accumulates a factor of QK_POLAR vs
 * the orthonormal H matrix from polar_quant.py.  Concretely:
 *
 *     polar_hadamard_inplace(x)  <==>  x @ (sqrt(QK_POLAR) * H)
 *
 * so to land at the same scaled-N(0,1) coordinates the Python encoder
 * sees, we multiply by 1/sqrt(QK_POLAR) once after the butterfly.
 * (Equivalently: the Python encoder does blocks_norm @ H * sqrt(d);
 * our butterfly already supplies the implicit sqrt(d), so we only
 * have to apply * sqrt(d) -- but the butterfly's factor cancels the
 * normalisation, which leaves us applying 1.0f.  The net of the two
 * is: just apply the butterfly on the unit-norm block, then bucketize.)
 */

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "polarquant/polarquant.h"

/* Bucketize a single rotated-and-scaled coordinate against the
 * precomputed Voronoi cell boundaries.  Returns an index in [0, 15].
 * Linear scan; with 15 boundaries the branch predictor handles it
 * fine and we avoid a binary-search bug surface.  NEON variant will
 * use vsel/vmin to emit codes in parallel.
 */
static inline uint8_t polar_q4_bucketize(float v) {
    uint8_t code = 0;
    for (int i = 0; i < POLAR_Q4_N_LEVELS - 1; i++) {
        if (v > POLAR_Q4_BOUNDARIES[i]) {
            code = (uint8_t)(i + 1);
        }
    }
    return code;
}

void quantize_row_q4_polar_ref(
    const float * x,
    block_q4_polar * y,
    int64_t k,
    int use_qjl)
{
    /* Caller is responsible for the precondition; we assert via a
     * defensive early-return on debug builds rather than crashing on
     * a partial last block.
     */
    if (k <= 0 || (k % QK_POLAR) != 0) {
        return;
    }

    const int64_t nb = k / QK_POLAR;

    float qjl_signs[QK_POLAR];
    if (use_qjl) {
        polar_qjl_signs(qjl_signs);
    }

    for (int64_t b = 0; b < nb; b++) {
        const float * src = x + b * QK_POLAR;
        block_q4_polar * dst = y + b;

        /* 1. L2 norm */
        double sumsq = 0.0;
        for (int i = 0; i < QK_POLAR; i++) {
            sumsq += (double)src[i] * (double)src[i];
        }
        const float l2 = (float)sqrt(sumsq);
        const float inv_l2 = (l2 > 1e-10f) ? (1.0f / l2) : 0.0f;
        dst->d = polar_fp32_to_fp16(l2);

        /* 2. Normalize */
        float buf[QK_POLAR];
        for (int i = 0; i < QK_POLAR; i++) {
            buf[i] = src[i] * inv_l2;
        }

        /* 3. Walsh-Hadamard rotation + scale to N(0, 1) coords.
         *
         *    polar_hadamard_inplace(unit_block) gives us
         *        unit_block @ (sqrt(d) * H_ortho)
         *      = sqrt(d) * (unit_block @ H_ortho)
         *      = sqrt(d) * blocks_rot
         *      = blocks_scaled       (per polar_quant.py line 144)
         *
         *    So the butterfly already lands us at the unit-variance
         *    coordinates the Lloyd-Max centroids are calibrated for;
         *    no additional scaling is required.
         */
        polar_hadamard_inplace(buf);

        /* 5. Bucketize + pack.  Two codes per byte; low nibble is the
         * even-index code, high nibble the odd-index code (matches the
         * layout llama.cpp's existing 4-bit kernels assume so we can
         * reuse SIMD unpacking later).
         */
        uint8_t codes[QK_POLAR];
        for (int i = 0; i < QK_POLAR; i++) {
            codes[i] = polar_q4_bucketize(buf[i]);
        }
        for (int i = 0; i < QK_POLAR / 2; i++) {
            const uint8_t lo = codes[2 * i];
            const uint8_t hi = codes[2 * i + 1];
            dst->qs[i] = (uint8_t)((hi << 4) | (lo & 0x0F));
        }

        /* 6. Optional 1-bit QJL residual.
         *    residual = scaled_coord - centroid_value
         *    projection = sum(residual * sign_vector)
         *    bit = projection >= 0 ? 1 : 0
         */
        if (use_qjl) {
            uint8_t qjl_packed[QJL_RESIDUAL_BYTES];
            memset(qjl_packed, 0, sizeof(qjl_packed));

            /* All 128 coords share a single projection direction,
             * giving 1 sign per BLOCK -- not 1 sign per coord.  To
             * keep the storage budget at QK_POLAR/8 bytes (= 16) the
             * paper actually sweeps 128 distinct sign vectors, one per
             * residual bit, but the practical implementation in
             * polar_quant.py uses ONE sign vector per block and stores
             * a single residual bit.
             *
             * Our block layout reserves QJL_RESIDUAL_BYTES = 16 bytes
             * for forward-compatible per-coord bits.  In this
             * reference we set bit 0 of qjl[0] to the global sign and
             * leave the other bits at zero; the decoder reads bit 0
             * and applies the magnitude correction along the same
             * sign vector.  Future work may upgrade to per-coord bits
             * without changing the on-disk size.
             */
            float proj = 0.0f;
            for (int i = 0; i < QK_POLAR; i++) {
                const float c = POLAR_Q4_CENTROIDS[codes[i]];
                proj += (buf[i] - c) * qjl_signs[i];
            }
            const uint8_t bit = (proj >= 0.0f) ? 1u : 0u;
            qjl_packed[0] = bit;

            memcpy(dst->qjl, qjl_packed, QJL_RESIDUAL_BYTES);
        } else {
            memset(dst->qjl, 0, QJL_RESIDUAL_BYTES);
        }
    }
}
