/* DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
 *
 * Reference C implementation for QJL and PolarQuant fixture generation.
 * Re-implements the bit-exact CPU reference for both block formats here so
 * the verify/ harness has zero deps on the @elizaos/native-plugins packages
 * (those are owned by W1-A / W1-B and live in a separate package tree).
 *
 * Math correspondences:
 *   eliza_qjl_quantize_row     == qjl_quantize_row_ref (qjl-cpu)
 *   eliza_qjl_score_qk         == qjl_score_qk_ref     (qjl-cpu)
 *   eliza_polar_quantize_row   == quantize_row_q4_polar_ref (polarquant-cpu)
 *   eliza_polar_dequantize_row == dequantize_row_q4_polar_ref (polarquant-cpu)
 *   eliza_polar_qjl_signs      == polar_qjl_signs (polarquant-cpu)
 *   eliza_polar_hadamard_inplace == polar_hadamard_inplace (polarquant-cpu)
 */

#include "qjl_polar_ref.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ---------- bf16 / fp16 helpers ---------- */

uint16_t eliza_fp32_to_bf16(float f) {
    union { float f; uint32_t u; } v = { f };
    uint32_t u = v.u;
    /* Round-to-nearest-even with mantissa width 7. */
    uint32_t lsb     = (u >> 16) & 1u;
    uint32_t bias    = 0x7fffu + lsb;
    uint32_t rounded = u + bias;
    return (uint16_t)(rounded >> 16);
}

float eliza_bf16_to_fp32(uint16_t b) {
    union { uint32_t u; float f; } v = { ((uint32_t)b) << 16 };
    return v.f;
}

static uint16_t fp32_to_fp16_bits(float f) {
    union { float f; uint32_t u; } v = { f };
    uint32_t u = v.u;
    uint32_t sign = (u >> 16) & 0x8000;
    uint32_t exp  = (u >> 23) & 0xff;
    uint32_t mant = u & 0x7fffff;
    if (exp == 0xff) {
        return (uint16_t)(sign | 0x7c00 | (mant ? 0x200 : 0));
    }
    int32_t e = (int32_t)exp - 127 + 15;
    if (e >= 31) return (uint16_t)(sign | 0x7c00);
    if (e <= 0) {
        if (e < -10) return (uint16_t)sign;
        mant |= 0x800000;
        uint32_t shift = (uint32_t)(14 - e);
        uint16_t result = (uint16_t)(sign | (mant >> shift));
        if ((mant >> (shift - 1)) & 1) result++;
        return result;
    }
    uint16_t result = (uint16_t)(sign | (uint32_t)(e << 10) | (mant >> 13));
    if (mant & 0x1000) result++;
    return result;
}

static float fp16_bits_to_fp32(uint16_t h) {
    uint32_t sign = (uint32_t)(h & 0x8000) << 16;
    uint32_t exp  = (h >> 10) & 0x1f;
    uint32_t mant = h & 0x3ff;
    uint32_t u;
    if (exp == 0) {
        if (mant == 0) {
            u = sign;
        } else {
            while (!(mant & 0x400)) { mant <<= 1; exp--; }
            mant &= 0x3ff;
            u = sign | (((uint32_t)(exp + 127 - 15 + 1)) << 23) | (mant << 13);
        }
    } else if (exp == 0x1f) {
        u = sign | 0x7f800000 | (mant << 13);
    } else {
        u = sign | (((uint32_t)(exp + 127 - 15)) << 23) | (mant << 13);
    }
    union { uint32_t u; float f; } v = { u };
    return v.f;
}

/* ---------- QJL ---------- */

/* Splitmix64 -> ranlux-style stream + Box-Muller. Deterministic and
 * platform-independent. NOT bit-identical to torch.randn — the harness
 * keeps Π fixed across runs by seeding both encoder and verifier the same. */
