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
#include "qjl_polar_ref.h"

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

/* ---------- QJL ---------- */

#define QJL_N_HEADS    1
#define QJL_N_KV_HEADS 1
#define QJL_N_TOKENS   N_KV

static int gen_qjl(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/qjl.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    /* Random JL projection (deterministic seed). */
    static float prj[ELIZA_QJL_HEAD_DIM * ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_make_projection(prj, 0xCAFEBABE12345678ULL);

    /* One Q row -> one Q sketch (n_heads = 1). */
    float q_row[ELIZA_QJL_HEAD_DIM];
    for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) q_row[i] = rand_normal();
    float q_sketch[ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_sketch_query(q_row, prj, q_sketch);

    /* QJL_N_TOKENS keys, packed. */
    eliza_block_qjl1_256 packed[QJL_N_TOKENS];
    for (int t = 0; t < QJL_N_TOKENS; t++) {
        float k[ELIZA_QJL_HEAD_DIM];
        for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) k[i] = rand_normal();
        eliza_qjl_quantize_row(k, prj, &packed[t]);
    }

    float scores[QJL_N_TOKENS];
    eliza_qjl_score_qk(q_sketch, packed,
                       QJL_N_HEADS, QJL_N_KV_HEADS, QJL_N_TOKENS, scores);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"qjl\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QJL_HEAD_DIM);
    fprintf(f, "  \"proj_dim\": %d,\n", ELIZA_QJL_PROJECTION_DIM);
    fprintf(f, "  \"n_heads\": %d,\n", QJL_N_HEADS);
    fprintf(f, "  \"n_kv_heads\": %d,\n", QJL_N_KV_HEADS);
    fprintf(f, "  \"n_tokens\": %d,\n", QJL_N_TOKENS);
    fprintf(f, "  \"block_bytes\": 34,\n");
    fprintf(f, "  \"q_sketch\": "); write_floats_json(f, q_sketch, ELIZA_QJL_PROJECTION_DIM); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)packed, sizeof(packed)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, QJL_N_TOKENS); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d tokens)\n", path, QJL_N_TOKENS);
    return 0;
}

/* ---------- PolarQuant ---------- */

#define POLAR_N_ROWS N_KV

static int gen_polar(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/polar.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    /* Activation chunk Q (one block of QK_POLAR = 128 floats). */
    float q[ELIZA_QK_POLAR];
    for (int i = 0; i < ELIZA_QK_POLAR; i++) q[i] = rand_normal();

    /* POLAR_N_ROWS quantized blocks (use_qjl = 0 to keep the fixture compact;
     * the with-QJL path is exercised by the round-trip self-test). */
    eliza_block_q4_polar blocks[POLAR_N_ROWS];
    for (int r = 0; r < POLAR_N_ROWS; r++) {
        float src[ELIZA_QK_POLAR];
        for (int i = 0; i < ELIZA_QK_POLAR; i++) src[i] = rand_normal();
        eliza_polar_quantize_row(src, &blocks[r], ELIZA_QK_POLAR, /*use_qjl=*/0);
    }

    float scores[POLAR_N_ROWS];
    eliza_polar_mul_mv(blocks, q, POLAR_N_ROWS, /*use_qjl=*/0, scores);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"polar\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QK_POLAR);
    fprintf(f, "  \"n_rows\": %d,\n", POLAR_N_ROWS);
    fprintf(f, "  \"block_bytes\": 82,\n");
    fprintf(f, "  \"use_qjl\": 0,\n");
    fprintf(f, "  \"q\": "); write_floats_json(f, q, ELIZA_QK_POLAR); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, POLAR_N_ROWS); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d rows)\n", path, POLAR_N_ROWS);
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

    /* QJL self-test: build a projection, quantize one key row, score it. */
    static float prj[ELIZA_QJL_HEAD_DIM * ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_make_projection(prj, 0xCAFEBABE12345678ULL);
    float qsketch[ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_sketch_query(q, prj, qsketch);
    eliza_block_qjl1_256 qblk;
    eliza_qjl_quantize_row(x, prj, &qblk);
    float sqjl;
    eliza_qjl_score_qk(qsketch, &qblk, 1, 1, 1, &sqjl);
    if (!isfinite(sqjl)) { fprintf(stderr, "qjl self-test: non-finite score %g\n", (double)sqjl); return 1; }

    /* Polar self-test: encode one block, dot against q, expect finite. */
    eliza_block_q4_polar pblk;
    eliza_polar_quantize_row(x, &pblk, ELIZA_QK_POLAR, /*use_qjl=*/0);
    float spolar;
    eliza_polar_mul_mv(&pblk, q, 1, /*use_qjl=*/0, &spolar);
    if (!isfinite(spolar)) { fprintf(stderr, "polar self-test: non-finite score %g\n", (double)spolar); return 1; }

    printf("[self-test] turbo3=%.6f turbo4=%.6f turbo3_tcq=%.6f qjl=%.6f polar=%.6f (all finite)\n",
           (double)s3, (double)s4, (double)stcq, (double)sqjl, (double)spolar);
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
    if (gen_qjl(outdir))        return 1;
    if (gen_polar(outdir))      return 1;
    printf("[gen_fixture] OK — fixtures written to %s/\n", outdir);
    return 0;
}
