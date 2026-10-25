#include "polarquant/polarquant.h"

void ggml_vec_dot_q4_polar_preht_f32_ref(
    int n,
    float * s,
    const block_q4_polar * x,
    const float * q_preht,
    int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) {
        return;
    }

    float signs[QK_POLAR];
    polar_qjl_signs(signs);
    const float residual_mag = POLAR_QJL_CORRECTION_MAGNITUDE / 11.313708498984761f;
    const int nb = n / QK_POLAR;
    double acc_total = 0.0;

    for (int b = 0; b < nb; ++b) {
        const block_q4_polar *blk = x + b;
        const float *q = q_preht + b * QK_POLAR;
        const float norm_scale = polar_fp16_to_fp32(blk->d) * (1.0f / (float)QK_POLAR);
        const int residual_bit = blk->qjl[0] & 1;
        const float residual_sign = residual_bit ? 1.0f : -1.0f;
        const float residual = residual_sign * residual_mag;

        double acc = 0.0;
        for (int i = 0; i < QK_POLAR / 2; ++i) {
            const uint8_t byte = blk->qs[i];
            const int i0 = 2 * i;
            const int i1 = i0 + 1;
            float x0 = POLAR_Q4_CENTROIDS[byte & 0x0F];
            float x1 = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0F];
            if (use_qjl) {
                x0 += residual * signs[i0];
                x1 += residual * signs[i1];
            }
            acc += (double)x0 * (double)q[i0];
            acc += (double)x1 * (double)q[i1];
        }
        acc_total += (double)norm_scale * acc;
    }

    *s = (float)acc_total;
}