static uint64_t splitmix64(uint64_t * s) {
    *s += 0x9E3779B97F4A7C15ULL;
    uint64_t z = *s;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

static float box_muller(uint64_t * s, float * spare, int * has_spare) {
    if (*has_spare) { *has_spare = 0; return *spare; }
    float u, v, r;
    do {
        u = (float)((splitmix64(s) >> 11) & 0xFFFFFF) / (float)0x1000000 * 2.0f - 1.0f;
        v = (float)((splitmix64(s) >> 11) & 0xFFFFFF) / (float)0x1000000 * 2.0f - 1.0f;
        r = u * u + v * v;
    } while (r >= 1.0f || r == 0.0f);
    r = sqrtf(-2.0f * logf(r) / r);
    *spare = v * r;
    *has_spare = 1;
    return u * r;
}

void eliza_qjl_make_projection(float * prj, uint64_t seed) {
    uint64_t s = seed ? seed : 0x42ULL;
    float spare = 0.0f;
    int has_spare = 0;
    for (int i = 0; i < ELIZA_QJL_HEAD_DIM * ELIZA_QJL_PROJECTION_DIM; i++) {
        prj[i] = box_muller(&s, &spare, &has_spare);
    }
}

void eliza_qjl_quantize_row(const float * key, const float * prj,
                            eliza_block_qjl1_256 * out) {
    /* sketch[j] = sum_i key[i] * prj[i*proj_dim + j]; bit[j] = sketch[j] > 0. */
    float sketch[ELIZA_QJL_PROJECTION_DIM];
    for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
        float acc = 0.0f;
        for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) {
            acc += key[i] * prj[i * ELIZA_QJL_PROJECTION_DIM + j];
        }
        sketch[j] = acc;
    }
    memset(out->qs, 0, sizeof(out->qs));
    for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
        if (sketch[j] > 0.0f) {
            out->qs[j >> 3] |= (uint8_t)(1u << (j & 7));
        }
    }
    /* L2 norm of original key, stored as bf16. */
    double n = 0.0;
    for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) n += (double)key[i] * (double)key[i];
    out->norm_bf16 = eliza_fp32_to_bf16((float)sqrt(n));
}

void eliza_qjl_sketch_query(const float * q_row, const float * prj,
                            float * q_sketch) {
    for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
        float acc = 0.0f;
        for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) {
            acc += q_row[i] * prj[i * ELIZA_QJL_PROJECTION_DIM + j];
        }
        q_sketch[j] = acc;
    }
}

void eliza_qjl_score_qk(const float * q_sketch,
                        const eliza_block_qjl1_256 * packed_k,
                        int n_heads, int n_kv_heads, int n_tokens,
                        float * scores) {
    const float scl_base = 1.2533141373155003f / (float)ELIZA_QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;
    for (int hq = 0; hq < n_heads; hq++) {
        int hk = hq / gqa;
        const float * qs = q_sketch + hq * ELIZA_QJL_PROJECTION_DIM;
        for (int t = 0; t < n_tokens; t++) {
            const eliza_block_qjl1_256 * blk = packed_k + hk * n_tokens + t;
            float norm_k = eliza_bf16_to_fp32(blk->norm_bf16);
            float acc = 0.0f;
            for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
                int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
                acc += (bit ? qs[j] : -qs[j]);
            }
            scores[hq * n_tokens + t] = scl_base * norm_k * acc;
        }
    }
}

void eliza_qjl_mul_mv(const eliza_block_qjl1_256 * k_blocks,
                      const float * q_sketch,
                      int n_rows,
                      float * y) {
    const float scl_base = 1.2533141373155003f / (float)ELIZA_QJL_PROJECTION_DIM;
    for (int r = 0; r < n_rows; r++) {
        const eliza_block_qjl1_256 * blk = k_blocks + r;
        float norm_k = eliza_bf16_to_fp32(blk->norm_bf16);
        float acc = 0.0f;
        for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
            int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
            acc += (bit ? q_sketch[j] : -q_sketch[j]);
        }
        y[r] = scl_base * norm_k * acc;
    }
}

void eliza_qjl_dequantize_row(const eliza_block_qjl1_256 * blk,
                              const float * prj, float * out) {
    const float scl_base = 1.2533141373155003f / (float)ELIZA_QJL_PROJECTION_DIM;
    float norm_k = eliza_bf16_to_fp32(blk->norm_bf16);
    float scale = scl_base * norm_k;
    for (int i = 0; i < ELIZA_QJL_HEAD_DIM; i++) {
        float acc = 0.0f;
        const float * row = prj + i * ELIZA_QJL_PROJECTION_DIM;
        for (int j = 0; j < ELIZA_QJL_PROJECTION_DIM; j++) {
            int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
            acc += bit ? row[j] : -row[j];
        }
        out[i] = scale * acc;
    }
}

/* ---------- PolarQuant ---------- */

/* Bit-identical to POLAR_Q4_CENTROIDS in
 * packages/native-plugins/polarquant-cpu/include/polarquant/polar_centroids.h. */
