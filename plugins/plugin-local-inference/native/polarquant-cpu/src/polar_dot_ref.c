/* polar_dot_ref.c - reference dot product between a Q4_POLAR row and
 * a Q8_0 activation row.
 *
 * Structural template: ggml_vec_dot_q4_K_q8_K from llama.cpp:
 *   - block-major loop over the smaller of the two block strides;
 *   - unpack x's nibbles to fp32 (centroid LUT in our case),
 *   - dequantize y's int8 codes by per-block fp16 scale,
 *   - accumulate floating-point inner product.
 *
 * The reference path is intentionally naive: it allocates a 128-float
 * scratch buffer per Q4_POLAR block and reuses dequantize_row_q4_polar_ref
 * for the unpacking step.  SIMD versions will fuse the unpack + Hadamard
 * + dot into a single pass without the materialised intermediate.
 *
 * QK_POLAR (128) is exactly 4 * QK8_0 (32), so each Q4_POLAR block lines
 * up with 4 consecutive Q8_0 blocks.  We exploit that 1:4 ratio in the
 * loop nest.
 */

#include "polarquant/polarquant.h"

void ggml_vec_dot_q4_polar_q8_0_ref(
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

    const int nb_polar = n / QK_POLAR;          /* number of x blocks */
    const int n_q8_per_polar = QK_POLAR / QK8_0; /* = 4 */

    float buf[QK_POLAR];
    double acc = 0.0;

    for (int b = 0; b < nb_polar; b++) {
        /* Step 1: dequantize this PolarQuant block to fp32. */
        dequantize_row_q4_polar_ref(x + b, buf, QK_POLAR, use_qjl);

        /* Step 2: walk the 4 matching Q8_0 blocks and accumulate. */
        for (int qb = 0; qb < n_q8_per_polar; qb++) {
            const struct block_q8_0 * yb = y + b * n_q8_per_polar + qb;
            const float scale = polar_fp16_to_fp32(yb->d);
            const float * xchunk = buf + qb * QK8_0;

            float local = 0.0f;
            for (int i = 0; i < QK8_0; i++) {
                local += xchunk[i] * (float)yb->qs[i];
            }
            acc += (double)scale * (double)local;
        }
    }

    *s = (float)acc;
}
