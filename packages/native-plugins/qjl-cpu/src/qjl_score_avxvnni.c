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
 * Inner-loop tuning (per (head, token)): the 8 query-value chunks are
 * fixed across the token loop, so they are loaded once per head and held
 * in registers. Two independent VPDPBUSD accumulators (4 rounds each)
 * break the latency chain — Arrow Lake's VPDPBUSD has ~5c latency, 1/c
 * throughput, so a single dependent chain of 8 stalls; two chains hide
 * it. The bit-expand → VPDPBUSD ratio stays 1:1 per round (the expand is
 * the bottleneck, not the dot), so the headroom is in ILP, not in the
 * arithmetic.
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

/* bf16 -> fp32 (zero-extend), inlined here so the token loop doesn't
 * pay a non-inlinable call to the cross-TU qjl_bf16_to_fp32. */
static inline float bf16_to_fp32_inline(uint16_t b) {
    union { float f; uint32_t u; } v;
    v.u = ((uint32_t)b) << 16;
    return v.f;
}

/* Expand 32 packed sign bits (4 source bytes) into 32 {0,1} bytes.
 * `bcast` broadcasts byte b of the 4 source bytes to lanes [8b..8b+7];
 * `sel` is the per-lane bit selector {1,2,4,...,128} x4; `one` is 1 per
 * byte. All three are loop-invariant — the caller hoists them. */
static inline __m256i expand_32_bits(const uint8_t *src4, __m256i bcast,
                                     __m256i sel, __m256i one) {
    uint32_t w;
    __builtin_memcpy(&w, src4, 4);
    __m256i v = _mm256_set1_epi32((int)w);              /* {b0,b1,b2,b3} x8 */
    v = _mm256_shuffle_epi8(v, bcast);                  /* lane i = byte i/8 */
    __m256i andv = _mm256_and_si256(v, sel);
    __m256i mask = _mm256_cmpeq_epi8(andv, sel);        /* 0xFF where set */
    return _mm256_and_si256(mask, one);                 /* {0,1} per lane */
}

void qjl_score_qk_i8_avxvnni(const qjl_i8_sketch_256 *q_sketch_i8,
                             const qjl_block_qjl1_256 *packed_k,
                             int n_heads, int n_kv_heads, int n_tokens,
                             float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;
    const __m256i ones_u8 = _mm256_set1_epi8(1);
    const __m256i bcast = _mm256_setr_epi8(
        0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1,1,
        2,2,2,2,2,2,2,2, 3,3,3,3,3,3,3,3);
    const __m256i sel = _mm256_setr_epi8(
        1,2,4,8,16,32,64,(char)128, 1,2,4,8,16,32,64,(char)128,
        1,2,4,8,16,32,64,(char)128, 1,2,4,8,16,32,64,(char)128);

    for (int hq = 0; hq < n_heads; ++hq) {
        const int hk = hq / gqa;
        const qjl_i8_sketch_256 *qs = q_sketch_i8 + hq;

        /* The 8 query-value chunks (32 i8 each) are constant over the
         * token loop — hold them in registers. */
        const __m256i qv0 = _mm256_loadu_si256((const __m256i *)(qs->values +   0));
        const __m256i qv1 = _mm256_loadu_si256((const __m256i *)(qs->values +  32));
        const __m256i qv2 = _mm256_loadu_si256((const __m256i *)(qs->values +  64));
        const __m256i qv3 = _mm256_loadu_si256((const __m256i *)(qs->values +  96));
        const __m256i qv4 = _mm256_loadu_si256((const __m256i *)(qs->values + 128));
        const __m256i qv5 = _mm256_loadu_si256((const __m256i *)(qs->values + 160));
        const __m256i qv6 = _mm256_loadu_si256((const __m256i *)(qs->values + 192));
        const __m256i qv7 = _mm256_loadu_si256((const __m256i *)(qs->values + 224));

        /* sum_j q_i8[j] via VPDPBUSD(ones, q) — two chains, then merge. */
        __m256i sa = vnni_dpbusd(_mm256_setzero_si256(), ones_u8, qv0);
        __m256i sb = vnni_dpbusd(_mm256_setzero_si256(), ones_u8, qv1);
        sa = vnni_dpbusd(sa, ones_u8, qv2);
        sb = vnni_dpbusd(sb, ones_u8, qv3);
        sa = vnni_dpbusd(sa, ones_u8, qv4);
        sb = vnni_dpbusd(sb, ones_u8, qv5);
        sa = vnni_dpbusd(sa, ones_u8, qv6);
        sb = vnni_dpbusd(sb, ones_u8, qv7);
        __m256i sumv = _mm256_add_epi32(sa, sb);
        __m128i s128 = _mm_add_epi32(_mm256_castsi256_si128(sumv),
                                     _mm256_extracti128_si256(sumv, 1));
        s128 = _mm_add_epi32(s128, _mm_shuffle_epi32(s128, _MM_SHUFFLE(1,0,3,2)));
        s128 = _mm_add_epi32(s128, _mm_shuffle_epi32(s128, _MM_SHUFFLE(2,3,0,1)));
        const int32_t sum_q = _mm_cvtsi128_si32(s128);

        const qjl_block_qjl1_256 *blk = packed_k + (size_t)hk * n_tokens;
        const float kscl = scl_base * qs->scale;
        float *out = scores + (size_t)hq * n_tokens;

        for (int t = 0; t < n_tokens; ++t, ++blk) {
            const uint8_t *bb = blk->qs;
            /* 8 rounds of (expand 32 bits) x (32 i8 q) via VPDPBUSD,
             * split over two independent accumulators. */
            __m256i acc0 = vnni_dpbusd(_mm256_setzero_si256(),
                                       expand_32_bits(bb +  0, bcast, sel, ones_u8), qv0);
            __m256i acc1 = vnni_dpbusd(_mm256_setzero_si256(),
                                       expand_32_bits(bb +  4, bcast, sel, ones_u8), qv1);
            acc0 = vnni_dpbusd(acc0, expand_32_bits(bb +  8, bcast, sel, ones_u8), qv2);
            acc1 = vnni_dpbusd(acc1, expand_32_bits(bb + 12, bcast, sel, ones_u8), qv3);
            acc0 = vnni_dpbusd(acc0, expand_32_bits(bb + 16, bcast, sel, ones_u8), qv4);
            acc1 = vnni_dpbusd(acc1, expand_32_bits(bb + 20, bcast, sel, ones_u8), qv5);
            acc0 = vnni_dpbusd(acc0, expand_32_bits(bb + 24, bcast, sel, ones_u8), qv6);
            acc1 = vnni_dpbusd(acc1, expand_32_bits(bb + 28, bcast, sel, ones_u8), qv7);
            __m256i acc = _mm256_add_epi32(acc0, acc1);
            __m128i a128 = _mm_add_epi32(_mm256_castsi256_si128(acc),
                                         _mm256_extracti128_si256(acc, 1));
            a128 = _mm_add_epi32(a128, _mm_shuffle_epi32(a128, _MM_SHUFFLE(1,0,3,2)));
            a128 = _mm_add_epi32(a128, _mm_shuffle_epi32(a128, _MM_SHUFFLE(2,3,0,1)));
            const int32_t dot_pos = _mm_cvtsi128_si32(a128);
            const int32_t raw = 2 * dot_pos - sum_q;
            const float norm_k = bf16_to_fp32_inline(blk->norm_bf16);
            out[t] = kscl * norm_k * (float)raw;
        }
    }
}

#endif /* AVX-VNNI */
