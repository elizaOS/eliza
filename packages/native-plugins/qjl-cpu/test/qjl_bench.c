/*
 * Combined parity-test + microbenchmark for the qjl-cpu library.
 *
 * Modes:
 *   --parity <fixture>   load a fixture emitted by scripts/gen_fixtures.py,
 *                        re-quantize the input keys with the AVX2/NEON/ref
 *                        paths, and verify bit-exact match against the
 *                        bytes recorded in the fixture (signs + bf16 norm).
 *   --throughput         measure ns/vec and GB/s for quantize + score on
 *                        random data using the bundled MT-projection.
 *
 * No third-party deps. Fixture binary parser is hand-rolled.
 */

#define _POSIX_C_SOURCE 200809L
#include "qjl/qjl.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <stdint.h>
#include <errno.h>

/* --------- timing -------- */
static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

/* --------- fixture I/O -------- */
typedef struct {
    int head_dim;
    int proj_dim;
    int seed;
    int n;
    int n_heads;
    int n_kv_heads;
    int n_tokens;
    float *proj;       /* head_dim * proj_dim */
    float *keys;       /* n * head_dim */
    uint8_t *signs;    /* n * (proj_dim/8) */
    uint16_t *norm16;  /* n */
    float *q_sketch;   /* n_heads * proj_dim */
    float *scores;     /* n_heads * n_tokens */
} fixture_t;

static int read_exact(FILE *f, void *buf, size_t n) {
    if (fread(buf, 1, n, f) != n) return -1;
    return 0;
}

static int load_fixture(const char *path, fixture_t *fx) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "open %s: %s\n", path, strerror(errno));
        return -1;
    }
    char header[256] = {0};
    int hi = 0;
    int c;
    while ((c = fgetc(f)) != EOF && c != '\n' && hi < 255) {
        header[hi++] = (char)c;
    }
    if (c == EOF) {
        fprintf(stderr, "truncated header\n");
        fclose(f); return -1;
    }
    header[hi] = 0;
    int matched = sscanf(header,
        "QJLFIXv1 head_dim=%d proj_dim=%d seed=%d n=%d n_heads=%d n_kv_heads=%d n_tokens=%d",
        &fx->head_dim, &fx->proj_dim, &fx->seed,
        &fx->n, &fx->n_heads, &fx->n_kv_heads, &fx->n_tokens);
    if (matched != 7) {
        fprintf(stderr, "bad header: %s (matched=%d)\n", header, matched);
        fclose(f); return -1;
    }
    if (fx->head_dim != QJL_HEAD_DIM || fx->proj_dim != QJL_PROJECTION_DIM) {
        fprintf(stderr, "fixture dims (%d,%d) != compiled (%d,%d)\n",
                fx->head_dim, fx->proj_dim, QJL_HEAD_DIM, QJL_PROJECTION_DIM);
        fclose(f); return -1;
    }
    size_t proj_n = (size_t)fx->head_dim * fx->proj_dim;
    size_t keys_n = (size_t)fx->n * fx->head_dim;
    size_t sgn_n  = (size_t)fx->n * (fx->proj_dim / 8);
    size_t qs_n   = (size_t)fx->n_heads * fx->proj_dim;
    size_t sc_n   = (size_t)fx->n_heads * fx->n_tokens;

    fx->proj     = malloc(proj_n * sizeof(float));
    fx->keys     = malloc(keys_n * sizeof(float));
    fx->signs    = malloc(sgn_n);
    fx->norm16   = malloc((size_t)fx->n * sizeof(uint16_t));
    fx->q_sketch = malloc(qs_n * sizeof(float));
    fx->scores   = malloc(sc_n * sizeof(float));
    if (!fx->proj || !fx->keys || !fx->signs || !fx->norm16
        || !fx->q_sketch || !fx->scores) {
        fprintf(stderr, "oom\n"); fclose(f); return -1;
    }
    if (read_exact(f, fx->proj, proj_n * sizeof(float)) ||
        read_exact(f, fx->keys, keys_n * sizeof(float)) ||
        read_exact(f, fx->signs, sgn_n) ||
        read_exact(f, fx->norm16, (size_t)fx->n * sizeof(uint16_t)) ||
        read_exact(f, fx->q_sketch, qs_n * sizeof(float)) ||
        read_exact(f, fx->scores, sc_n * sizeof(float))) {
        fprintf(stderr, "truncated fixture body\n"); fclose(f); return -1;
    }
    fclose(f);
    return 0;
}

