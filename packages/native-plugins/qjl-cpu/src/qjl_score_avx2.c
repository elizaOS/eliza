/*
 * AVX2 GQA attention-score kernel (exact fp32 baseline path).
 *
 * For each (h_q, t):
 *   score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim *
 *                   sum_j (2*bit_packed[t,j] - 1) * q_sketch[h_q, j]
 * where the 256 sign bits live in `packed_k[hk, t].qs` (32 bytes).
 *
 * Hot-path structure. The query sketch `qs` (256 fp32) is constant over
 * the whole token loop for a head; only the sign bytes vary per token.
 * The per-byte partial sum
 *
 *     part(b, v) = sum_{k=0..7} ((v>>k & 1) ? 1 : -1) * qs[8*b + k]
 *
 * depends only on the byte position b in [0,32) and the byte value
 * v in [0,256). We build a 32x256 = 8192-float per-head table once
 * (8192 hsums of an 8-vector; setup cost amortises to <1 token of work
 * at n_tokens ~ 4k) laid out so each byte position's 256 entries are
 * contiguous (`tbl[b*256 + v]`, 32 KB, L1-resident). Then per token the
 * score reduces to 32 gathers (one per byte position, indexed by that
 * byte's value) + a horizontal reduce — 4 VGATHERDPS + 3 adds + a tail
 * reduce. That replaces the previous 32-deep dependent FMA chain
 * (~4c x 32 latency) plus 32 per-byte bit-expand sequences with a
 * memory-bound gather of an L1-resident table.
 *
 * Parity: not bit-identical to qjl_score_qk_ref (FP reassociation),
 * same as the previous AVX2 path — verified within rel < 1e-4 by
 * qjl_bench --parity / the fixture suite.
 */

#if defined(__AVX2__)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <immintrin.h>

#define QJL_SCORE_TBL_FLOATS ((size_t)QJL_PACKED_BYTES * 256) /* 32*256 = 8192 */

/* Expand one byte of sign bits into 8 fp32 lanes of +/-1 (lane k = bit k). */
static inline __m256 expand_signs_byte(uint8_t b) {
    __m256i v = _mm256_set1_epi32((int)b);
    const __m256i bits = _mm256_setr_epi32(1, 2, 4, 8, 16, 32, 64, 128);
    __m256i andv = _mm256_and_si256(v, bits);
    __m256i mask = _mm256_cmpeq_epi32(andv, bits);
    __m256 ones    = _mm256_set1_ps(1.0f);
    __m256 negones = _mm256_set1_ps(-1.0f);
    return _mm256_blendv_ps(negones, ones, _mm256_castsi256_ps(mask));
}

/* Build the 32x256 per-head partial-sum table for query sketch `qs`. */
static void qjl_build_score_table(const float *qs, float *tbl) {
    /* The 256 sign vectors are shared across all 32 byte positions and
     * across heads — build them once. 256 * 32 B = 8 KB. */
    static __m256 sgn_lut[256];
    static int sgn_lut_init = 0;
    if (!sgn_lut_init) {
        for (int v = 0; v < 256; v++) sgn_lut[v] = expand_signs_byte((uint8_t)v);
        sgn_lut_init = 1;
    }
    for (int b = 0; b < QJL_PACKED_BYTES; b++) {
        const __m256 qv = _mm256_loadu_ps(qs + (size_t)b * 8);
        float *row = tbl + (size_t)b * 256;
        for (int v = 0; v < 256; v++) {
            __m256 p = _mm256_mul_ps(sgn_lut[v], qv);
            __m128 lo = _mm256_castps256_ps128(p);
            __m128 hi = _mm256_extractf128_ps(p, 1);
            __m128 s  = _mm_add_ps(lo, hi);
            s = _mm_hadd_ps(s, s);
            s = _mm_hadd_ps(s, s);
            row[v] = _mm_cvtss_f32(s);
        }
    }
}

void qjl_score_qk_avx2(const float *q_sketch,
                       const qjl_block_qjl1_256 *packed_k,
                       int n_heads, int n_kv_heads, int n_tokens,
                       float *scores) {
    if (n_heads <= 0 || n_kv_heads <= 0 || n_tokens <= 0) return;
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    /* 32 KB partial-sum table, on the stack — no malloc, thread-safe when
     * the ggml thread pool runs this over disjoint head ranges. */
    _Alignas(64) float tbl[QJL_SCORE_TBL_FLOATS];

    /* Loop-invariant byte-position base offsets b*256 (4 ymm of 8). */
    const __m256i pos_base0 = _mm256_setr_epi32(0,256,512,768,1024,1280,1536,1792);
    const __m256i pos_step  = _mm256_set1_epi32(8 * 256);
    const __m256i pos_base1 = _mm256_add_epi32(pos_base0, pos_step);
    const __m256i pos_base2 = _mm256_add_epi32(pos_base1, pos_step);
    const __m256i pos_base3 = _mm256_add_epi32(pos_base2, pos_step);

    for (int hq = 0; hq < n_heads; hq++) {
        const int hk = hq / gqa;
        const float *qs = q_sketch + (size_t)hq * QJL_PROJECTION_DIM;
        qjl_build_score_table(qs, tbl);

        const qjl_block_qjl1_256 *blk_base = packed_k + (size_t)hk * n_tokens;
        float *out = scores + (size_t)hq * n_tokens;
        for (int t = 0; t < n_tokens; t++) {
            const uint8_t *qb = blk_base[t].qs; /* 32 bytes */
            __m256i idx0 = _mm256_add_epi32(pos_base0,
                _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)(qb +  0))));
            __m256i idx1 = _mm256_add_epi32(pos_base1,
                _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)(qb +  8))));
            __m256i idx2 = _mm256_add_epi32(pos_base2,
                _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)(qb + 16))));
            __m256i idx3 = _mm256_add_epi32(pos_base3,
                _mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *)(qb + 24))));
            __m256 g0 = _mm256_i32gather_ps(tbl, idx0, 4);
            __m256 g1 = _mm256_i32gather_ps(tbl, idx1, 4);
            __m256 g2 = _mm256_i32gather_ps(tbl, idx2, 4);
            __m256 g3 = _mm256_i32gather_ps(tbl, idx3, 4);
            __m256 acc = _mm256_add_ps(_mm256_add_ps(g0, g1), _mm256_add_ps(g2, g3));
            __m128 lo = _mm256_castps256_ps128(acc);
            __m128 hi = _mm256_extractf128_ps(acc, 1);
            __m128 v  = _mm_add_ps(lo, hi);
            v = _mm_hadd_ps(v, v);
            v = _mm_hadd_ps(v, v);
            out[t] = scl_base * qjl_bf16_to_fp32(blk_base[t].norm_bf16) * _mm_cvtss_f32(v);
        }
    }
}

#endif /* __AVX2__ */
