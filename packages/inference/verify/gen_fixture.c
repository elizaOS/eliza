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

    eliza_block_turbo4_0 blocks[N_KV * 4];
    float scores[N_KV];
    for (int kv = 0; kv < N_KV; kv++) {
        float k_full[128];
        for (int i = 0; i < 128; i++) k_full[i] = rand_normal();
        eliza_quantize_turbo4_block(k_full, &blocks[kv * 4]);
        scores[kv] = eliza_dot_q_turbo4(q, &blocks[kv * 4]);
    }

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"turbo4\",\n");
    fprintf(f, "  \"head_dim\": 128,\n");
    fprintf(f, "  \"n_kv\": %d,\n", N_KV);
    fprintf(f, "  \"block_bytes\": 18,\n");
    fprintf(f, "  \"blocks_per_kv\": 4,\n");
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

    /* POLAR_N_ROWS quantized blocks (use_qjl = 0 baseline fixture). */
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

static int gen_polar_qjl(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/polar_qjl.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    float q[ELIZA_QK_POLAR];
    for (int i = 0; i < ELIZA_QK_POLAR; i++) q[i] = rand_normal();

    eliza_block_q4_polar blocks[POLAR_N_ROWS];
    for (int r = 0; r < POLAR_N_ROWS; r++) {
        float src[ELIZA_QK_POLAR];
        for (int i = 0; i < ELIZA_QK_POLAR; i++) src[i] = rand_normal();
        eliza_polar_quantize_row(src, &blocks[r], ELIZA_QK_POLAR, /*use_qjl=*/1);
    }

    float scores[POLAR_N_ROWS];
    eliza_polar_mul_mv(blocks, q, POLAR_N_ROWS, /*use_qjl=*/1, scores);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"polar\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QK_POLAR);
    fprintf(f, "  \"n_rows\": %d,\n", POLAR_N_ROWS);
    fprintf(f, "  \"block_bytes\": 82,\n");
    fprintf(f, "  \"use_qjl\": 1,\n");
    fprintf(f, "  \"q\": "); write_floats_json(f, q, ELIZA_QK_POLAR); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": "); write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": "); write_floats_json(f, scores, POLAR_N_ROWS); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d rows, use_qjl=1)\n", path, POLAR_N_ROWS);
    return 0;
}

/* ---------- Fused attention (GGML_OP_FUSED_ATTN_QJL_TBQ + Polar V) ---------- */

/* Representative cases. head_dim is always 128; n_kv stands in for the 4k /
 * 32k / 128k / 256k context regimes (the math is identical, only the loop
 * trip count changes — fixtures stay small). Each case carries its own GQA
 * head config so the ports exercise both no-fanout and grouped layouts. */
typedef struct { int n_heads, n_kv_heads, n_kv; } fused_case;
static const fused_case FUSED_CASES[] = {
    { 1, 1,   64 },   /* "4k regime" stand-in, no GQA fanout */
    { 4, 2,  512 },   /* "32k regime" stand-in, gqa = 2     */
    { 8, 2,  256 },   /* "128k regime" stand-in, gqa = 4    */
    { 2, 1,  128 },   /* "256k regime" stand-in, gqa = 2    */
};
#define FUSED_N_CASES ((int)(sizeof(FUSED_CASES) / sizeof(FUSED_CASES[0])))
/* sm_scale = 1/sqrt(head_dim) for head_dim = 128. */
#define FUSED_SM_SCALE 0.08838834764831845f

static void gen_fused_q_and_k(int n_heads, int n_kv_heads, int n_kv,
                              const float * prj,
                              float * q_sketch /* [proj, n_heads] */,
                              eliza_block_qjl1_256 * pk /* [n_kv, n_kv_heads] */) {
    for (int h = 0; h < n_heads; h++) {
        float q_row[ELIZA_QJL_HEAD_DIM];
        for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) q_row[i] = rand_normal();
        eliza_qjl_sketch_query(q_row, prj, q_sketch + (size_t)h * ELIZA_QJL_PROJECTION_DIM);
    }
    for (int hk = 0; hk < n_kv_heads; hk++) {
        for (int t = 0; t < n_kv; t++) {
            float k[ELIZA_QJL_HEAD_DIM];
            for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) k[i] = rand_normal();
            eliza_qjl_quantize_row(k, prj, pk + (size_t)hk * n_kv + t);
        }
    }
}

