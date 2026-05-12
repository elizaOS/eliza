/* cpu_simd_bench.c — SIMD-path microbenchmark for the Eliza-1 CPU KV
 * kernels at the production attention-score workload, with a thread sweep.
 *
 * Companion to cpu_bench.c (which times the *scalar C reference*). This
 * harness links the qjl-cpu / polarquant-cpu plugin static libraries and
 * times their dispatched SIMD entrypoints (qjl_active_simd() /
 * polarquant_active_simd() report which tier ran), so the AVX-VNNI int8
 * QJL score, the AVX2 fp32 QJL score, and the AVX2 pre-Hadamard Polar
 * dot are measured the same way the fork's ggml-cpu invokes them.
 *
 * Workload (matches cpu_bench.c / metal_bench.mm):
 *   - QJL score: n_heads=32, n_kv_heads=8, n_tokens=N (default 4096) ->
 *     32*N output scores; head_dim=128, proj_dim=256.
 *   - Polar pre-Hadamard dot: 32*N K-rows of 128 dims dotted against one
 *     pre-Hadamarded query (the GQA-share pattern), use_qjl=1.
 *
 * Thread sweep: --threads "1 4 8 16 24" runs each kernel split over T
 * OpenMP threads across the head loop (QJL) / row loop (Polar). The split
 * is over disjoint output rows so there is no reduction and no FP
 * reassociation across threads — bit-identical to T=1.
 *
 * Build: make -C verify cpu-simd-bench   (requires the plugin libs built;
 *        the Makefile target builds them via cmake first).
 * Run:   ./cpu_simd_bench [--n N] [--runs R] [--warmup W]
 *                         [--threads "1 4 8 16 24"] [--out FILE]
 */

#define _POSIX_C_SOURCE 199309L

#include "qjl/qjl.h"
#include "qjl_block.h"
#include "polarquant/polarquant.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _OPENMP
#include <omp.h>
#endif

#define N_HEADS        32
#define N_KV_HEADS      8
#define DEFAULT_NTOK 4096

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
    return n & 1 ? v[n/2] : 0.5 * (v[n/2-1] + v[n/2]);
}

static uint64_t rng = 0x12345678ABCDEFULL;
static float rnd(void) {
    rng = rng * 6364136223846793005ULL + 1442695040888963407ULL;
    return (float)(int32_t)(rng >> 33) / 2147483648.0f;
}
static float rnd_n(void) {
    float u1; do { u1 = 0.5f * (rnd() + 1.0f); } while (u1 < 1e-7f);
    float u2 = 0.5f * (rnd() + 1.0f);
    return sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * u2);
}

/* ---- shared inputs (allocated once) ---- */
static int g_ntok;
static float                *g_q_sketch_f32;   /* N_HEADS * proj_dim */
static qjl_i8_sketch_256     *g_q_sketch_i8;    /* N_HEADS */
static qjl_block_qjl1_256    *g_k_qjl;          /* N_KV_HEADS * ntok */
static float                 *g_qjl_scores;     /* N_HEADS * ntok */
static block_q4_polar        *g_k_polar;        /* N_HEADS * ntok */
static float                 *g_q_preht;        /* 128 */
static float                 *g_polar_scores;   /* N_HEADS * ntok */

/* QJL fp32 / int8 score split over `nthreads` head ranges. */
static double run_qjl_fp32(int nthreads) {
    const int gqa = N_HEADS / N_KV_HEADS;
    double t0 = now_us();
#ifdef _OPENMP
    #pragma omp parallel for num_threads(nthreads) schedule(static)
#endif
    for (int hq = 0; hq < N_HEADS; hq++) {
        const int hk = hq / gqa;
        qjl_score_qk(g_q_sketch_f32 + (size_t)hq * QJL_PROJECTION_DIM,
                     g_k_qjl + (size_t)hk * g_ntok,
                     1, 1, g_ntok,
                     g_qjl_scores + (size_t)hq * g_ntok);
    }
    (void)nthreads;
    return now_us() - t0;
}
static double run_qjl_i8(int nthreads) {
    const int gqa = N_HEADS / N_KV_HEADS;
    double t0 = now_us();
#ifdef _OPENMP
    #pragma omp parallel for num_threads(nthreads) schedule(static)
#endif
    for (int hq = 0; hq < N_HEADS; hq++) {
        const int hk = hq / gqa;
        qjl_score_qk_i8(g_q_sketch_i8 + hq,
                        g_k_qjl + (size_t)hk * g_ntok,
                        1, 1, g_ntok,
                        g_qjl_scores + (size_t)hq * g_ntok);
    }
    (void)nthreads;
    return now_us() - t0;
}
/* Polar pre-Hadamard dot over all rows, split over `nthreads`. */
static double run_polar_preht(int nthreads) {
    const long nrows = (long)N_HEADS * g_ntok;
    double t0 = now_us();
#ifdef _OPENMP
    #pragma omp parallel for num_threads(nthreads) schedule(static)
#endif
    for (long r = 0; r < nrows; r++) {
        float s;
        ggml_vec_dot_q4_polar_preht_f32(QK_POLAR, &s, g_k_polar + r, g_q_preht, 1);
        g_polar_scores[r] = s;
    }
    (void)nthreads;
    return now_us() - t0;
}

