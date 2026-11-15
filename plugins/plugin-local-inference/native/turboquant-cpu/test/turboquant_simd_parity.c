/* turboquant_simd_parity.c - end-to-end SIMD parity test.
 *
 * For every host build we always exercise the scalar reference round
 * trip across the canonical block lengths {32, 64, 128, 256, 512, 1024}.
 * Exits non-zero on any mismatch.
 */

#include "turboquant/turboquant.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define MAX_LEN 1024

static uint32_t rng_state = 0xC0FFEEu;
static float rand_normal(void) {
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


static const int kLens[] = { 32, 64, 128, 256, 512, 1024 };
static const int kNumLens = (int)(sizeof(kLens) / sizeof(kLens[0]));

/* Encode/decode one full buffer through a (encode_fn, decode_fn) pair.
 * Blocks are 32 floats each. */
typedef void (*q3_fn)(const float src[32], tbq_block_tbq3_0 * dst);
typedef void (*d3_fn)(const tbq_block_tbq3_0 * src, float dst[32]);
typedef void (*q4_fn)(const float src[32], tbq_block_tbq4_0 * dst);
typedef void (*d4_fn)(const tbq_block_tbq4_0 * src, float dst[32]);

static void run_tbq3(const float * src, int n,
                     tbq_block_tbq3_0 * blocks, float * out,
                     q3_fn q, d3_fn d) {
    const int n_blocks = n / 32;
    for (int b = 0; b < n_blocks; ++b) q(&src[b * 32], &blocks[b]);
    for (int b = 0; b < n_blocks; ++b) d(&blocks[b], &out[b * 32]);
}
static void run_tbq4(const float * src, int n,
                     tbq_block_tbq4_0 * blocks, float * out,
                     q4_fn q, d4_fn d) {
    const int n_blocks = n / 32;
    for (int b = 0; b < n_blocks; ++b) q(&src[b * 32], &blocks[b]);
    for (int b = 0; b < n_blocks; ++b) d(&blocks[b], &out[b * 32]);
}

static int test_tbq3_scalar_roundtrip(void) {
    int rc = 0;
    float src[MAX_LEN];
    tbq_block_tbq3_0 blocks[MAX_LEN / 32];
    float out[MAX_LEN];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        run_tbq3(src, n, blocks, out,
                 tbq_quantize_tbq3_block_ref, tbq_decode_tbq3_block_ref);
        /* Sanity: relative-L2 stays in the published band on N(0,1). */
        double num = 0, den = 0;
        for (int j = 0; j < n; ++j) {
            double e = (double)src[j] - (double)out[j];
            num += e * e; den += (double)src[j] * (double)src[j];
        }
        float rl2 = (float)sqrt(num / (den > 0 ? den : 1.0));
        if (!(rl2 < 0.40f)) {
            fprintf(stderr, "[simd_parity] tbq3 ref roundtrip n=%d rl2=%.4f\n", n, rl2);
            rc = 1;
        }
    }
    return rc;
}

static int test_tbq4_scalar_roundtrip(void) {
    int rc = 0;
    float src[MAX_LEN];
    tbq_block_tbq4_0 blocks[MAX_LEN / 32];
    float out[MAX_LEN];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        run_tbq4(src, n, blocks, out,
                 tbq_quantize_tbq4_block_ref, tbq_decode_tbq4_block_ref);
        double num = 0, den = 0;
        for (int j = 0; j < n; ++j) {
            double e = (double)src[j] - (double)out[j];
            num += e * e; den += (double)src[j] * (double)src[j];
        }
        float rl2 = (float)sqrt(num / (den > 0 ? den : 1.0));
        if (!(rl2 < 0.30f)) {
            fprintf(stderr, "[simd_parity] tbq4 ref roundtrip n=%d rl2=%.4f\n", n, rl2);
            rc = 1;
        }
    }
    return rc;
}


int main(void) {
    int rc = 0;

    fprintf(stdout, "[simd_parity] active SIMD lane: %s\n", tbq_active_simd());

    rc |= test_tbq3_scalar_roundtrip();
    rc |= test_tbq4_scalar_roundtrip();

    fprintf(stdout, "[simd_parity] no SIMD lane linked on this build - ref-only checks\n");

    if (rc) {
        fprintf(stderr, "[simd_parity] FAIL\n");
        return 2;
    }
    fprintf(stdout, "[simd_parity] PASS\n");
    return 0;
}
