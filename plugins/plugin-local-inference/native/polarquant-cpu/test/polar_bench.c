/* polar_bench.c — single-thread microbenchmark for the PolarQuant CPU
 * kernels in the V-cache attention hot path.
 *
 *   --throughput            (default) times dequantize_row_q4_polar,
 *                           ggml_vec_dot_q4_polar_q8_0, and
 *                           ggml_vec_dot_q4_polar_preht_f32 over a
 *                           synthetic K-cache: --rows blocks of 128
 *                           weights each, one 128-dim query reused across
 *                           all rows (the GQA-share attention pattern).
 *   --rows N                row count (default 8192 — ~672 KB of blocks,
 *                           fits a P-core L2 so the timing reflects
 *                           per-row compute, not the DRAM stream).
 *   --runs N / --warmup N   repeated full sweeps; median (and min on
 *                           stderr) reported.
 *   --out FILE              JSON dump.
 *
 * The active SIMD path is whatever the dispatcher selected at runtime
 * (polarquant_active_simd()).
 */

#define _POSIX_C_SOURCE 199309L
#include "polarquant/polarquant.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define POLAR_ROWS_DEFAULT  8192

static double now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1.0e6 + (double)ts.tv_nsec * 1.0e-3;
}
static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x < y) ? -1 : (x > y) ? 1 : 0;
}
static double median_d(double *v, int n) {
    qsort(v, (size_t)n, sizeof(double), cmp_d);
    return n & 1 ? v[n/2] : 0.5 * (v[n/2 - 1] + v[n/2]);
}

static uint32_t xs_state = 0xC001D00Du;
static float xs_uniform(void) {
    uint32_t s = xs_state; s ^= s << 13; s ^= s >> 17; s ^= s << 5; xs_state = s;
    return (float)((s >> 8) & 0xFFFFFFu) / (float)0x1000000u;
}
static float xs_normal(void) {
    float u1; do { u1 = xs_uniform(); } while (u1 < 1e-7f);
    float u2 = xs_uniform();
    return sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * u2);
}

/* Time `fn(arg)` over `runs` reps after `warmup`; returns median µs and
 * stores the min in *out_min. */
static double bench_loop(void (*fn)(void *), void *arg, int runs, int warmup,
                         double *out_min) {
    for (int w = 0; w < warmup; w++) fn(arg);
    double *t = malloc((size_t)runs * sizeof(double));
    for (int r = 0; r < runs; r++) { double t0 = now_us(); fn(arg); t[r] = now_us() - t0; }
    double mn = t[0];
    for (int r = 1; r < runs; r++) if (t[r] < mn) mn = t[r];
    double med = median_d(t, runs);
    free(t);
    if (out_min) *out_min = mn;
    return med;
}

typedef struct {
    int rows;
    const block_q4_polar *blocks;
    float *scratch;
    const struct block_q8_0 *q8;
    const float *q_preht;
    volatile float sink;
} ctx_t;

static void run_dequant(void *p) {
    ctx_t *c = p;
    for (int b = 0; b < c->rows; b++)
        dequantize_row_q4_polar(c->blocks + b, c->scratch, QK_POLAR, 1);
}
static void run_dot_q8(void *p) {
    ctx_t *c = p; float acc = 0.0f;
    for (int b = 0; b < c->rows; b++) {
        float s; ggml_vec_dot_q4_polar_q8_0(QK_POLAR, &s, c->blocks + b,
            c->q8 + (size_t)b * (QK_POLAR / QK8_0), 1); acc += s;
    }
    c->sink += acc;
}
static void run_dot_preht(void *p) {
    ctx_t *c = p; float acc = 0.0f;
    for (int b = 0; b < c->rows; b++) {
        float s; ggml_vec_dot_q4_polar_preht_f32(QK_POLAR, &s, c->blocks + b,
            c->q_preht, 1); acc += s;
    }
    c->sink += acc;
}

