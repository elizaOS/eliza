/* cpu_bench.c — single-thread CPU reference baseline for the five
 * Eliza-1 KV-cache kernels (turbo3, turbo4, turbo3_tcq, qjl, polar).
 *
 * SCOPE: companion to metal_bench.mm. Times the C reference impls in
 *   reference/turbo_kernels.c
 *   verify/qjl_polar_ref.c
 * at the SAME 9B-class production workload (head_dim=128, seq=4096,
 * n_kv_heads=32 -> 131072 blocks for turbo* and polar; n_qjl_kv_heads=8
 * -> 32768 packed K rows for QJL). Single-threaded, no SIMD intrinsics:
 * this is the lower-bound "naive scalar" baseline to compare against the
 * Metal GPU dispatch.
 *
 * Build:    make -C verify cpu-bench
 * Run:      ./cpu_bench [--iters N] [--warmup N] [--runs N]
 *           --runs is the number of repeated full-bench measurements
 *           whose median is reported (default 3).
 *
 * Output:   JSON to bench_results/cpu_m4max_2026-05-10.json plus a
 *           per-kernel summary on stdout. The JSON has the same shape
 *           per-kernel as metal_bench so the BENCHMARK doc can join them.
 */

#include "../reference/turbo_kernels.h"
#include "qjl_polar_ref.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ------------------- Workload constants (must match metal_bench.mm) -- */
#define HEAD_DIM       128
#define SEQ            4096
#define KV_HEADS       32
#define QJL_HEADS      32
#define QJL_KV_HEADS   8
#define QJL_PROJ_DIM   256
#define POLAR_ROWS     (KV_HEADS * SEQ)        /* 131072 */
#define TURBO_NKV      (KV_HEADS * SEQ)        /* 131072 */

/* The bench keeps these per-iteration counts low: a single iteration of a
 * CPU baseline at TURBO_NKV=131072 already does 131k Q·K dot products,
 * which is plenty of work to stabilise timing. We default to 3 outer
 * iterations and report median per-iter wall time. */
#define DEFAULT_ITERS   3
#define DEFAULT_WARMUP  1
#define DEFAULT_RUNS    3

/* ------------------- Timing helpers -------------------------------- */

static double now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1.0e6 + (double)ts.tv_nsec * 1.0e-3;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da < db) ? -1 : (da > db) ? 1 : 0;
}

static double median_d(double *xs, int n) {
    if (n <= 0) return 0.0;
    qsort(xs, (size_t)n, sizeof(double), cmp_double);
    if (n % 2) return xs[n / 2];
    return 0.5 * (xs[n / 2 - 1] + xs[n / 2]);
}

/* ------------------- Random fill ----------------------------------- */

static uint32_t xorshift32_state = 0xC0FFEE42u;
static uint32_t xorshift32(void) {
    uint32_t x = xorshift32_state;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return xorshift32_state = x;
}
static float randn_one(void) {
    /* Box-Muller from two uniform u32. */
    float u1 = ((float)(xorshift32() >> 8) + 1.0f) / (float)(1u << 24);
    float u2 = ((float)(xorshift32() >> 8) + 1.0f) / (float)(1u << 24);
    return sqrtf(-2.0f * logf(u1)) * cosf(6.283185307f * u2);
}
static void fill_randn(float *p, size_t n) {
    for (size_t i = 0; i < n; i++) p[i] = randn_one();
}
static void fill_rand_bytes(uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) p[i] = (uint8_t)(xorshift32() & 0xFF);
}

/* ------------------- Kernel runners -------------------------------- */

/* Each runner does ONE complete sweep of the production workload:
 * compute scores[N] from K_packed[N] · Q, where N is the kernel's
 * production block count. Returns elapsed wall-clock microseconds. */

static double run_turbo3(const float *q, const eliza_block_turbo3_0 *kblocks,
                         float *scores) {
    double t0 = now_us();
    for (int i = 0; i < TURBO_NKV; i++) {
        scores[i] = eliza_dot_q_turbo3(q, kblocks + (size_t)i * 4);
    }
    return now_us() - t0;
}

static double run_turbo4(const float *q, const eliza_block_turbo4_0 *kblocks,
                         float *scores) {
    double t0 = now_us();
    for (int i = 0; i < TURBO_NKV; i++) {
        scores[i] = eliza_dot_q_turbo4(q, kblocks + (size_t)i * 4);
    }
    return now_us() - t0;
}

