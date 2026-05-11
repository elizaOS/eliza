/*
 * AVX-VNNI GQA attention-score kernel for the experimental int8 query
 * sketch (256-bit VPDPBUSD, Alder Lake / Arrow Lake and newer x86).
 *
 * QJL's score reduces to an integer sign-dot once the per-head q sketch
 * is quantized to int8 + one fp32 scale:
 *
 *   raw  = sum_j (2*bit_j - 1) * q_i8[h, j]
 *        = 2 * sum_j bit_j * q_i8[h, j]  -  sum_j q_i8[h, j]
 *   score[h, t] = ||k_t|| * sqrt(pi/2)/proj_dim * scale[h] * raw
 *
 * `sum_j bit_j * q_i8[h, j]` is exactly an unsigned*signed dot — bits are
 * {0,1} u8, q values are i8 — so VPDPBUSD computes 4 products + add per
 * 32-bit lane. We expand 32 packed sign bits to 32 {0,1} bytes per round
 * (4 input bytes -> one ymm) via a pshufb byte-broadcast + per-lane bit
 * selector, then 8 rounds of VPDPBUSD cover proj_dim = 256.
 *
 * `sum_j q_i8[h, j]` is precomputed once per head with VPDPBUSD against
 * an all-ones u8 vector.
 *
 * Output parity: this is an *approximation* of qjl_score_qk_ref (the
 * exact fp32 baseline). It is exact relative to qjl_score_qk_i8_ref —
 * verified in qjl_int8_smoke / qjl_avxvnni_smoke.
 */

#if defined(__AVXVNNI__) || (defined(__AVX2__) && defined(__AVX512VL__) && defined(__AVX512VNNI__))

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <immintrin.h>
#include <stdint.h>

/* Wrapper so the same body builds against either the AVX-VNNI (VEX, ymm)
 * intrinsic or the AVX512-VL flavour (EVEX-encoded ymm). */
static inline __m256i vnni_dpbusd(__m256i acc, __m256i u, __m256i s) {
#if defined(__AVXVNNI__)
    return _mm256_dpbusd_avx_epi32(acc, u, s);
#else
    return _mm256_dpbusd_epi32(acc, u, s);
#endif
}

/* Expand 32 packed sign bits (4 source bytes) into 32 {0,1} bytes. */
static inline __m256i expand_32_bits(const uint8_t *src4) {
    /* Broadcast byte b of the 4 source bytes to output lanes [8b..8b+7]. */
    const __m256i bcast = _mm256_setr_epi8(
        0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1,1,
        2,2,2,2,2,2,2,2, 3,3,3,3,3,3,3,3);
    uint32_t w;
    __builtin_memcpy(&w, src4, 4);
    __m256i v = _mm256_set1_epi32((int)w);              /* {b0,b1,b2,b3} x8 */
    v = _mm256_shuffle_epi8(v, bcast);                  /* lane i = byte i/8 */
    const __m256i sel = _mm256_setr_epi8(
        1,2,4,8,16,32,64,(char)128, 1,2,4,8,16,32,64,(char)128,
        1,2,4,8,16,32,64,(char)128, 1,2,4,8,16,32,64,(char)128);
    __m256i andv = _mm256_and_si256(v, sel);
    __m256i mask = _mm256_cmpeq_epi8(andv, sel);        /* 0xFF where set */
    return _mm256_and_si256(mask, _mm256_set1_epi8(1)); /* {0,1} per lane */
}

void qjl_score_qk_i8_avxvnni(const qjl_i8_sketch_256 *q_sketch_i8,
                             const qjl_block_qjl1_256 *packed_k,
                             int n_heads, int n_kv_heads, int n_tokens,
                             float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;
    const __m256i ones_u8 = _mm256_set1_epi8(1);

    for (int hq = 0; hq < n_heads; ++hq) {
        const int hk = hq / gqa;
        const qjl_i8_sketch_256 *qs = q_sketch_i8 + hq;

        /* sum_j q_i8[j] via VPDPBUSD(ones, q) over the 8 ymm chunks. */
        __m256i sumv = _mm256_setzero_si256();
        for (int j = 0; j < QJL_PROJECTION_DIM; j += 32) {
            __m256i qv = _mm256_loadu_si256((const __m256i *)(qs->values + j));
            sumv = vnni_dpbusd(sumv, ones_u8, qv);
        }
        /* horizontal sum of the 8 i32 lanes */
        __m128i lo128 = _mm256_castsi256_si128(sumv);
        __m128i hi128 = _mm256_extracti128_si256(sumv, 1);
        __m128i s128  = _mm_add_epi32(lo128, hi128);
        s128 = _mm_add_epi32(s128, _mm_shuffle_epi32(s128, _MM_SHUFFLE(1,0,3,2)));
        s128 = _mm_add_epi32(s128, _mm_shuffle_epi32(s128, _MM_SHUFFLE(2,3,0,1)));
        const int32_t sum_q = _mm_cvtsi128_si32(s128);

        for (int t = 0; t < n_tokens; ++t) {
            const qjl_block_qjl1_256 *blk = packed_k + hk * n_tokens + t;
            __m256i acc = _mm256_setzero_si256();
            /* 8 rounds: 32 bits expanded x 32 i8 q values via VPDPBUSD. */
            for (int r = 0; r < QJL_PACKED_BYTES / 4; ++r) {
                __m256i bits = expand_32_bits(blk->qs + r * 4);
                __m256i qv   = _mm256_loadu_si256((const __m256i *)(qs->values + r * 32));
                acc = vnni_dpbusd(acc, bits, qv);
            }
            __m128i alo = _mm256_castsi256_si128(acc);
            __m128i ahi = _mm256_extracti128_si256(acc, 1);
            __m128i a128 = _mm_add_epi32(alo, ahi);
            a128 = _mm_add_epi32(a128, _mm_shuffle_epi32(a128, _MM_SHUFFLE(1,0,3,2)));
            a128 = _mm_add_epi32(a128, _mm_shuffle_epi32(a128, _MM_SHUFFLE(2,3,0,1)));
            const int32_t dot_pos = _mm_cvtsi128_si32(a128);
            const int32_t raw = 2 * dot_pos - sum_q;
            const float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[hq * n_tokens + t] = scl_base * norm_k * qs->scale * (float)raw;
        }
    }
}

#endif /* AVX-VNNI */
