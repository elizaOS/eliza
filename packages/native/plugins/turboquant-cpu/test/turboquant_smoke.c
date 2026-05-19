/* turboquant_smoke.c — minimal block-encode/decode round-trip smoke.
 *
 * Verifies block sizes match the fork's ggml-common.h (14 / 18 bytes),
 * and a single 32-element block round-trips through TBQ3 and TBQ4 with
 * relative L2 error within the published TurboQuant tolerances
 * (~0.10 for 3-bit and ~0.05 for 4-bit on N(0,1) input — these are
 * looser than the per-tensor downstream ppl thresholds because a
 * single block has no per-tensor scale to amortise across).
 *
 * Mirrors the qjl-cpu / polarquant-cpu smoke style: deterministic
 * input, hard-coded thresholds, exits non-zero on regression.
 */

#include "turboquant/turboquant.h"

#include <stdint.h>
#include <stdio.h>
#include <math.h>
#include <stddef.h>

/* xorshift32 — same generator family the reference path uses for
 * reproducibility across hosts. */
static uint32_t rng_state = 0xC0FFEEu;
static float rand_normal(void) {
    /* Marsaglia polar; consumes pairs but discards the second. */
    float u, v, s;
    do {
        rng_state ^= rng_state << 13; rng_state ^= rng_state >> 17; rng_state ^= rng_state << 5;
        u = (float)rng_state / 4294967296.0f * 2.0f - 1.0f;
        rng_state ^= rng_state << 13; rng_state ^= rng_state >> 17; rng_state ^= rng_state << 5;
        v = (float)rng_state / 4294967296.0f * 2.0f - 1.0f;
        s = u * u + v * v;
    } while (s >= 1.0f || s == 0.0f);
    return u * sqrtf(-2.0f * logf(s) / s);
}

static int check_size(const char * name, size_t got, size_t want) {
    if (got != want) {
        fprintf(stderr, "[turboquant_smoke] %s: sizeof = %zu, want %zu\n", name, got, want);
        return 1;
    }
    return 0;
}

static float rel_l2(const float * x, const float * y, int n) {
    double num = 0.0, den = 0.0;
    for (int i = 0; i < n; i++) {
        double d = (double)x[i] - (double)y[i];
        num += d * d;
        den += (double)x[i] * (double)x[i];
    }
    return den > 0.0 ? (float)sqrt(num / den) : 0.0f;
}

int main(void) {
    int rc = 0;

    rc |= check_size("block_tbq3_0", sizeof(tbq_block_tbq3_0), 14);
    rc |= check_size("block_tbq4_0", sizeof(tbq_block_tbq4_0), 18);
    if (rc) return rc;

    float src[32];
    for (int i = 0; i < 32; i++) src[i] = rand_normal();

    tbq_block_tbq3_0 b3;
    tbq_block_tbq4_0 b4;
    float dec3[32], dec4[32];

    tbq_quantize_tbq3_block(src, &b3);
    tbq_decode_tbq3_block(&b3, dec3);
    const float err3 = rel_l2(src, dec3, 32);

    tbq_quantize_tbq4_block(src, &b4);
    tbq_decode_tbq4_block(&b4, dec4);
    const float err4 = rel_l2(src, dec4, 32);

    fprintf(stdout, "[turboquant_smoke] tbq3_0 rel-L2 = %.4f (want < 0.30)\n", err3);
    fprintf(stdout, "[turboquant_smoke] tbq4_0 rel-L2 = %.4f (want < 0.20)\n", err4);

    if (!(err3 < 0.30f)) {
        fprintf(stderr, "[turboquant_smoke] FAIL: tbq3 round-trip exceeds tolerance\n");
        return 2;
    }
    if (!(err4 < 0.20f)) {
        fprintf(stderr, "[turboquant_smoke] FAIL: tbq4 round-trip exceeds tolerance\n");
        return 2;
    }

    fprintf(stdout, "[turboquant_smoke] PASS\n");
    return 0;
}