typedef struct { const char *name; double (*fn)(int); int n_out; } Bench;

static const char *bench_backend_name(void) {
#if defined(__aarch64__) || defined(__arm64__) || defined(__ARM_NEON) || defined(__ARM_NEON__)
    return "cpu_arm64_simd_plugins";
#elif defined(__x86_64__) || defined(_M_X64)
    return "cpu_x86_64_simd_plugins";
#else
    return "cpu_generic_simd_plugins";
#endif
}

int main(int argc, char **argv) {
    int ntok = DEFAULT_NTOK, runs = 5, warmup = 1;
    const char *out_path = NULL;
    int threads[16] = {1, 4, 8, 16, 24}; int nthreads = 5;
    for (int i = 1; i < argc; i++) {
        if      (!strcmp(argv[i], "--n")       && i+1 < argc) ntok    = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--runs")    && i+1 < argc) runs    = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--warmup")  && i+1 < argc) warmup  = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--out")     && i+1 < argc) out_path= argv[++i];
        else if (!strcmp(argv[i], "--threads") && i+1 < argc) {
            nthreads = 0; char *s = argv[++i]; char *tok = strtok(s, " ,");
            while (tok && nthreads < 16) { threads[nthreads++] = atoi(tok); tok = strtok(NULL, " ,"); }
        }
    }
#ifndef _OPENMP
    if (nthreads != 1 || threads[0] != 1) {
        fprintf(stderr, "[cpu_simd_bench] OpenMP unavailable; running single-thread SIMD bench only\n");
    }
    threads[0] = 1;
    nthreads = 1;