static int gen_fused_attn_qjl_tbq(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/fused_attn_qjl_tbq.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    static float prj[ELIZA_QJL_HEAD_DIM * ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_make_projection(prj, 0xF00DCAFEBABE1234ULL);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"fused_attn_qjl_tbq\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QJL_HEAD_DIM);
    fprintf(f, "  \"proj_dim\": %d,\n", ELIZA_QJL_PROJECTION_DIM);
    fprintf(f, "  \"k_block_bytes\": 34,\n");
    fprintf(f, "  \"v_block_bytes\": 14,\n");
    fprintf(f, "  \"v_blocks_per_token\": %d,\n", ELIZA_FUSED_TBQ_PER_TOKEN);
    fprintf(f, "  \"sm_scale\": %.9g,\n", (double)FUSED_SM_SCALE);
    fprintf(f, "  \"q_is_pre_projected\": 1,\n");
    fprintf(f, "  \"cases\": [\n");
    for (int ci = 0; ci < FUSED_N_CASES; ci++) {
        const fused_case c = FUSED_CASES[ci];
        float * q_sketch = malloc((size_t)c.n_heads * ELIZA_QJL_PROJECTION_DIM * sizeof(float));
        eliza_block_qjl1_256 * pk = malloc((size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_qjl1_256));
        size_t nv = (size_t)c.n_kv_heads * c.n_kv * ELIZA_FUSED_TBQ_PER_TOKEN;
        eliza_block_tbq3_0 * pv = malloc(nv * sizeof(eliza_block_tbq3_0));
        float * out = malloc((size_t)c.n_heads * ELIZA_FUSED_HEAD_DIM * sizeof(float));
        if (!q_sketch || !pk || !pv || !out) { perror("malloc"); fclose(f); return 1; }

        gen_fused_q_and_k(c.n_heads, c.n_kv_heads, c.n_kv, prj, q_sketch, pk);
        for (int hk = 0; hk < c.n_kv_heads; hk++) {
            for (int t = 0; t < c.n_kv; t++) {
                for (int cc = 0; cc < ELIZA_FUSED_TBQ_PER_TOKEN; cc++) {
                    float v32[32];
                    for (int i = 0; i < 32; i++) v32[i] = rand_normal();
                    eliza_quantize_tbq3_block(v32,
                        pv + ((size_t)hk * c.n_kv + t) * ELIZA_FUSED_TBQ_PER_TOKEN + cc);
                }
            }
        }
        eliza_fused_attn_qjl_tbq3(q_sketch, pk, pv, c.n_heads, c.n_kv_heads, c.n_kv,
                                  FUSED_SM_SCALE, out);

        fprintf(f, "    {\n");
        fprintf(f, "      \"n_heads\": %d, \"n_kv_heads\": %d, \"n_kv\": %d,\n",
                c.n_heads, c.n_kv_heads, c.n_kv);
        fprintf(f, "      \"q_sketch\": ");
        write_floats_json(f, q_sketch, c.n_heads * ELIZA_QJL_PROJECTION_DIM);
        fprintf(f, ",\n");
        fprintf(f, "      \"k_blocks\": ");
        write_bytes_json(f, (uint8_t *)pk, (size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_qjl1_256));
        fprintf(f, ",\n");
        fprintf(f, "      \"v_blocks\": ");
        write_bytes_json(f, (uint8_t *)pv, nv * sizeof(eliza_block_tbq3_0));
        fprintf(f, ",\n");
        fprintf(f, "      \"expected_out\": ");
        write_floats_json(f, out, c.n_heads * ELIZA_FUSED_HEAD_DIM);
        fprintf(f, "\n    }%s\n", ci + 1 < FUSED_N_CASES ? "," : "");
        free(q_sketch); free(pk); free(pv); free(out);
    }
    fprintf(f, "  ]\n}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d cases)\n", path, FUSED_N_CASES);
    return 0;
}

static int gen_fused_attn_qjl_polar(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/fused_attn_qjl_polar.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    static float prj[ELIZA_QJL_HEAD_DIM * ELIZA_QJL_PROJECTION_DIM];
    eliza_qjl_make_projection(prj, 0xF00DCAFEBABE1234ULL);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"fused_attn_qjl_polar\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QJL_HEAD_DIM);
    fprintf(f, "  \"proj_dim\": %d,\n", ELIZA_QJL_PROJECTION_DIM);
    fprintf(f, "  \"k_block_bytes\": 34,\n");
    fprintf(f, "  \"v_block_bytes\": 82,\n");
    fprintf(f, "  \"v_blocks_per_token\": 1,\n");
    fprintf(f, "  \"use_qjl\": 1,\n");
    fprintf(f, "  \"sm_scale\": %.9g,\n", (double)FUSED_SM_SCALE);
    fprintf(f, "  \"q_is_pre_projected\": 1,\n");
    fprintf(f, "  \"cases\": [\n");
    for (int ci = 0; ci < FUSED_N_CASES; ci++) {
        const fused_case c = FUSED_CASES[ci];
        float * q_sketch = malloc((size_t)c.n_heads * ELIZA_QJL_PROJECTION_DIM * sizeof(float));
        eliza_block_qjl1_256 * pk = malloc((size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_qjl1_256));
        eliza_block_q4_polar * pv = malloc((size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_q4_polar));
        float * out = malloc((size_t)c.n_heads * ELIZA_FUSED_HEAD_DIM * sizeof(float));
        if (!q_sketch || !pk || !pv || !out) { perror("malloc"); fclose(f); return 1; }

        gen_fused_q_and_k(c.n_heads, c.n_kv_heads, c.n_kv, prj, q_sketch, pk);
        for (int hk = 0; hk < c.n_kv_heads; hk++) {
            for (int t = 0; t < c.n_kv; t++) {
                float v[ELIZA_QK_POLAR];
                for (int i = 0; i < ELIZA_QK_POLAR; i++) v[i] = rand_normal();
                eliza_polar_quantize_row(v, pv + (size_t)hk * c.n_kv + t, ELIZA_QK_POLAR, /*use_qjl=*/1);
            }
        }
        eliza_fused_attn_qjl_polar(q_sketch, pk, pv, c.n_heads, c.n_kv_heads, c.n_kv,
                                   FUSED_SM_SCALE, /*use_qjl=*/1, out);

        fprintf(f, "    {\n");
        fprintf(f, "      \"n_heads\": %d, \"n_kv_heads\": %d, \"n_kv\": %d,\n",
                c.n_heads, c.n_kv_heads, c.n_kv);
        fprintf(f, "      \"q_sketch\": ");
        write_floats_json(f, q_sketch, c.n_heads * ELIZA_QJL_PROJECTION_DIM);
        fprintf(f, ",\n");
        fprintf(f, "      \"k_blocks\": ");
        write_bytes_json(f, (uint8_t *)pk, (size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_qjl1_256));
        fprintf(f, ",\n");
        fprintf(f, "      \"v_blocks\": ");
        write_bytes_json(f, (uint8_t *)pv, (size_t)c.n_kv_heads * c.n_kv * sizeof(eliza_block_q4_polar));
        fprintf(f, ",\n");
        fprintf(f, "      \"expected_out\": ");
        write_floats_json(f, out, c.n_heads * ELIZA_FUSED_HEAD_DIM);
        fprintf(f, "\n    }%s\n", ci + 1 < FUSED_N_CASES ? "," : "");
        free(q_sketch); free(pk); free(pv); free(out);
    }
    fprintf(f, "  ]\n}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d cases)\n", path, FUSED_N_CASES);
    return 0;
}

/* ---------- Polar pre-Hadamard query path (dot(H·x, q) == dot(x, H·q)) ---------- */

static int gen_polar_preht(const char * outdir) {
    char path[512];
    snprintf(path, sizeof(path), "%s/polar_preht.json", outdir);
    FILE * f = fopen(path, "w");
    if (!f) { perror(path); return 1; }

    /* The `*_preht` shader variants apply the 128-element Walsh-Hadamard
     * butterfly to the QUERY host-side and dot it against the *rotated*
     * (pre-uncondition) Polar block, exploiting H^T = H so
     *   <dequant(K), q> == <rotated_decode(K), H·q / QK_POLAR>.
     * This fixture stores both q and H·q so a port can verify it consumes
     * the right one given its manifest `q_is_pre_hadamarded` bit. The
     * expected scores are identical to fixtures/polar.json / polar_qjl.json
     * (same RNG seed sequence not guaranteed — these are independent draws,
     * but parity holds within tolerance). */
    float q[ELIZA_QK_POLAR];
    for (int i = 0; i < ELIZA_QK_POLAR; i++) q[i] = rand_normal();
    float hq[ELIZA_QK_POLAR];
    for (int i = 0; i < ELIZA_QK_POLAR; i++) hq[i] = q[i];
    eliza_polar_hadamard_inplace(hq);   /* hq = H·q (unnormalised butterfly) */

    eliza_block_q4_polar blocks[N_KV], blocks_qjl[N_KV];
    for (int r = 0; r < N_KV; r++) {
        float src[ELIZA_QK_POLAR];
        for (int i = 0; i < ELIZA_QK_POLAR; i++) src[i] = rand_normal();
        eliza_polar_quantize_row(src, &blocks[r],     ELIZA_QK_POLAR, /*use_qjl=*/0);
        eliza_polar_quantize_row(src, &blocks_qjl[r], ELIZA_QK_POLAR, /*use_qjl=*/1);
    }
    float scores[N_KV], scores_qjl[N_KV];
    eliza_polar_mul_mv(blocks,     q, N_KV, /*use_qjl=*/0, scores);
    eliza_polar_mul_mv(blocks_qjl, q, N_KV, /*use_qjl=*/1, scores_qjl);

    fprintf(f, "{\n");
    fprintf(f, "  \"kernel\": \"polar_preht\",\n");
    fprintf(f, "  \"head_dim\": %d,\n", ELIZA_QK_POLAR);
    fprintf(f, "  \"n_rows\": %d,\n", N_KV);
    fprintf(f, "  \"block_bytes\": 82,\n");
    fprintf(f, "  \"hadamard_inv_scale\": %.9g,\n", 1.0 / (double)ELIZA_QK_POLAR);
    fprintf(f, "  \"q\": ");          write_floats_json(f, q,  ELIZA_QK_POLAR);   fprintf(f, ",\n");
    fprintf(f, "  \"hq\": ");         write_floats_json(f, hq, ELIZA_QK_POLAR);   fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks\": ");     write_bytes_json(f, (uint8_t *)blocks, sizeof(blocks)); fprintf(f, ",\n");
    fprintf(f, "  \"k_blocks_qjl\": "); write_bytes_json(f, (uint8_t *)blocks_qjl, sizeof(blocks_qjl)); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores\": ");     write_floats_json(f, scores,     N_KV); fprintf(f, ",\n");
    fprintf(f, "  \"expected_scores_qjl\": "); write_floats_json(f, scores_qjl, N_KV); fprintf(f, "\n");
    fprintf(f, "}\n");
    fclose(f);
    printf("[gen_fixture] wrote %s (%d rows)\n", path, N_KV);
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

    eliza_block_turbo4_0 g4[4];
    eliza_quantize_turbo4_block(x, g4);
    float s4 = eliza_dot_q_turbo4(q, g4);
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

    /* QJL parity: score_qk and mul_mv must return the same scalar when
     * n_heads = n_kv_heads = n_tokens = 1 (no GQA fanout). The two paths
     * are intended to be equivalent up to that boundary. */
    float sqjl_mv;
    eliza_qjl_mul_mv(&qblk, qsketch, 1, &sqjl_mv);
    if (fabsf(sqjl - sqjl_mv) > 1e-5f) {
        fprintf(stderr, "qjl parity: score_qk=%g vs mul_mv=%g (diff=%g)\n",
                (double)sqjl, (double)sqjl_mv, (double)fabsf(sqjl - sqjl_mv));
        return 1;
    }

    /* Polar self-test: encode one block, dot against q, expect finite. */
    eliza_block_q4_polar pblk;
    eliza_polar_quantize_row(x, &pblk, ELIZA_QK_POLAR, /*use_qjl=*/0);
    float spolar;
    eliza_polar_mul_mv(&pblk, q, 1, /*use_qjl=*/0, &spolar);
    if (!isfinite(spolar)) { fprintf(stderr, "polar self-test: non-finite score %g\n", (double)spolar); return 1; }

    /* Polar parity: dequantize_row + manual dot should match mul_mv to fp32
     * round-off. Catches any drift between the two paths the Metal shaders
     * mirror (kernel_get_rows_q4_polar vs kernel_mul_mv_q4_polar_f32). */
    float pdec[ELIZA_QK_POLAR];
    eliza_polar_dequantize_row(&pblk, pdec, ELIZA_QK_POLAR, /*use_qjl=*/0);
    double spolar_manual = 0.0;
    for (int i = 0; i < ELIZA_QK_POLAR; i++) spolar_manual += (double)pdec[i] * (double)q[i];
    if (fabs((double)spolar - spolar_manual) > 1e-3) {
        fprintf(stderr, "polar parity: mul_mv=%g vs dequant·q=%g (diff=%g)\n",
                (double)spolar, spolar_manual, fabs((double)spolar - spolar_manual));
        return 1;
    }

    eliza_block_q4_polar pblk_qjl;
    eliza_polar_quantize_row(x, &pblk_qjl, ELIZA_QK_POLAR, /*use_qjl=*/1);
    float spolar_qjl;
    eliza_polar_mul_mv(&pblk_qjl, q, 1, /*use_qjl=*/1, &spolar_qjl);
    if (!isfinite(spolar_qjl)) { fprintf(stderr, "polar+qjl self-test: non-finite score %g\n", (double)spolar_qjl); return 1; }
    float pdec_qjl[ELIZA_QK_POLAR];
    eliza_polar_dequantize_row(&pblk_qjl, pdec_qjl, ELIZA_QK_POLAR, /*use_qjl=*/1);
    double spolar_qjl_manual = 0.0;
    for (int i = 0; i < ELIZA_QK_POLAR; i++) spolar_qjl_manual += (double)pdec_qjl[i] * (double)q[i];
    if (fabs((double)spolar_qjl - spolar_qjl_manual) > 1e-3) {
        fprintf(stderr, "polar+qjl parity: mul_mv=%g vs dequant·q=%g (diff=%g)\n",
                (double)spolar_qjl, spolar_qjl_manual, fabs((double)spolar_qjl - spolar_qjl_manual));
        return 1;
    }

    /* TBQ V-cache round-trip: encode/decode one tbq3_0 and one tbq4_0 block
     * (the fork-exact V-cache decode path used by the fused-attn op). The
     * decoded vector must be finite and roughly preserve the input scale. */
    {
        float v32[32];
        for (int i = 0; i < 32; i++) v32[i] = x[i];
        eliza_block_tbq3_0 vb3; eliza_quantize_tbq3_block(v32, &vb3);
        eliza_block_tbq4_0 vb4; eliza_quantize_tbq4_block(v32, &vb4);
        float d3[32], d4[32];
        eliza_tbq3_decode_block_uncond(&vb3, d3);
        eliza_tbq4_decode_block_uncond(&vb4, d4);
        for (int i = 0; i < 32; i++) {
            if (!isfinite(d3[i]) || !isfinite(d4[i])) {
                fprintf(stderr, "tbq decode self-test: non-finite at %d\n", i); return 1;
            }
        }
    }

    /* Fused-attention parity: the fused output must equal the unfused
     * pipeline (QJL score -> softmax -> per-token V decode -> weighted mix)
     * computed independently from the same inputs. Tolerance 1e-3 (the
     * softmax-then-mix path accumulates fp32 round-off). Exercised for the
     * TBQ3 V-cache; the Polar variant differs only in the V decode. */
    {
        const int nh = 4, nkv_h = 2, nkv = 24;
        const int gqa = nh / nkv_h;
        float q_sketch[4 * ELIZA_QJL_PROJECTION_DIM];
        for (int h = 0; h < nh; h++) {
            float qr[ELIZA_QJL_HEAD_DIM];
            for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) qr[i] = rand_normal();
            eliza_qjl_sketch_query(qr, prj, q_sketch + h * ELIZA_QJL_PROJECTION_DIM);
        }
        eliza_block_qjl1_256 pk[2 * 24];
        for (int hk = 0; hk < nkv_h; hk++)
            for (int t = 0; t < nkv; t++) {
                float k[ELIZA_QJL_HEAD_DIM];
                for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) k[i] = rand_normal();
                eliza_qjl_quantize_row(k, prj, &pk[hk * nkv + t]);
            }
        eliza_block_tbq3_0 pv[2 * 24 * 4];
        for (int hk = 0; hk < nkv_h; hk++)
            for (int t = 0; t < nkv; t++)
                for (int c = 0; c < 4; c++) {
                    float v32[32];
                    for (int i = 0; i < 32; i++) v32[i] = rand_normal();
                    eliza_quantize_tbq3_block(v32, &pv[(hk * nkv + t) * 4 + c]);
                }
        float out_fused[4 * 128];
        eliza_fused_attn_qjl_tbq3(q_sketch, pk, pv, nh, nkv_h, nkv,
                                  0.08838834764831845f, out_fused);

        /* Unfused reference recompute. */
        float scores[4 * 24];
        eliza_qjl_score_qk(q_sketch, pk, nh, nkv_h, nkv, scores);
        float maxdiff = 0.0f;
        for (int hq = 0; hq < nh; hq++) {
            int hk = hq / gqa;
            float raw[24], w[24];
            float m = -INFINITY;
            for (int t = 0; t < nkv; t++) { raw[t] = scores[hq * nkv + t] * 0.08838834764831845f; if (raw[t] > m) m = raw[t]; }
            double l = 0.0;
            for (int t = 0; t < nkv; t++) { w[t] = expf(raw[t] - m); l += w[t]; }
            for (int t = 0; t < nkv; t++) w[t] /= (float)l;
            float ref[128];
            for (int d = 0; d < 128; d++) ref[d] = 0.0f;
            for (int t = 0; t < nkv; t++) {
                for (int c = 0; c < 4; c++) {
                    float dec[32];
                    eliza_tbq3_decode_block_uncond(&pv[(hk * nkv + t) * 4 + c], dec);
                    for (int i = 0; i < 32; i++) ref[c * 32 + i] += w[t] * dec[i];
                }
            }
            for (int d = 0; d < 128; d++) {
                float diff = fabsf(out_fused[hq * 128 + d] - ref[d]);
                if (diff > maxdiff) maxdiff = diff;
            }
        }
        if (!(maxdiff < 1e-3f)) {
            fprintf(stderr, "fused-attn parity: max |fused - unfused| = %g (> 1e-3)\n", (double)maxdiff);
            return 1;
        }
    }

    printf("[self-test] turbo3=%.6f turbo4=%.6f turbo3_tcq=%.6f qjl=%.6f polar=%.6f polar_qjl=%.6f (all finite; fused-attn + tbq V-cache parity OK)\n",
           (double)s3, (double)s4, (double)stcq, (double)sqjl, (double)spolar, (double)spolar_qjl);
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
    if (gen_polar_qjl(outdir))  return 1;
    if (gen_polar_preht(outdir)) return 1;
    if (gen_fused_attn_qjl_tbq(outdir))   return 1;
    if (gen_fused_attn_qjl_polar(outdir)) return 1;
    printf("[gen_fixture] OK — fixtures written to %s/\n", outdir);
    return 0;
}