static double run_turbo3_tcq(const float *q, const eliza_block_turbo3_tcq *kblocks,
                             float *scores) {
    double t0 = now_us();
    for (int i = 0; i < TURBO_NKV; i++) {
        scores[i] = eliza_dot_q_turbo3_tcq(q, kblocks + i);
    }
    return now_us() - t0;
}

static double run_qjl(const float *q_sketch, const eliza_block_qjl1_256 *packed_k,
                      float *scores) {
    double t0 = now_us();
    eliza_qjl_score_qk(q_sketch, packed_k, QJL_HEADS, QJL_KV_HEADS, SEQ, scores);
    return now_us() - t0;
}

static double run_polar(const float *q, const eliza_block_q4_polar *kblocks,
                        float *scores) {
    double t0 = now_us();
    eliza_polar_mul_mv(kblocks, q, POLAR_ROWS, /*use_qjl=*/0, scores);
    return now_us() - t0;
}

/* ------------------- Per-kernel bench ------------------------------ */

typedef struct {
    const char *name;
    int n_outputs;
    uint64_t bytes_per_dispatch;
    double median_us;       /* median of `runs` outer measurements */
    double min_us;
    double max_us;
} KernelStat;

static void bench_kernel(KernelStat *stat,
                         double (*run_fn)(void),
                         int warmup, int runs) {
    /* Warmup */
    for (int i = 0; i < warmup; i++) (void)run_fn();
    double samples[runs];
    for (int i = 0; i < runs; i++) samples[i] = run_fn();
    double mn = samples[0], mx = samples[0];
    for (int i = 1; i < runs; i++) {
        if (samples[i] < mn) mn = samples[i];
        if (samples[i] > mx) mx = samples[i];
    }
    stat->median_us = median_d(samples, runs);
    stat->min_us = mn;
    stat->max_us = mx;
}

/* Closures via globals (C doesn't have lambdas). */
static const float *g_q_turbo;
static eliza_block_turbo3_0 *g_k_turbo3;
static eliza_block_turbo4_0 *g_k_turbo4;
static eliza_block_turbo3_tcq *g_k_turbo3t;
static float *g_scores;

static const float *g_q_sketch;
static eliza_block_qjl1_256 *g_k_qjl;
static float *g_qjl_scores;

static const float *g_q_polar;
static eliza_block_q4_polar *g_k_polar;
static float *g_polar_scores;

static double thunk_turbo3(void)     { return run_turbo3    (g_q_turbo,  g_k_turbo3,  g_scores); }
static double thunk_turbo4(void)     { return run_turbo4    (g_q_turbo,  g_k_turbo4,  g_scores); }
static double thunk_turbo3_tcq(void) { return run_turbo3_tcq(g_q_turbo,  g_k_turbo3t, g_scores); }
static double thunk_qjl(void)        { return run_qjl       (g_q_sketch, g_k_qjl,     g_qjl_scores); }
static double thunk_polar(void)      { return run_polar     (g_q_polar,  g_k_polar,   g_polar_scores); }

/* ------------------- Main ----------------------------------------- */

