#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include "polarquant/polarquant.h"

#define N_BLOCKS 4
#define N_TOTAL  (N_BLOCKS * QK_POLAR)

static float xorshift_uniform(uint32_t * state) {
    uint32_t s = *state;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    *state = s;
    return (float)((s >> 8) & 0xFFFFFFu) / (float)0x1000000u;
}

static float xorshift_normal(uint32_t * state) {
    float u1, u2;
    do {
        u1 = xorshift_uniform(state);
    } while (u1 < 1e-7f);
    u2 = xorshift_uniform(state);
    return sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * u2);
}

static float dot_fp32(const float *a, const float *b, int n) {
    double acc = 0.0;
    for (int i = 0; i < n; ++i) {
        acc += (double)a[i] * (double)b[i];
    }
    return (float)acc;
}

int main(void) {
    float weights[N_TOTAL];
    float q[N_TOTAL];
    float q_preht[N_TOTAL];
    float decoded[QK_POLAR];
    block_q4_polar blocks[N_BLOCKS];

    uint32_t rng = 0xC001D00Du;
    for (int i = 0; i < N_TOTAL; ++i) {
        weights[i] = xorshift_normal(&rng);
        q[i] = xorshift_normal(&rng);
        q_preht[i] = q[i];
    }
    for (int b = 0; b < N_BLOCKS; ++b) {
        polar_hadamard_inplace(q_preht + b * QK_POLAR);
    }

    for (int use_qjl = 0; use_qjl <= 1; ++use_qjl) {
        quantize_row_q4_polar_ref(weights, blocks, N_TOTAL, use_qjl);

        float preht = 0.0f;
        ggml_vec_dot_q4_polar_preht_f32_ref(N_TOTAL, &preht, blocks, q_preht, use_qjl);

        double baseline = 0.0;
        for (int b = 0; b < N_BLOCKS; ++b) {
            dequantize_row_q4_polar_ref(blocks + b, decoded, QK_POLAR, use_qjl);
            baseline += (double)dot_fp32(decoded, q + b * QK_POLAR, QK_POLAR);
        }

        const double abs_err = fabs((double)preht - baseline);
        const double rel_err = abs_err / fmax(1.0, fabs(baseline));
        printf("[polar-preht-dot] use_qjl=%d preht=%.6f baseline=%.6f abs=%.6g rel=%.6g\n",
               use_qjl, (double)preht, baseline, abs_err, rel_err);
        if (rel_err > 1e-5 && abs_err > 2e-4) {
            fprintf(stderr, "FAIL: preht dot mismatch for use_qjl=%d\n", use_qjl);
            return 1;
        }
    }
    return 0;
}