#endif
    if (runs < 1) runs = 1;
    if (ntok < 1) ntok = 1;
    g_ntok = ntok;
    const long nrows = (long)N_HEADS * ntok;

    fprintf(stderr, "[cpu_simd_bench] qjl=%s polar=%s ntok=%d (%ld out) runs=%d warmup=%d\n",
            qjl_active_simd(), polarquant_active_simd(), ntok, (long)N_HEADS*ntok, runs, warmup);

    /* Allocate. */
    g_q_sketch_f32 = malloc((size_t)N_HEADS * QJL_PROJECTION_DIM * sizeof(float));
    g_q_sketch_i8  = malloc((size_t)N_HEADS * sizeof(qjl_i8_sketch_256));
    g_k_qjl        = malloc((size_t)N_KV_HEADS * ntok * sizeof(qjl_block_qjl1_256));
    g_qjl_scores   = malloc((size_t)N_HEADS * ntok * sizeof(float));
    g_k_polar      = malloc((size_t)nrows * sizeof(block_q4_polar));
    g_q_preht      = malloc((size_t)QK_POLAR * sizeof(float));
    g_polar_scores = malloc((size_t)nrows * sizeof(float));
    float *proj    = malloc((size_t)QJL_HEAD_DIM * QJL_PROJECTION_DIM * sizeof(float));
    float *keys    = malloc((size_t)N_KV_HEADS * ntok * QJL_HEAD_DIM * sizeof(float));
    float *psrc    = malloc((size_t)nrows * QK_POLAR * sizeof(float));
    if (!g_q_sketch_f32 || !g_q_sketch_i8 || !g_k_qjl || !g_qjl_scores ||
        !g_k_polar || !g_q_preht || !g_polar_scores || !proj || !keys || !psrc) {
        fprintf(stderr, "[cpu_simd_bench] OOM\n"); return 1;
    }

    /* Build valid QJL K cache via the bundled projection + quantizer. */
    qjl_make_projection_mt(proj, QJL_HEAD_DIM, QJL_PROJECTION_DIM, 42ULL);
    for (size_t i = 0; i < (size_t)N_KV_HEADS * ntok * QJL_HEAD_DIM; i++) keys[i] = rnd_n();
    qjl_quantize_rows(keys, proj, g_k_qjl, (size_t)N_KV_HEADS * ntok);
    for (size_t i = 0; i < (size_t)N_HEADS * QJL_PROJECTION_DIM; i++) g_q_sketch_f32[i] = rnd_n();
    qjl_quantize_sketch_i8_ref(g_q_sketch_f32, g_q_sketch_i8, N_HEADS);

    /* Build valid Polar K cache + a pre-Hadamarded query. */
    for (size_t i = 0; i < (size_t)nrows * QK_POLAR; i++) psrc[i] = rnd_n();
    quantize_row_q4_polar_ref(psrc, g_k_polar, (long)nrows * QK_POLAR, /*use_qjl=*/1);
    for (int j = 0; j < QK_POLAR; j++) g_q_preht[j] = rnd_n();
    polar_hadamard_inplace(g_q_preht);
    free(keys); free(psrc); free(proj);

    Bench benches[] = {
        { "qjl_score_i8",       run_qjl_i8,       N_HEADS * ntok },
        { "qjl_score_fp32",     run_qjl_fp32,     N_HEADS * ntok },
        { "polar_preht_dot",    run_polar_preht,  (int)nrows },
    };
    const int NB = (int)(sizeof(benches)/sizeof(benches[0]));

    /* results[kernel][thread_idx] = min us */
    double res[3][16];

    printf("\n%-18s |", "kernel \\ threads");
    for (int t = 0; t < nthreads; t++) printf(" %10d", threads[t]);
    printf("   %12s\n", "ns/out (T=1)");
    for (int i = 0; i < 18 + 3; i++) putchar('-');
    for (int t = 0; t < nthreads; t++) printf("+-----------");
    printf("+-------------\n");

    for (int b = 0; b < NB; b++) {
        for (int ti = 0; ti < nthreads; ti++) {
            int T = threads[ti];
            for (int w = 0; w < warmup; w++) (void)benches[b].fn(T);
            double samp[64];
            int R = runs > 64 ? 64 : runs;
            for (int r = 0; r < R; r++) samp[r] = benches[b].fn(T);
            double mn = samp[0]; for (int r = 1; r < R; r++) if (samp[r] < mn) mn = samp[r];
            (void)median_d(samp, R);
            res[b][ti] = mn;
        }
        printf("%-18s |", benches[b].name);
        for (int ti = 0; ti < nthreads; ti++) printf(" %10.1f", res[b][ti]);
        printf("   %12.2f\n", res[b][0] * 1e3 / (double)benches[b].n_out);
    }
    printf("(values are min us over %d runs; lower is better)\n", runs);

    if (out_path) {
        FILE *fp = fopen(out_path, "w");
        if (fp) {
            fprintf(fp, "{\n");
            fprintf(fp, "  \"backend\": \"%s\",\n", bench_backend_name());
            fprintf(fp, "  \"qjl_active_simd\": \"%s\",\n", qjl_active_simd());
            fprintf(fp, "  \"polarquant_active_simd\": \"%s\",\n", polarquant_active_simd());
            fprintf(fp, "  \"workload\": { \"n_heads\": %d, \"n_kv_heads\": %d, \"n_tokens\": %d, \"polar_rows\": %ld },\n",
                    N_HEADS, N_KV_HEADS, ntok, nrows);
            fprintf(fp, "  \"runs\": %d, \"warmup\": %d,\n", runs, warmup);
            fprintf(fp, "  \"thread_sweep\": [");
            for (int t = 0; t < nthreads; t++) fprintf(fp, "%s%d", t?",":"", threads[t]);
            fprintf(fp, "],\n  \"kernels\": [\n");
            for (int b = 0; b < NB; b++) {
                fprintf(fp, "    { \"name\": \"%s\", \"n_outputs\": %d, \"min_us_by_threads\": [",
                        benches[b].name, benches[b].n_out);
                for (int t = 0; t < nthreads; t++) fprintf(fp, "%s%.2f", t?",":"", res[b][t]);
                fprintf(fp, "], \"ns_per_out_t1\": %.4f }%s\n",
                        res[b][0]*1e3/(double)benches[b].n_out, b+1==NB?"":",");
            }
            fprintf(fp, "  ]\n}\n");
            fclose(fp);
            fprintf(stderr, "[cpu_simd_bench] wrote %s\n", out_path);
        }
    }
    return 0;
}