int main(int argc, char **argv) {
    int warmup = DEFAULT_WARMUP, runs = DEFAULT_RUNS;
    const char *out_path = "bench_results/cpu_m4max_2026-05-10.json";
    for (int i = 1; i < argc; i++) {
        if      (strcmp(argv[i], "--warmup") == 0 && i + 1 < argc) warmup = atoi(argv[++i]);
        else if (strcmp(argv[i], "--runs")   == 0 && i + 1 < argc) runs   = atoi(argv[++i]);
        else if (strcmp(argv[i], "--out")    == 0 && i + 1 < argc) out_path = argv[++i];
    }
    if (runs < 1) runs = 1;

    fprintf(stderr, "[cpu_bench] warmup=%d runs=%d (single-thread C reference)\n",
            warmup, runs);
    fprintf(stderr, "[cpu_bench] workload: head_dim=%d seq=%d kv_heads=%d → %d blocks\n",
            HEAD_DIM, SEQ, KV_HEADS, TURBO_NKV);

    /* Allocate per-kernel inputs/outputs. We allocate once and reuse across
     * runs; the runners are read-only on the K-cache and write-only to scores. */
    float *q_turbo    = (float *)malloc(sizeof(float) * HEAD_DIM);
    float *scores     = (float *)malloc(sizeof(float) * TURBO_NKV);
    eliza_block_turbo3_0 *k_turbo3 = (eliza_block_turbo3_0 *)
        malloc(sizeof(eliza_block_turbo3_0) * (size_t)TURBO_NKV * 4);
    eliza_block_turbo4_0 *k_turbo4 = (eliza_block_turbo4_0 *)
        malloc(sizeof(eliza_block_turbo4_0) * (size_t)TURBO_NKV * 4);
    eliza_block_turbo3_tcq *k_turbo3t = (eliza_block_turbo3_tcq *)
        malloc(sizeof(eliza_block_turbo3_tcq) * (size_t)TURBO_NKV);

    float *q_sketch = (float *)malloc(sizeof(float) * QJL_HEADS * QJL_PROJ_DIM);
    eliza_block_qjl1_256 *k_qjl = (eliza_block_qjl1_256 *)
        malloc(sizeof(eliza_block_qjl1_256) * (size_t)QJL_KV_HEADS * SEQ);
    float *qjl_scores = (float *)malloc(sizeof(float) * QJL_HEADS * SEQ);

    float *q_polar  = (float *)malloc(sizeof(float) * HEAD_DIM);
    eliza_block_q4_polar *k_polar = (eliza_block_q4_polar *)
        malloc(sizeof(eliza_block_q4_polar) * (size_t)POLAR_ROWS);
    float *polar_scores = (float *)malloc(sizeof(float) * POLAR_ROWS);

    if (!q_turbo || !scores || !k_turbo3 || !k_turbo4 || !k_turbo3t ||
        !q_sketch || !k_qjl || !qjl_scores ||
        !q_polar  || !k_polar  || !polar_scores) {
        fprintf(stderr, "[cpu_bench] OOM allocating inputs\n");
        return 1;
    }

    /* Random fill — magnitudes don't matter for timing, only for valid
     * float math (avoiding NaN/Inf paths in the reference). */
    fill_randn(q_turbo, HEAD_DIM);
    fill_rand_bytes((uint8_t *)k_turbo3,
                    sizeof(eliza_block_turbo3_0) * (size_t)TURBO_NKV * 4);
    fill_rand_bytes((uint8_t *)k_turbo4,
                    sizeof(eliza_block_turbo4_0) * (size_t)TURBO_NKV * 4);
    fill_rand_bytes((uint8_t *)k_turbo3t,
                    sizeof(eliza_block_turbo3_tcq) * (size_t)TURBO_NKV);
    fill_randn(q_sketch, QJL_HEADS * QJL_PROJ_DIM);
    fill_rand_bytes((uint8_t *)k_qjl,
                    sizeof(eliza_block_qjl1_256) * (size_t)QJL_KV_HEADS * SEQ);
    fill_randn(q_polar, HEAD_DIM);
    fill_rand_bytes((uint8_t *)k_polar,
                    sizeof(eliza_block_q4_polar) * (size_t)POLAR_ROWS);

    g_q_turbo = q_turbo; g_k_turbo3 = k_turbo3; g_k_turbo4 = k_turbo4;
    g_k_turbo3t = k_turbo3t; g_scores = scores;
    g_q_sketch = q_sketch; g_k_qjl = k_qjl; g_qjl_scores = qjl_scores;
    g_q_polar = q_polar;  g_k_polar = k_polar; g_polar_scores = polar_scores;

    KernelStat stats[5] = {
        { "turbo3",     TURBO_NKV,
          (uint64_t)HEAD_DIM*sizeof(float)
            + (uint64_t)TURBO_NKV * sizeof(eliza_block_turbo3_0) * 4
            + (uint64_t)TURBO_NKV * sizeof(float), 0,0,0 },
        { "turbo4",     TURBO_NKV,
          (uint64_t)HEAD_DIM*sizeof(float)
            + (uint64_t)TURBO_NKV * sizeof(eliza_block_turbo4_0) * 4
            + (uint64_t)TURBO_NKV * sizeof(float), 0,0,0 },
        { "turbo3_tcq", TURBO_NKV,
          (uint64_t)HEAD_DIM*sizeof(float)
            + (uint64_t)TURBO_NKV * sizeof(eliza_block_turbo3_tcq)
            + (uint64_t)TURBO_NKV * sizeof(float), 0,0,0 },
        { "qjl",        QJL_HEADS * SEQ,
          (uint64_t)QJL_HEADS*QJL_PROJ_DIM*sizeof(float)
            + (uint64_t)QJL_KV_HEADS * SEQ * sizeof(eliza_block_qjl1_256)
            + (uint64_t)QJL_HEADS * SEQ * sizeof(float), 0,0,0 },
        { "polar",      POLAR_ROWS,
          (uint64_t)HEAD_DIM*sizeof(float)
            + (uint64_t)POLAR_ROWS * sizeof(eliza_block_q4_polar)
            + (uint64_t)POLAR_ROWS * sizeof(float), 0,0,0 },
    };
    double (*thunks[5])(void) = {
        thunk_turbo3, thunk_turbo4, thunk_turbo3_tcq, thunk_qjl, thunk_polar
    };

    for (int k = 0; k < 5; k++) {
        fprintf(stderr, "[cpu_bench] running %s ...\n", stats[k].name);
        bench_kernel(&stats[k], thunks[k], warmup, runs);
        fprintf(stderr, "  median=%.2f ms (min=%.2f ms max=%.2f ms)\n",
                stats[k].median_us / 1000.0,
                stats[k].min_us / 1000.0,
                stats[k].max_us / 1000.0);
    }

    /* Print summary table. */
    printf("\n%-12s | %12s | %12s | %12s | %12s\n",
           "kernel", "median_ms", "min_ms", "max_ms", "blocks/sec");
    printf("-------------+--------------+--------------+--------------+--------------\n");
    for (int k = 0; k < 5; k++) {
        double ms = stats[k].median_us / 1000.0;
        double bps = stats[k].median_us > 0
            ? (double)stats[k].n_outputs / (stats[k].median_us * 1.0e-6)
            : 0.0;
        printf("%-12s | %12.2f | %12.2f | %12.2f | %12.1f\n",
               stats[k].name, ms,
               stats[k].min_us / 1000.0,
               stats[k].max_us / 1000.0,
               bps);
    }

    /* Write JSON. */
    FILE *fp = fopen(out_path, "w");
    if (!fp) {
        fprintf(stderr, "[cpu_bench] cannot open %s for write\n", out_path);
        return 1;
    }
    fprintf(fp, "{\n");
    fprintf(fp, "  \"backend\": \"cpu_single_thread_c_reference\",\n");
    fprintf(fp, "  \"date\": \"2026-05-10\",\n");
    fprintf(fp, "  \"warmup\": %d,\n", warmup);
    fprintf(fp, "  \"runs\": %d,\n", runs);
    fprintf(fp, "  \"workload\": { \"head_dim\": %d, \"seq\": %d, \"kv_heads\": %d, \"qjl_kv_heads\": %d, \"polar_rows\": %d, \"turbo_n_kv\": %d },\n",
            HEAD_DIM, SEQ, KV_HEADS, QJL_KV_HEADS, POLAR_ROWS, TURBO_NKV);
    fprintf(fp, "  \"kernels\": [\n");
    for (int k = 0; k < 5; k++) {
        double ms = stats[k].median_us / 1000.0;
        double bw_GBs = stats[k].median_us > 0
            ? ((double)stats[k].bytes_per_dispatch / (stats[k].median_us * 1.0e-6)) / 1.0e9
            : 0.0;
        fprintf(fp, "    {\n");
        fprintf(fp, "      \"name\": \"%s\",\n", stats[k].name);
        fprintf(fp, "      \"n_outputs\": %d,\n", stats[k].n_outputs);
        fprintf(fp, "      \"bytes_per_dispatch\": %llu,\n",
                (unsigned long long)stats[k].bytes_per_dispatch);
        fprintf(fp, "      \"median_ms\": %.4f,\n", ms);
        fprintf(fp, "      \"min_ms\": %.4f,\n", stats[k].min_us / 1000.0);
        fprintf(fp, "      \"max_ms\": %.4f,\n", stats[k].max_us / 1000.0);
        fprintf(fp, "      \"bandwidth_GBs\": %.4f\n", bw_GBs);
        fprintf(fp, "    }%s\n", k + 1 == 5 ? "" : ",");
    }
    fprintf(fp, "  ]\n");
    fprintf(fp, "}\n");
    fclose(fp);
    fprintf(stderr, "[cpu_bench] wrote %s\n", out_path);

    free(q_turbo); free(scores);
    free(k_turbo3); free(k_turbo4); free(k_turbo3t);
    free(q_sketch); free(k_qjl); free(qjl_scores);
    free(q_polar); free(k_polar); free(polar_scores);
    return 0;
}
