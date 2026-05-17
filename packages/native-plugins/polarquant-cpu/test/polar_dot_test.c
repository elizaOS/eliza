/* polar_dot_test.c - assert ggml_vec_dot_q4_polar_q8_0_ref agrees with
 * an unquantized fp32 reference, with the budget set from the Python
 * reference's *own* per-block reconstruction error.
 *
 * Both inputs are deterministic Gaussian-ish floats.  We then:
 *   - quantize the "weights" row through Q4_POLAR,
 *   - quantize the "activations" row through Q8_0,
 *   - call the reference dot kernel,
 *   - compare against an fp32 dot of the *original* inputs.
 *
 * Empirically (verified against polar_quant.py + an explicit numpy
 * Q8_0 roundtrip on the same xorshift-Gaussian input), the rel-error
 * sits near 9%.  The on-device perplexity number that actually
 * matters (PPL Δ ≤ +0.05) is end-to-end, not single-block, and is
 * gated separately by the calibration parity test against a real
 * Eliza-1 lite checkpoint -- documented in README.md as next-session
 * work.
 *
 * Budget here: 12% relative.  Anything beyond that is a sign the C
 * dot kernel is doing math the Python reference is not.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "polarquant/polarquant.h"

#define N_BLOCKS  4
#define N_TOTAL   (N_BLOCKS * QK_POLAR)         /* 512 */
#define N_Q8      (N_TOTAL / QK8_0)             /* 16 */

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

/* Encode an fp32 row into block_q8_0 blocks (32 elements per block).
 * Standard llama.cpp formula: scale = max|x| / 127, codes = round(x / scale).
 */
static void encode_q8_0(const float * src, struct block_q8_0 * dst, int n) {
    const int nb = n / QK8_0;
    for (int b = 0; b < nb; b++) {
        const float * x = src + b * QK8_0;
        struct block_q8_0 * y = dst + b;

        float amax = 0.0f;
        for (int i = 0; i < QK8_0; i++) {
            const float a = fabsf(x[i]);
            if (a > amax) amax = a;
        }
        const float d = amax / 127.0f;
        const float id = (d > 0.0f) ? (1.0f / d) : 0.0f;

        y->d = polar_fp32_to_fp16(d);
        for (int i = 0; i < QK8_0; i++) {
            const float v = x[i] * id;
            const int   q = (int)roundf(v);
            const int   c = q < -128 ? -128 : (q > 127 ? 127 : q);
            y->qs[i] = (int8_t)c;
        }
    }
}

int main(void) {
    float weights[N_TOTAL];
    float acts[N_TOTAL];

    uint32_t rng = 0xDEADBEEFu;
    for (int i = 0; i < N_TOTAL; i++) {
        weights[i] = xorshift_normal(&rng);
    }
    for (int i = 0; i < N_TOTAL; i++) {
        acts[i] = xorshift_normal(&rng);
    }

    block_q4_polar wblocks[N_BLOCKS];
    struct block_q8_0 ablocks[N_Q8];

    quantize_row_q4_polar_ref(weights, wblocks, N_TOTAL, /*use_qjl=*/1);
    encode_q8_0(acts, ablocks, N_TOTAL);

    float dot_q = 0.0f;
    ggml_vec_dot_q4_polar_q8_0_ref(N_TOTAL, &dot_q, wblocks, ablocks, /*use_qjl=*/1);

    double dot_ref = 0.0;
    for (int i = 0; i < N_TOTAL; i++) {
        dot_ref += (double)weights[i] * (double)acts[i];
    }

    const double abs_err = fabs((double)dot_q - dot_ref);
    const double rel_err = abs_err / fabs(dot_ref);

    const double budget = 0.12;
    printf("[dot] dot_q=%.6f  dot_ref=%.6f  rel_err=%.6f  budget=%.2f\n",
           (double)dot_q, dot_ref, rel_err, budget);

    if (rel_err > budget) {
        fprintf(stderr, "FAIL: dot relative error %.6f exceeds %.2f\n",
                rel_err, budget);
        return 1;
    }
    return 0;
}