const float ELIZA_POLAR_Q4_CENTROIDS[16] = {
    -2.754354807f, -2.093562707f, -1.643041510f, -1.279739752f,
    -0.962640978f, -0.672392117f, -0.397897103f, -0.131757782f,
     0.131757782f,  0.397897103f,  0.672392117f,  0.962640978f,
     1.279739752f,  1.643041510f,  2.093562707f,  2.754354807f,
};
const float ELIZA_POLAR_Q4_BOUNDARIES[15] = {
    -2.423958757f, -1.868302108f, -1.461390631f, -1.121190365f,
    -0.817516548f, -0.535144610f, -0.264827443f,  0.000000000f,
     0.264827443f,  0.535144610f,  0.817516548f,  1.121190365f,
     1.461390631f,  1.868302108f,  2.423958757f,
};

void eliza_polar_hadamard_inplace(float * x) {
    for (int h = 1; h < ELIZA_QK_POLAR; h <<= 1) {
        for (int i = 0; i < ELIZA_QK_POLAR; i += (h << 1)) {
            for (int j = i; j < i + h; j++) {
                float a = x[j];
                float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}

void eliza_polar_qjl_signs(float * out) {
    uint32_t state = (uint32_t)ELIZA_POLAR_QJL_SEED;
    if (state == 0u) state = 1u;
    for (int i = 0; i < ELIZA_QK_POLAR; i++) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        out[i] = (state & 1u) ? 1.0f : -1.0f;
    }
}

static uint8_t polar_q4_nearest(float v) {
    /* Binary search through the 15 boundaries. */
    int lo = 0, hi = 15;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        if (v < ELIZA_POLAR_Q4_BOUNDARIES[mid]) hi = mid;
        else lo = mid + 1;
    }
    return (uint8_t)lo;
}

void eliza_polar_quantize_row(const float * x, eliza_block_q4_polar * y,
                              int64_t k, int use_qjl) {
    if (k <= 0 || (k % ELIZA_QK_POLAR) != 0) return;
    int64_t nb = k / ELIZA_QK_POLAR;
    float qjl_signs[ELIZA_QK_POLAR];
    if (use_qjl) eliza_polar_qjl_signs(qjl_signs);

    for (int64_t b = 0; b < nb; b++) {
        const float * src = x + b * ELIZA_QK_POLAR;
        eliza_block_q4_polar * dst = y + b;

        /* Per-block L2 norm. */
        double n2 = 0.0;
        for (int i = 0; i < ELIZA_QK_POLAR; i++) n2 += (double)src[i] * (double)src[i];
        float l2 = (float)sqrt(n2);
        dst->d = fp32_to_fp16_bits(l2);

        /* Normalise + Hadamard rotate (the GGUF converter does this offline,
         * but we re-do it here for round-trip self-test). The decoder undoes
         * via the (1 / QK_POLAR) compensation. */
        float buf[ELIZA_QK_POLAR];
        float inv_l2 = (l2 > 1e-10f) ? (1.0f / l2) : 0.0f;
        for (int i = 0; i < ELIZA_QK_POLAR; i++) buf[i] = src[i] * inv_l2;
        eliza_polar_hadamard_inplace(buf);
        /* The forward butterfly produces sqrt(QK_POLAR) * H_ortho * x; the
         * decoder normalises by the same factor at the end. We don't apply
         * any factor here — encoder and decoder agree on the convention. */

        memset(dst->qs, 0, sizeof(dst->qs));
        memset(dst->qjl, 0, sizeof(dst->qjl));

        /* Quantize to nearest centroid. */
        for (int i = 0; i < ELIZA_QK_POLAR; i += 2) {
            uint8_t a = polar_q4_nearest(buf[i]);
            uint8_t b2 = polar_q4_nearest(buf[i + 1]);
            dst->qs[i / 2] = (uint8_t)((b2 << 4) | (a & 0xF));
        }

        if (use_qjl) {
            /* Compute residual (buf - centroid_recon) and store sign of its
             * inner product with qjl_signs[] in qjl[0] bit 0. Magnitude of
             * the correction is not encoded; decoder uses fixed magnitude. */
            float residual_dot = 0.0f;
            for (int i = 0; i < ELIZA_QK_POLAR; i++) {
                uint8_t idx = (i & 1)
                    ? (uint8_t)(dst->qs[i / 2] >> 4)
                    : (uint8_t)(dst->qs[i / 2] & 0xF);
                float r = buf[i] - ELIZA_POLAR_Q4_CENTROIDS[idx];
                residual_dot += r * qjl_signs[i];
            }
            dst->qjl[0] = (residual_dot > 0.0f) ? 1u : 0u;
        }
    }
}

void eliza_polar_dequantize_row(const eliza_block_q4_polar * x, float * y,
                                int64_t k, int use_qjl) {
    if (k <= 0 || (k % ELIZA_QK_POLAR) != 0) return;
    int64_t nb = k / ELIZA_QK_POLAR;
    float qjl_signs[ELIZA_QK_POLAR];
    if (use_qjl) eliza_polar_qjl_signs(qjl_signs);
    const float inv_d = 1.0f / (float)ELIZA_QK_POLAR;

    for (int64_t b = 0; b < nb; b++) {
        const eliza_block_q4_polar * src = x + b;
        float * dst = y + b * ELIZA_QK_POLAR;
        float l2 = fp16_bits_to_fp32(src->d);

        float buf[ELIZA_QK_POLAR];
        for (int i = 0; i < ELIZA_QK_POLAR / 2; i++) {
            uint8_t byte = src->qs[i];
            buf[2 * i]     = ELIZA_POLAR_Q4_CENTROIDS[byte & 0x0F];
            buf[2 * i + 1] = ELIZA_POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0F];
        }
        if (use_qjl) {
            uint8_t bit = (uint8_t)(src->qjl[0] & 1u);
            float sign  = bit ? 1.0f : -1.0f;
            float mag   = ELIZA_POLAR_QJL_MAGNITUDE / sqrtf((float)ELIZA_QK_POLAR);
            for (int i = 0; i < ELIZA_QK_POLAR; i++) {
                buf[i] += sign * mag * qjl_signs[i];
            }
        }
        eliza_polar_hadamard_inplace(buf);
        for (int i = 0; i < ELIZA_QK_POLAR; i++) buf[i] *= inv_d;
        for (int i = 0; i < ELIZA_QK_POLAR; i++) dst[i] = buf[i] * l2;
    }
}

