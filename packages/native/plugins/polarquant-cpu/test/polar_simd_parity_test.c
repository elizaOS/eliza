/* polar_simd_parity_test.c - SIMD vs scalar parity over many blocks.
 *
 * On the active host arch (x86_64 -> AVX2, aarch64 -> NEON) we compare
 * the SIMD dequantizer and the SIMD dot product against the scalar
 * reference on a fixed-seed corpus of 100 random Q4_POLAR blocks.
 *
 * The Hadamard butterfly is associative-only up to floating-point
 * rounding order, and the AVX2/NEON path reorders the inner adds
 * relative to the scalar reference.  We require:
 *   - dequantize: per-element max abs diff <= 5e-5, mean abs diff
 *     <= 5e-7 (relative to centroid amplitudes ~3.0, that's < 2e-5
 *     relative);
 *   - dot product: relative error <= 1e-5 across the 4-block tile
 *     dotted against a Q8_0 row; double-precision accumulation makes
 *     this much tighter than the bit-exact decode parity above.
 *
 * On a host with no matching SIMD path (e.g. arm64 macOS without NEON
 * — unlikely — or non-x86/non-arm64 machines), the dispatcher falls
 * back to the scalar reference and parity is trivial 0; the test
 * still runs and passes.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "polarquant/polarquant.h"

#define N_BLOCKS 100
#define N_TOTAL  (N_BLOCKS * QK_POLAR)
#define N_Q8     (N_TOTAL / QK8_0)

static float xorshift_uniform(uint32_t *state) {
    uint32_t s = *state;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    *state = s;
    return (float)((s >> 8) & 0xFFFFFFu) / (float)0x1000000u;
}

static float xorshift_normal(uint32_t *state) {
    float u1, u2;
    do {
        u1 = xorshift_uniform(state);
    } while (u1 < 1e-7f);
    u2 = xorshift_uniform(state);
    return sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * u2);
}

static void encode_q8_0(const float *src, struct block_q8_0 *dst, int n) {
    const int nb = n / QK8_0;
    for (int b = 0; b < nb; b++) {
        const float *x = src + b * QK8_0;
        struct block_q8_0 *y = dst + b;
        float amax = 0.0f;
        for (int i = 0; i < QK8_0; i++) {
            const float a = fabsf(x[i]);
            if (a > amax) amax = a;
        }
        const float d  = amax / 127.0f;
        const float id = (d > 0.0f) ? (1.0f / d) : 0.0f;
        y->d = polar_fp32_to_fp16(d);
        for (int i = 0; i < QK8_0; i++) {
            int q = (int)roundf(x[i] * id);
            if (q < -128) q = -128;
            if (q >  127) q =  127;
            y->qs[i] = (int8_t)q;
        }
    }
}

static int dequant_parity(int use_qjl) {
    float input[N_TOTAL];
    block_q4_polar blocks[N_BLOCKS];
    float ref_out[N_TOTAL];
    float simd_out[N_TOTAL];

    uint32_t rng = 0xC001D00Du;
    for (int i = 0; i < N_TOTAL; i++) input[i] = xorshift_normal(&rng);

    quantize_row_q4_polar_ref(input, blocks, N_TOTAL, use_qjl);

    dequantize_row_q4_polar_ref(blocks, ref_out,  N_TOTAL, use_qjl);
    dequantize_row_q4_polar    (blocks, simd_out, N_TOTAL, use_qjl);

    double max_abs = 0.0;
    double sum_abs = 0.0;
    for (int i = 0; i < N_TOTAL; i++) {
        const double d = fabs((double)ref_out[i] - (double)simd_out[i]);
        if (d > max_abs) max_abs = d;
        sum_abs += d;
    }
    const double mean_abs = sum_abs / (double)N_TOTAL;

    const double max_budget  = 5e-5;
    const double mean_budget = 5e-7;

    printf("[simd-parity dequant] use_qjl=%d simd=%s  max_abs=%.3e  mean_abs=%.3e  budget=(%.0e, %.0e)\n",
           use_qjl, polarquant_active_simd(), max_abs, mean_abs, max_budget, mean_budget);

    if (max_abs > max_budget || mean_abs > mean_budget) {
        fprintf(stderr,
                "FAIL: dequant SIMD parity exceeded budget (max=%.3e mean=%.3e)\n",
                max_abs, mean_abs);
        return 1;
    }
    return 0;
}

static int dot_parity(int use_qjl) {
    float weights[N_TOTAL];
    float acts[N_TOTAL];

    uint32_t rng = 0xBAADF00Du;
    for (int i = 0; i < N_TOTAL; i++) weights[i] = xorshift_normal(&rng);
    for (int i = 0; i < N_TOTAL; i++) acts[i]    = xorshift_normal(&rng);

    block_q4_polar    wblocks[N_BLOCKS];
    struct block_q8_0 ablocks[N_Q8];

    quantize_row_q4_polar_ref(weights, wblocks, N_TOTAL, use_qjl);
    encode_q8_0(acts, ablocks, N_TOTAL);

    /* Dot the entire row in one shot through both kernels and compare
     * the running accumulators.  The dot kernel's per-Q8_0 scale path
     * uses double-precision accumulation in both implementations, so
     * the two answers should agree to within fp32 rounding of the
     * difference between the SIMD and scalar Hadamard orderings.
     */
    float ref_dot  = 0.0f;
    float simd_dot = 0.0f;
    ggml_vec_dot_q4_polar_q8_0_ref(N_TOTAL, &ref_dot,  wblocks, ablocks, use_qjl);
    ggml_vec_dot_q4_polar_q8_0    (N_TOTAL, &simd_dot, wblocks, ablocks, use_qjl);

    const double abs_err = fabs((double)ref_dot - (double)simd_dot);
    const double rel_err = abs_err / fabs((double)ref_dot);
    const double rel_budget = 1e-5;

    printf("[simd-parity dot] use_qjl=%d simd=%s  ref=%.6f simd=%.6f  rel_err=%.3e  budget=%.0e\n",
           use_qjl, polarquant_active_simd(), (double)ref_dot, (double)simd_dot,
           rel_err, rel_budget);

    if (rel_err > rel_budget) {
        fprintf(stderr,
                "FAIL: dot SIMD parity rel_err %.3e exceeds %.0e\n",
                rel_err, rel_budget);
        return 1;
    }
    return 0;
}

int main(void) {
    int failures = 0;
    failures += dequant_parity(/*use_qjl=*/0);
    failures += dequant_parity(/*use_qjl=*/1);
    failures += dot_parity(/*use_qjl=*/0);
    failures += dot_parity(/*use_qjl=*/1);
    return failures == 0 ? 0 : 1;
}