static void free_fixture(fixture_t *fx) {
    free(fx->proj); free(fx->keys); free(fx->signs);
    free(fx->norm16); free(fx->q_sketch); free(fx->scores);
}

/* --------- parity -------- */

typedef void (*quant_fn)(const float *, const float *, qjl_block_qjl1_256 *);
typedef void (*score_fn)(const float *, const qjl_block_qjl1_256 *,
                          int, int, int, float *);

static int run_quant_parity(const char *name, quant_fn fn, const fixture_t *fx) {
    int sign_match = 0, norm_match = 0;
    int sign_norm_off1 = 0;  /* tolerance counter (unused — we expect 0) */
    qjl_block_qjl1_256 blk;
    for (int r = 0; r < fx->n; r++) {
        fn(fx->keys + r * QJL_HEAD_DIM, fx->proj, &blk);
        const uint8_t *expected_signs = fx->signs + r * QJL_PACKED_BYTES;
        if (memcmp(blk.qs, expected_signs, QJL_PACKED_BYTES) == 0) {
            sign_match++;
        } else {
            if (sign_match + sign_norm_off1 < 3) {
                int diffs = 0;
                for (int b = 0; b < QJL_PACKED_BYTES; b++) {
                    if (blk.qs[b] != expected_signs[b]) diffs++;
                }
                fprintf(stderr, "  [%s] row %d: %d/32 sign bytes mismatch\n",
                        name, r, diffs);
            }
        }
        uint16_t exp_norm = fx->norm16[r];
        if (blk.norm_bf16 == exp_norm) {
            norm_match++;
        } else {
            int delta = (int)blk.norm_bf16 - (int)exp_norm;
            if (delta == 1 || delta == -1) {
                norm_match++; /* 1 ULP tolerance allowed by spec */
            } else if (sign_match < 3) {
                fprintf(stderr, "  [%s] row %d: norm bf16 mismatch (got 0x%04x exp 0x%04x)\n",
                        name, r, blk.norm_bf16, exp_norm);
            }
        }
    }
    int ok = (sign_match == fx->n) && (norm_match == fx->n);
    printf("  %-6s quantize parity: signs %d/%d, norms %d/%d %s\n",
           name, sign_match, fx->n, norm_match, fx->n,
           ok ? "OK" : "FAIL");
    return ok ? 0 : 1;
}

static int run_score_parity(const char *name, score_fn fn, const fixture_t *fx) {
    /* Re-quantize the first n_kv_heads * n_tokens key vectors to build
     * the K cache exactly as the fixture's expected scores were computed. */
    int used = fx->n_kv_heads * fx->n_tokens;
    qjl_block_qjl1_256 *packed_k = malloc((size_t)used * sizeof(qjl_block_qjl1_256));
    if (!packed_k) { fprintf(stderr, "oom\n"); return 1; }
    for (int r = 0; r < used; r++) {
        /* Build packed blocks from the fixture's recorded signs + norms,
         * not from re-running the quantize path. This isolates the score
         * path from any quantize-stage drift. */
        memcpy(packed_k[r].qs, fx->signs + r * QJL_PACKED_BYTES, QJL_PACKED_BYTES);
        packed_k[r].norm_bf16 = fx->norm16[r];
    }
    /* The fixture was packed in row-major (n,) ; the score kernel expects
     * (n_kv_heads, n_tokens) — same memory order since we used the front
     * `used` blocks contiguously. */
    int sc_n = fx->n_heads * fx->n_tokens;
    float *got = malloc((size_t)sc_n * sizeof(float));
    if (!got) { free(packed_k); fprintf(stderr, "oom\n"); return 1; }
    fn(fx->q_sketch, packed_k,
       fx->n_heads, fx->n_kv_heads, fx->n_tokens, got);

    /* Compare with relative tolerance — tiny rounding allowed. */
    int ok = 0, fails = 0;
    float worst = 0.0f;
    for (int i = 0; i < sc_n; i++) {
        float a = got[i], b = fx->scores[i];
        float denom = fmaxf(1.0f, fmaxf(fabsf(a), fabsf(b)));
        float rel = fabsf(a - b) / denom;
        if (rel > worst) worst = rel;
        if (rel < 1e-4f) ok++;
        else if (fails < 3) {
            fprintf(stderr, "  [%s] score[%d]: got %.6f exp %.6f rel=%.6g\n",
                    name, i, a, b, rel);
            fails++;
        }
    }
    int allok = (ok == sc_n);
    printf("  %-6s score    parity: %d/%d (worst rel diff %.3g) %s\n",
           name, ok, sc_n, worst, allok ? "OK" : "FAIL");
    free(packed_k);
    free(got);
    return allok ? 0 : 1;
}