void eliza_polar_mul_mv(const eliza_block_q4_polar * k_blocks,
                        const float * q,
                        int n_rows, int use_qjl,
                        float * y) {
    float buf[ELIZA_QK_POLAR];
    for (int r = 0; r < n_rows; r++) {
        eliza_polar_dequantize_row(k_blocks + r, buf, ELIZA_QK_POLAR, use_qjl);
        double acc = 0.0;
        for (int i = 0; i < ELIZA_QK_POLAR; i++) {
            acc += (double)buf[i] * (double)q[i];
        }
        y[r] = (float)acc;
    }
}

/* ---------- Fused attention: GGML_OP_FUSED_ATTN_QJL_TBQ + Polar V variant ----------
 *
 * Bit-exact to fused_attn_qjl_tbq_ref in the milady-llama-cpp fork
 * (ggml/src/ggml-cpu/fused-attn-qjl-tbq.c). The score for one (head hq,
 * token t) is the QJL attention score with the canonical paper scale, then
 * scaled by sm_scale:
 *
 *   raw[hq,t] = (sqrt(pi/2) / proj_dim) * ||k_t|| * (sum_j sign_j * q_sketch[hq,j]) * sm_scale
 *
 * Softmax over t (numerically stabilised by the running max), then the V-mix:
 *
 *   out[hq,d] = sum_t softmax_t * dequant_V[hk(hq), t][d]
 *
 * where dequant_V for the TBQ3 variant walks 4 block_tbq3_0 chunks per token
 * (32 elements each), codebook lookup + Hadamard-32 uncondition + ±1 sign
 * flip, and for the Polar variant decodes one block_q4_polar (128 elements)
 * per token. The weights are pre-divided by the softmax denominator so the
 * V-mix accumulator needs no final divide. */

#define FUSED_QJL_SCALE_BASE 1.2533141373155003 /* sqrt(pi/2) */

static void fused_softmax_weights(const float * raw, int n_tokens, float * w_out) {
    /* Returns 1 on success, leaves w_out untouched on degenerate input. */
    float m = -INFINITY;
    for (int t = 0; t < n_tokens; t++) if (raw[t] > m) m = raw[t];
    if (!isfinite(m)) { for (int t = 0; t < n_tokens; t++) w_out[t] = 0.0f; return; }
    double l = 0.0;
    for (int t = 0; t < n_tokens; t++) { float w = expf(raw[t] - m); w_out[t] = w; l += w; }
    const float inv_l = (l > 0.0) ? (float)(1.0 / l) : 0.0f;
    for (int t = 0; t < n_tokens; t++) w_out[t] *= inv_l;
}

static void fused_qjl_scores_one_head(const float * qs,
                                      const eliza_block_qjl1_256 * pk_head,
                                      int n_tokens, float sm_scale,
                                      float * raw_out) {
    const float scl = (float)(FUSED_QJL_SCALE_BASE / (double)ELIZA_FUSED_PROJ_DIM);
    for (int t = 0; t < n_tokens; t++) {
        const eliza_block_qjl1_256 * blk = pk_head + t;
        const float norm_k = eliza_bf16_to_fp32(blk->norm_bf16);
        float acc = 0.0f;
        for (int j = 0; j < ELIZA_FUSED_PROJ_DIM; j++) {
            const int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
            acc += bit ? qs[j] : -qs[j];
        }
        raw_out[t] = scl * norm_k * acc * sm_scale;
    }
}