int main(int argc, char **argv) {
    int rows = POLAR_ROWS_DEFAULT, runs = 11, warmup = 4;
    const char *out_path = NULL;
    for (int i = 1; i < argc; i++) {
        if      (!strcmp(argv[i], "--rows")   && i+1 < argc) rows   = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--runs")   && i+1 < argc) runs   = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--warmup") && i+1 < argc) warmup = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--out")    && i+1 < argc) out_path = argv[++i];
        else if (!strcmp(argv[i], "--throughput")) { /* default mode */ }
    }
    if (rows < 1) rows = 1;
    if (runs < 1) runs = 1;
    const long work_n = (long)rows * QK_POLAR;

    fprintf(stderr, "[polar_bench] simd=%s rows=%d (%ld weights, %.0f KB blocks), runs=%d warmup=%d\n",
            polarquant_active_simd(), rows, work_n,
            (double)rows * sizeof(block_q4_polar) / 1024.0, runs, warmup);

    float *src = malloc((size_t)work_n * sizeof(float));
    float q[QK_POLAR], q_preht[QK_POLAR];
    block_q4_polar *blocks = malloc((size_t)rows * sizeof(block_q4_polar));
    float *scratch = malloc((size_t)QK_POLAR * sizeof(float));
    struct block_q8_0 *q8 = malloc((size_t)(work_n / QK8_0) * sizeof(struct block_q8_0));
    if (!src || !blocks || !scratch || !q8) { fprintf(stderr, "[polar_bench] OOM\n"); return 1; }

    for (long i = 0; i < work_n; i++) src[i] = xs_normal();
    for (int j = 0; j < QK_POLAR; j++) q[j] = xs_normal();
    memcpy(q_preht, q, sizeof(q));
    polar_hadamard_inplace(q_preht);
    quantize_row_q4_polar_ref(src, blocks, work_n, /*use_qjl=*/1);
    for (long qb = 0; qb < work_n / QK8_0; qb++) {
        const float *blk = src + qb * QK8_0;
        float amax = 0.0f;
        for (int j = 0; j < QK8_0; j++) { float a = fabsf(blk[j]); if (a > amax) amax = a; }
        float d = amax > 0.0f ? amax / 127.0f : 1.0f;
        float id = d != 0.0f ? 1.0f / d : 0.0f;
        for (int j = 0; j < QK8_0; j++) {
            int v = (int)lrintf(blk[j] * id);
            q8[qb].qs[j] = (int8_t)(v < -127 ? -127 : v > 127 ? 127 : v);
        }
        q8[qb].d = polar_fp32_to_fp16(d);
    }
    free(src);

    ctx_t c = { .rows = rows, .blocks = blocks, .scratch = scratch, .q8 = q8,
                .q_preht = q_preht, .sink = 0.0f };

    double deq_min, dq8_min, dp_min;
    double deq_med = bench_loop(run_dequant,   &c, runs, warmup, &deq_min);
    double dq8_med = bench_loop(run_dot_q8,    &c, runs, warmup, &dq8_min);
    double dp_med  = bench_loop(run_dot_preht, &c, runs, warmup, &dp_min);
    (void)c.sink;

    printf("\n%-32s | %12s | %12s | %12s\n", "polar kernel", "median_us", "min_us", "min ns/row");
    printf("---------------------------------+--------------+--------------+--------------\n");
    printf("%-32s | %12.1f | %12.1f | %12.2f\n", "dequantize_row_q4_polar",   deq_med, deq_min, deq_min*1e3/rows);
    printf("%-32s | %12.1f | %12.1f | %12.2f\n", "vec_dot_q4_polar_q8_0",     dq8_med, dq8_min, dq8_min*1e3/rows);
    printf("%-32s | %12.1f | %12.1f | %12.2f\n", "vec_dot_q4_polar_preht_f32",dp_med,  dp_min,  dp_min*1e3/rows);

    if (out_path) {
        FILE *fp = fopen(out_path, "w");
        if (fp) {
            fprintf(fp, "{\n  \"backend\": \"polar_cpu_%s\",\n", polarquant_active_simd());
            fprintf(fp, "  \"rows\": %d,\n", rows);
            fprintf(fp, "  \"dequantize_row_q4_polar_us\": %.2f,\n", deq_min);
            fprintf(fp, "  \"vec_dot_q4_polar_q8_0_us\": %.2f,\n", dq8_min);
            fprintf(fp, "  \"vec_dot_q4_polar_preht_f32_us\": %.2f,\n", dp_min);
            fprintf(fp, "  \"vec_dot_q4_polar_preht_f32_ns_per_row\": %.4f\n", dp_min*1e3/rows);
            fprintf(fp, "}\n");
            fclose(fp);
            fprintf(stderr, "[polar_bench] wrote %s\n", out_path);
        }
    }
    free(blocks); free(scratch); free(q8);
    return 0;
}