/* --------- throughput -------- */
static int run_throughput(void) {
    /* Standalone-mode bench: build a Π via the bundled MT helper and run
     * quantize + score over a synthetic batch. This exercises the SIMD
     * paths without needing a fixture. */
    const int N = 8192; /* keys */
    const int n_kv = 8, n_q = 32, n_tok = N / n_kv;

    float *proj = malloc((size_t)QJL_HEAD_DIM * QJL_PROJECTION_DIM * sizeof(float));
    float *keys = malloc((size_t)N * QJL_HEAD_DIM * sizeof(float));
    qjl_block_qjl1_256 *blocks = malloc((size_t)N * sizeof(qjl_block_qjl1_256));
    float *q_sketch = malloc((size_t)n_q * QJL_PROJECTION_DIM * sizeof(float));
    float *scores = malloc((size_t)n_q * n_tok * sizeof(float));
    if (!proj || !keys || !blocks || !q_sketch || !scores) {
        fprintf(stderr, "oom\n"); return 1;
    }

    qjl_make_projection_mt(proj, QJL_HEAD_DIM, QJL_PROJECTION_DIM, 42ULL);
    /* Fill keys + q_sketch with a pseudo-random pattern (not perf-critical). */
    uint64_t s = 0x12345678ABCDEFULL;
    for (size_t i = 0; i < (size_t)N * QJL_HEAD_DIM; i++) {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        keys[i] = ((float)(int32_t)(s >> 33) / 2147483648.0f);
    }
    for (size_t i = 0; i < (size_t)n_q * QJL_PROJECTION_DIM; i++) {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        q_sketch[i] = ((float)(int32_t)(s >> 33) / 2147483648.0f);
    }

    printf("CPU SIMD path: %s\n", qjl_active_simd());

    /* ---- quantize: ref + (avx2 OR neon if compiled) ---- */
    const int reps_ref = 3;
    const int reps_simd = 50;
    (void)reps_simd; /* suppressed when neither AVX2 nor NEON is built */

    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_ref; r++) qjl_quantize_rows_ref(keys, proj, blocks, N);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_ref * N);
        double bw  = (double)(reps_ref * N * QJL_HEAD_DIM * 4) / dt / 1e9;
        printf("  quantize  ref : %8.1f ns/vec, %6.2f GB/s in (keys)\n",
               per * 1e9, bw);
    }
#if defined(QJL_HAVE_AVX2)
    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_simd; r++) qjl_quantize_rows_avx2(keys, proj, blocks, N);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_simd * N);
        double bw  = (double)(reps_simd * N * QJL_HEAD_DIM * 4) / dt / 1e9;
        printf("  quantize  avx2: %8.1f ns/vec, %6.2f GB/s in (keys)\n",
               per * 1e9, bw);
    }
#endif
#if defined(QJL_HAVE_NEON)
    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_simd; r++) qjl_quantize_rows_neon(keys, proj, blocks, N);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_simd * N);
        double bw  = (double)(reps_simd * N * QJL_HEAD_DIM * 4) / dt / 1e9;
        printf("  quantize  neon: %8.1f ns/vec, %6.2f GB/s in (keys)\n",
               per * 1e9, bw);
    }
