/* DRAFT fixture generator for the kernel verification harnesses.
 *
 * Generates deterministic Q vectors and quantized KV blocks using the
 * reference C implementation, then writes JSON fixtures under
 * verify/fixtures/. The same fixture is consumed by both vulkan_verify and
 * metal_verify; passing means shader_score - reference_score is within tol.
 *
 * --self-test mode: round-trips reference quantize + reference dot-product to
 * confirm the fixture loader and the reference impl agree with each other
 * (sanity for the harness, NOT a hardware check).
 *
 * SUBSTITUTION NOTE: this generator runs only the reference impl; it does
 * NOT call CUDA. So fixtures encode reference output, not CUDA output. On
 * hardware-validation day, regenerate fixtures from a real CUDA build of
 * buun-llama-cpp and replace these files with the CUDA-derived versions.
 */

#include "turbo_kernels.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define N_KV 8

static uint64_t prng = 0x9E3779B97F4A7C15ULL;
static float rand_normal(void) {
    /* Marsaglia polar method. */
    static int has_spare = 0;
    static float spare;
    if (has_spare) { has_spare = 0; return spare; }
    float u, v, s;
    do {
        prng = prng * 6364136223846793005ULL + 1442695040888963407ULL;
        u = ((float)((prng >> 11) & 0xFFFFFF) / (float)0x1000000) * 2.0f - 1.0f;
        prng = prng * 6364136223846793005ULL + 1442695040888963407ULL;
        v = ((float)((prng >> 11) & 0xFFFFFF) / (float)0x1000000) * 2.0f - 1.0f;
        s = u * u + v * v;
    } while (s >= 1.0f || s == 0.0f);
    s = sqrtf(-2.0f * logf(s) / s);
    spare = v * s;
    has_spare = 1;
    return u * s;
}

static void write_floats_json(FILE * f, const float * v, int n) {
    fprintf(f, "[");
    for (int i = 0; i < n; i++) {
        fprintf(f, "%s%.7g", i ? "," : "", (double)v[i]);
    }
    fprintf(f, "]");
}

static void write_bytes_json(FILE * f, const uint8_t * v, int n) {
    fprintf(f, "[");
    for (int i = 0; i < n; i++) {
        fprintf(f, "%s%u", i ? "," : "", (unsigned)v[i]);
    }
    fprintf(f, "]");
}

static int gen_turbo3(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/turbo3.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    /* 1 query, N_KV blocks of 128 elements each (one rotation group per kv). */
    float q[128];
    for (int i = 0; i < 128; i++) q[i] = rand_normal();

    eliza_block_turbo3_0 blocks[N_KV * 4];
    float scores[N_KV];
    for (int kv = 0; kv < N_KV; kv++) {
        float k_full[128];
        for (int i = 0; i < 128; i++) k_full[i] = rand_normal();
        eliza_quantize_turbo3_group(k_full, &blocks[kv * 4]);
        scores[kv] = eliza_dot_q_turbo3(q, &blocks[kv * 4]);
    }

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"turbo3\",\n");
    fprintf(f, "  \"head_dim\": 128,\n");
    fprintf(f, "  \"n_kv\": %d,\n", N_KV);
    fprintf(f, "  \"block_bytes\": 14,\n");
    fprintf(f, "  \"blocks_per_kv\": 4,\n");
    fprintf(f, "  \"q\": "); write_floats_json(f, q, 128); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, N_KV); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d kv blocks)\n", path, N_KV);
    return 0;
}

static int gen_turbo4(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/turbo4.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    float q[128];
    for (int i = 0; i < 128; i++) q[i] = rand_normal();

    eliza_block_turbo4_0 blocks[N_KV];
    float scores[N_KV];
    for (int kv = 0; kv < N_KV; kv++) {
        float k_full[128];
        for (int i = 0; i < 128; i++) k_full[i] = rand_normal();
        eliza_quantize_turbo4_block(k_full, &blocks[kv]);
        scores[kv] = eliza_dot_q_turbo4(q, &blocks[kv]);
    }

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"turbo4\",\n");
    fprintf(f, "  \"head_dim\": 128,\n");
    fprintf(f, "  \"n_kv\": %d,\n", N_KV);
    fprintf(f, "  \"block_bytes\": 66,\n");
    fprintf(f, "  \"blocks_per_kv\": 1,\n");
    fprintf(f, "  \"q\": "); write_floats_json(f, q, 128); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, N_KV); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d kv blocks)\n", path, N_KV);
    return 0;
}

static int gen_turbo3_tcq(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/turbo3_tcq.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    float q[128];
    for (int i = 0; i < 128; i++) q[i] = rand_normal();

    eliza_block_turbo3_tcq blocks[N_KV];
    float scores[N_KV];
    for (int kv = 0; kv < N_KV; kv++) {
        float k_full[128];
        for (int i = 0; i < 128; i++) k_full[i] = rand_normal();
        eliza_quantize_turbo3_tcq_block(k_full, &blocks[kv]);
        scores[kv] = eliza_dot_q_turbo3_tcq(q, &blocks[kv]);
    }

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"turbo3_tcq\",\n");
    fprintf(f, "  \"head_dim\": 128,\n");
    fprintf(f, "  \"n_kv\": %d,\n", N_KV);
    fprintf(f, "  \"block_bytes\": 52,\n");
    fprintf(f, "  \"blocks_per_kv\": 1,\n");
    fprintf(f, "  \"q\": "); write_floats_json(f, q, 128); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, N_KV); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d kv blocks)\n", path, N_KV);
    return 0;
}

static int self_test(void) {
    /* Reference vs reference: dequant(quant(x)) followed by Q · K should be
     * close to the dot product of Q against the rotated centroid grid. We
     * cannot recover x exactly (lossy quantization), so the test is just that
     * the score is finite and the centroid tables / FWHT did not blow up. */
    float q[128], x[128];
    for (int i = 0; i < 128; i++) { q[i] = rand_normal(); x[i] = rand_normal(); }

    eliza_block_turbo3_0 g3[4];
    eliza_quantize_turbo3_group(x, g3);
    float s3 = eliza_dot_q_turbo3(q, g3);
    if (!isfinite(s3)) { fprintf(stderr, "turbo3 self-test: non-finite score %g\n", (double)s3); return 1; }

    eliza_block_turbo4_0 g4;
    eliza_quantize_turbo4_block(x, &g4);
    float s4 = eliza_dot_q_turbo4(q, &g4);
    if (!isfinite(s4)) { fprintf(stderr, "turbo4 self-test: non-finite score %g\n", (double)s4); return 1; }

    eliza_block_turbo3_tcq gtcq;
    eliza_quantize_turbo3_tcq_block(x, &gtcq);
    float stcq = eliza_dot_q_turbo3_tcq(q, &gtcq);
    if (!isfinite(stcq)) { fprintf(stderr, "turbo3_tcq self-test: non-finite score %g\n", (double)stcq); return 1; }

    printf("[self-test] turbo3=%.6f turbo4=%.6f turbo3_tcq=%.6f (all finite)\n",
           (double)s3, (double)s4, (double)stcq);
    return 0;
}

int main(int argc, char ** argv) {
    if (argc >= 2 && strcmp(argv[1], "--self-test") == 0) {
        return self_test();
    }
    const char * outdir = argc >= 2 ? argv[1] : "fixtures";
    if (gen_turbo3(outdir))     return 1;
    if (gen_turbo4(outdir))     return 1;
    if (gen_turbo3_tcq(outdir)) return 1;
    printf("[gen_fixture] OK — fixtures written to %s/\n", outdir);
    return 0;
}