void eliza_fused_attn_qjl_tbq3(const float * q_sketch,
                               const eliza_block_qjl1_256 * packed_k,
                               const eliza_block_tbq3_0 * packed_v,
                               int n_heads, int n_kv_heads, int n_tokens,
                               float sm_scale,
                               float * out) {
    if (n_kv_heads <= 0 || n_heads % n_kv_heads != 0 || n_tokens <= 0) return;
    const int gqa = n_heads / n_kv_heads;
    float * raw = (float *)malloc((size_t)n_tokens * sizeof(float));
    float * w   = (float *)malloc((size_t)n_tokens * sizeof(float));
    if (!raw || !w) { free(raw); free(w); return; }

    for (int hq = 0; hq < n_heads; hq++) {
        const int hk = hq / gqa;
        const float * qs = q_sketch + (size_t)hq * ELIZA_FUSED_PROJ_DIM;
        const eliza_block_qjl1_256 * pk_head = packed_k + (size_t)hk * n_tokens;
        /* packed_v layout: per kv-head, per token, 4 contiguous tbq3_0 blocks. */
        const eliza_block_tbq3_0 * pv_head =
            packed_v + (size_t)hk * n_tokens * ELIZA_FUSED_TBQ_PER_TOKEN;
        float * out_head = out + (size_t)hq * ELIZA_FUSED_HEAD_DIM;

        fused_qjl_scores_one_head(qs, pk_head, n_tokens, sm_scale, raw);
        fused_softmax_weights(raw, n_tokens, w);

        for (int d = 0; d < ELIZA_FUSED_HEAD_DIM; d++) out_head[d] = 0.0f;
        for (int t = 0; t < n_tokens; t++) {
            const float wt = w[t];
            if (wt == 0.0f) continue;
            for (int c = 0; c < ELIZA_FUSED_TBQ_PER_TOKEN; c++) {
                float dec[32];
                eliza_tbq3_decode_block_uncond(
                    pv_head + (size_t)t * ELIZA_FUSED_TBQ_PER_TOKEN + c, dec);
                float * oc = out_head + c * 32;
                for (int i = 0; i < 32; i++) oc[i] += wt * dec[i];
            }
        }
    }
    free(raw); free(w);
}

void eliza_fused_attn_qjl_polar(const float * q_sketch,
                                const eliza_block_qjl1_256 * packed_k,
                                const eliza_block_q4_polar * packed_v,
                                int n_heads, int n_kv_heads, int n_tokens,
                                float sm_scale, int use_qjl,
                                float * out) {
    if (n_kv_heads <= 0 || n_heads % n_kv_heads != 0 || n_tokens <= 0) return;
    const int gqa = n_heads / n_kv_heads;
    float * raw = (float *)malloc((size_t)n_tokens * sizeof(float));
    float * w   = (float *)malloc((size_t)n_tokens * sizeof(float));
    if (!raw || !w) { free(raw); free(w); return; }

    for (int hq = 0; hq < n_heads; hq++) {
        const int hk = hq / gqa;
        const float * qs = q_sketch + (size_t)hq * ELIZA_FUSED_PROJ_DIM;
        const eliza_block_qjl1_256 * pk_head = packed_k + (size_t)hk * n_tokens;
        /* packed_v layout: per kv-head, one block_q4_polar per token. */
        const eliza_block_q4_polar * pv_head = packed_v + (size_t)hk * n_tokens;
        float * out_head = out + (size_t)hq * ELIZA_FUSED_HEAD_DIM;

        fused_qjl_scores_one_head(qs, pk_head, n_tokens, sm_scale, raw);
        fused_softmax_weights(raw, n_tokens, w);

        for (int d = 0; d < ELIZA_FUSED_HEAD_DIM; d++) out_head[d] = 0.0f;
        for (int t = 0; t < n_tokens; t++) {
            const float wt = w[t];
            if (wt == 0.0f) continue;
            float dec[ELIZA_QK_POLAR];
            eliza_polar_dequantize_row(pv_head + t, dec, ELIZA_QK_POLAR, use_qjl);
            for (int d = 0; d < ELIZA_FUSED_HEAD_DIM; d++) out_head[d] += wt * dec[d];
        }
    }
    free(raw); free(w);
}