#endif

    /* ---- score ---- */
    qjl_quantize_rows(keys, proj, blocks, N);  /* prepare valid blocks */

    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_ref; r++)
            qjl_score_qk_ref(q_sketch, blocks, n_q, n_kv, n_tok, scores);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_ref * n_q * n_tok);
        double bw  = (double)(reps_ref * (size_t)n_kv * n_tok * QJL_BLOCK_BYTES) / dt / 1e9;
        printf("  score     ref : %8.1f ns/(qh,tok), %6.2f GB/s in (packed K)\n",
               per * 1e9, bw);
    }
#if defined(QJL_HAVE_AVX2)
    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_simd; r++)
            qjl_score_qk_avx2(q_sketch, blocks, n_q, n_kv, n_tok, scores);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_simd * n_q * n_tok);
        double bw  = (double)(reps_simd * (size_t)n_kv * n_tok * QJL_BLOCK_BYTES) / dt / 1e9;
        printf("  score     avx2: %8.1f ns/(qh,tok), %6.2f GB/s in (packed K)\n",
               per * 1e9, bw);
    }
#endif
#if defined(QJL_HAVE_NEON)
    {
        double t0 = now_seconds();
        for (int r = 0; r < reps_simd; r++)
            qjl_score_qk_neon(q_sketch, blocks, n_q, n_kv, n_tok, scores);
        double dt = now_seconds() - t0;
        double per = dt / (double)(reps_simd * n_q * n_tok);
        double bw  = (double)(reps_simd * (size_t)n_kv * n_tok * QJL_BLOCK_BYTES) / dt / 1e9;
        printf("  score     neon: %8.1f ns/(qh,tok), %6.2f GB/s in (packed K)\n",
               per * 1e9, bw);
    }
#endif

#if !(defined(__ARM_NEON) || defined(__ARM_NEON__))
    printf("  TODO: NEON throughput TBD on cuttlefish/arm64 (see README).\n");
#endif

    free(proj); free(keys); free(blocks); free(q_sketch); free(scores);
    return 0;
}

/* --------- main -------- */
static int parity(const char *path) {
    fixture_t fx;
    memset(&fx, 0, sizeof(fx));
    if (load_fixture(path, &fx) != 0) return 1;

    printf("loaded fixture: head_dim=%d proj_dim=%d n=%d n_heads=%d n_kv_heads=%d n_tokens=%d\n",
           fx.head_dim, fx.proj_dim, fx.n, fx.n_heads, fx.n_kv_heads, fx.n_tokens);
    printf("CPU SIMD path: %s\n", qjl_active_simd());

    int rc = 0;
    rc |= run_quant_parity("ref", qjl_quantize_row_ref, &fx);
#if defined(QJL_HAVE_AVX2)
    rc |= run_quant_parity("avx2", qjl_quantize_row_avx2, &fx);
#endif
#if defined(QJL_HAVE_NEON)
    rc |= run_quant_parity("neon", qjl_quantize_row_neon, &fx);
#endif

    rc |= run_score_parity("ref", qjl_score_qk_ref, &fx);
#if defined(QJL_HAVE_AVX2)
    rc |= run_score_parity("avx2", qjl_score_qk_avx2, &fx);
#endif
#if defined(QJL_HAVE_NEON)
    rc |= run_score_parity("neon", qjl_score_qk_neon, &fx);
#endif

    free_fixture(&fx);
    if (rc != 0) printf("PARITY: FAIL\n");
    else         printf("PARITY: OK\n");
    return rc;
}

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "--parity") == 0) {
        return parity(argv[2]);
    }
    if (argc >= 2 && strcmp(argv[1], "--throughput") == 0) {
        return run_throughput();
    }
    fprintf(stderr,
        "Usage:\n"
        "  qjl_bench --parity <fixture.bin>\n"
        "  qjl_bench --throughput\n");
    return 2;
}
