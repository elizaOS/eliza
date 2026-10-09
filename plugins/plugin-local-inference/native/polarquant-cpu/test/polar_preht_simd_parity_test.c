/* polar_preht_simd_parity_test.c - SIMD-vs-scalar parity for the
 * pre-Hadamard-query Polar dot over many blocks.
 *
 * The vectorised path reorders the inner adds relative to the scalar
 * reference, so we allow fp32-rounding-scale relative error (1e-5) plus
 * a small absolute floor. On a host with no matching SIMD path the
 * dispatcher returns the reference and parity is trivially 0.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include "polarquant/polarquant.h"

#define N_BLOCKS 64
#define N_TOTAL  (N_BLOCKS * QK_POLAR)

static float xu(uint32_t *st) {
    uint32_t s = *st; s ^= s << 13; s ^= s >> 17; s ^= s << 5; *st = s;
    return (float)((s >> 8) & 0xFFFFFFu) / (float)0x1000000u;
}
static float xn(uint32_t *st) {
    float u1; do { u1 = xu(st); } while (u1 < 1e-7f);
    return sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * xu(st));
}

static int run(int use_qjl) {
    float weights[N_TOTAL], q[N_TOTAL], q_preht[N_TOTAL];
    block_q4_polar blocks[N_BLOCKS];
    uint32_t rng = 0x5EED1234u;
    for (int i = 0; i < N_TOTAL; ++i) { weights[i] = xn(&rng); q[i] = xn(&rng); q_preht[i] = q[i]; }
    for (int b = 0; b < N_BLOCKS; ++b) polar_hadamard_inplace(q_preht + b * QK_POLAR);
    quantize_row_q4_polar_ref(weights, blocks, N_TOTAL, use_qjl);

    float ref = 0.0f, got = 0.0f;
    ggml_vec_dot_q4_polar_preht_f32_ref(N_TOTAL, &ref, blocks, q_preht, use_qjl);
    ggml_vec_dot_q4_polar_preht_f32   (N_TOTAL, &got, blocks, q_preht, use_qjl);

    const double abs_err = fabs((double)ref - (double)got);
    const double rel_err = abs_err / fmax(1.0, fabs((double)ref));
    printf("[polar-preht-simd] use_qjl=%d simd=%s ref=%.6f got=%.6f rel=%.3e\n",
           use_qjl, polarquant_active_simd(), (double)ref, (double)got, rel_err);
    if (rel_err > 1e-5 && abs_err > 2e-4) {
        fprintf(stderr, "FAIL: preht SIMD parity exceeded budget\n");
        return 1;
    }
    return 0;
}

int main(void) {
    int f = 0;
    f += run(0);
    f += run(1);
    return f == 0 ? 0 : 1;
}
