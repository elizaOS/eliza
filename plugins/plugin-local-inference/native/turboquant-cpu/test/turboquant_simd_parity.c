/* turboquant_simd_parity.c - end-to-end SIMD parity test.
 *
 * For every host build we always exercise the scalar reference round
 * trip across the canonical block lengths {32, 64, 128, 256, 512, 1024}.
 * If the library was built with a SIMD lane (today: RVV on riscv64),
 * the test additionally cross-checks:
 *   - encode-ref decode-SIMD  bit-equal-ish to encode-ref decode-ref
 *   - encode-SIMD decode-ref  bit-equal-ish to encode-ref decode-ref
 *   - encode-SIMD decode-SIMD bit-equal-ish to encode-ref decode-ref
 *
 * "Bit-equal-ish": the codebook indices must match exactly (encoding
 * is deterministic), and the decoded floats must match the scalar
 * reference to within a small ε. The only fp-order drift comes from
 * the Hadamard reduction; ε <= 1e-4 absolute is the published bound.
 *
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

#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
static int compare_blocks_tbq3(const tbq_block_tbq3_0 * a, const tbq_block_tbq3_0 * b) {
    if (a->d != b->d) return 1;
    return memcmp(a->qs, b->qs, sizeof(a->qs));
}
static int compare_blocks_tbq4(const tbq_block_tbq4_0 * a, const tbq_block_tbq4_0 * b) {
    if (a->d != b->d) return 1;
    return memcmp(a->qs, b->qs, sizeof(a->qs));
}

static float max_abs_err(const float * a, const float * b, int n) {
    float m = 0.0f;
    for (int i = 0; i < n; ++i) {
        float d = fabsf(a[i] - b[i]);
        if (d > m) m = d;
    }
    return m;
}
#endif

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

#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
/* Encoded-block parity: SIMD encode must produce the same 14 / 18-byte
 * block as the scalar reference (deterministic codebook indices). */
static int test_tbq3_encode_parity(void) {
    int rc = 0;
    float src[MAX_LEN];
    tbq_block_tbq3_0 b_ref[MAX_LEN / 32];
    tbq_block_tbq3_0 b_sim[MAX_LEN / 32];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        const int nb = n / 32;
        for (int b = 0; b < nb; ++b) {
            tbq_quantize_tbq3_block_ref(&src[b * 32], &b_ref[b]);
            tbq_quantize_tbq3_block_rvv(&src[b * 32], &b_sim[b]);
            if (compare_blocks_tbq3(&b_ref[b], &b_sim[b]) != 0) {
                fprintf(stderr, "[simd_parity] tbq3 encode-parity mismatch n=%d block=%d\n", n, b);
                rc = 1;
            }
        }
    }
    return rc;
}
static int test_tbq4_encode_parity(void) {
    int rc = 0;
    float src[MAX_LEN];
    tbq_block_tbq4_0 b_ref[MAX_LEN / 32];
    tbq_block_tbq4_0 b_sim[MAX_LEN / 32];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        const int nb = n / 32;
        for (int b = 0; b < nb; ++b) {
            tbq_quantize_tbq4_block_ref(&src[b * 32], &b_ref[b]);
            tbq_quantize_tbq4_block_rvv(&src[b * 32], &b_sim[b]);
            if (compare_blocks_tbq4(&b_ref[b], &b_sim[b]) != 0) {
                fprintf(stderr, "[simd_parity] tbq4 encode-parity mismatch n=%d block=%d\n", n, b);
                rc = 1;
            }
        }
    }
    return rc;
}

/* Decode parity: SIMD decode and scalar decode of the same block must
 * agree within ε (Hadamard fp reduction order can drift by ~1e-6). */
static int test_tbq3_decode_parity(void) {
    int rc = 0;
    float src[MAX_LEN], out_ref[MAX_LEN], out_sim[MAX_LEN];
    tbq_block_tbq3_0 blocks[MAX_LEN / 32];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        const int nb = n / 32;
        for (int b = 0; b < nb; ++b) {
            tbq_quantize_tbq3_block_ref(&src[b * 32], &blocks[b]);
            tbq_decode_tbq3_block_ref(&blocks[b], &out_ref[b * 32]);
            tbq_decode_tbq3_block_rvv(&blocks[b], &out_sim[b * 32]);
        }
        float err = max_abs_err(out_ref, out_sim, n);
        if (!(err < 1e-4f)) {
            fprintf(stderr, "[simd_parity] tbq3 decode-parity n=%d max-abs-err=%g\n", n, (double)err);
            rc = 1;
        }
    }
    return rc;
}
static int test_tbq4_decode_parity(void) {
    int rc = 0;
    float src[MAX_LEN], out_ref[MAX_LEN], out_sim[MAX_LEN];
    tbq_block_tbq4_0 blocks[MAX_LEN / 32];
    for (int i = 0; i < kNumLens; ++i) {
        const int n = kLens[i];
        for (int j = 0; j < n; ++j) src[j] = rand_normal();
        const int nb = n / 32;
        for (int b = 0; b < nb; ++b) {
            tbq_quantize_tbq4_block_ref(&src[b * 32], &blocks[b]);
            tbq_decode_tbq4_block_ref(&blocks[b], &out_ref[b * 32]);
            tbq_decode_tbq4_block_rvv(&blocks[b], &out_sim[b * 32]);
        }
        float err = max_abs_err(out_ref, out_sim, n);
        if (!(err < 1e-4f)) {
            fprintf(stderr, "[simd_parity] tbq4 decode-parity n=%d max-abs-err=%g\n", n, (double)err);
            rc = 1;
        }
    }
    return rc;
}
#endif

int main(void) {
    int rc = 0;

    fprintf(stdout, "[simd_parity] active SIMD lane: %s\n", tbq_active_simd());

    rc |= test_tbq3_scalar_roundtrip();
    rc |= test_tbq4_scalar_roundtrip();

#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
    fprintf(stdout, "[simd_parity] RVV symbols linked - running cross-parity\n");
    rc |= test_tbq3_encode_parity();
    rc |= test_tbq4_encode_parity();
    rc |= test_tbq3_decode_parity();
    rc |= test_tbq4_decode_parity();
#else
    fprintf(stdout, "[simd_parity] no SIMD lane linked on this build - ref-only checks\n");
#endif

    if (rc) {
        fprintf(stderr, "[simd_parity] FAIL\n");
        return 2;
    }
    fprintf(stdout, "[simd_parity] PASS\n");
    return 0;
}
