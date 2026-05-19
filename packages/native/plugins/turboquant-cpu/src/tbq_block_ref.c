/* tbq_block_ref.c — scalar reference for TBQ3_0 / TBQ4_0 block encode/decode.
 *
 * Math is identical to:
 *   plugins/plugin-local-inference/native/reference/turbo_kernels.c
 *     :: eliza_quantize_tbq3_block / eliza_tbq3_decode_block_uncond
 *     :: eliza_quantize_tbq4_block / eliza_tbq4_decode_block_uncond
 *
 * The fork's CPU implementation is at
 *   plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-quants.c
 *
 * Both are kept bit-identical so this standalone library can stand in
 * for the fork in user-space tools (GGUF converters, parity tests).
 */

#include "turboquant/turboquant.h"

#include <math.h>
#include <string.h>

/* ---- canonical constants (verbatim from the fork / turbo_kernels.c) -- */

const float TBQ3_CODEBOOK[8] = {
    -2.1519457f, -1.3439093f, -0.7560053f, -0.2450942f,
     0.2450942f,  0.7560053f,  1.3439093f,  2.1519457f,
};

const float TBQ4_CODEBOOK[16] = {
    -2.7321365f, -2.0685055f, -1.6175243f, -1.2557391f,
    -0.9419147f, -0.6564307f, -0.3878412f, -0.1283243f,
     0.1283243f,  0.3878412f,  0.6564307f,  0.9419147f,
     1.2557391f,  1.6175243f,  2.0685055f,  2.7321365f,
};

const int8_t TBQ_SIGNS_32[32] = {
     1, -1,  1,  1, -1,  1, -1, -1,
     1,  1, -1,  1, -1, -1,  1, -1,
    -1,  1,  1, -1,  1, -1, -1,  1,
     1, -1,  1, -1, -1,  1, -1,  1,
};

/* ---- fp16 conversion (same as turbo_kernels.c::eliza_fp{16,32}_to_*) - */

uint16_t tbq_fp32_to_fp16(float f) {
    union { float f; uint32_t u; } v = { f };
    uint32_t u = v.u;
    uint32_t sign = (u >> 16) & 0x8000u;
    uint32_t exp  = (u >> 23) & 0xffu;
    uint32_t mant = u & 0x7fffffu;
    if (exp == 0xff) {
        return (uint16_t)(sign | 0x7c00u | (mant ? 0x200u : 0u));
    }
    int32_t e = (int32_t)exp - 127 + 15;
    if (e >= 31) return (uint16_t)(sign | 0x7c00u);
    if (e <= 0) {
        if (e < -10) return (uint16_t)sign;
        mant |= 0x800000u;
        uint32_t shift = (uint32_t)(14 - e);
        uint16_t result = (uint16_t)(sign | (mant >> shift));
        if ((mant >> (shift - 1)) & 1u) result++;
        return result;
    }
    uint16_t result = (uint16_t)(sign | (uint32_t)(e << 10) | (mant >> 13));
    if (mant & 0x1000u) result++;
    return result;
}

float tbq_fp16_to_fp32(uint16_t h) {
    uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
    uint32_t exp  = (h >> 10) & 0x1fu;
    uint32_t mant = h & 0x3ffu;
    uint32_t u;
    if (exp == 0) {
        if (mant == 0) {
            u = sign;
        } else {
            while (!(mant & 0x400u)) { mant <<= 1; exp--; }
            mant &= 0x3ffu;
            u = sign | (((uint32_t)(exp + 127 - 15 + 1)) << 23) | (mant << 13);
        }
    } else if (exp == 0x1f) {
        u = sign | 0x7f800000u | (mant << 13);
    } else {
        u = sign | (((uint32_t)(exp + 127 - 15)) << 23) | (mant << 13);
    }
    union { uint32_t u; float f; } v = { u };
    return v.f;
}

/* ---- size-32 Walsh-Hadamard butterfly (orthonormal, 1/sqrt(32)) ----- */

static void tbq_hadamard32(float x[32]) {
    for (int len = 1; len < 32; len <<= 1) {
        for (int i = 0; i < 32; i += 2 * len) {
            for (int j = 0; j < len; ++j) {
                const float a = x[i + j];
                const float b = x[i + j + len];
                x[i + j]       = a + b;
                x[i + j + len] = a - b;
            }
        }
    }
    const float norm = 0.1767766952966369f; /* 1 / sqrt(32) */
    for (int i = 0; i < 32; ++i) x[i] *= norm;
}

static void tbq_precondition(const float * x, float y[32]) {
    for (int i = 0; i < TBQ_QK; i++) y[i] = x[i] * (float)TBQ_SIGNS_32[i];
    tbq_hadamard32(y);
}

static void tbq_uncondition(float x[32]) {
    tbq_hadamard32(x);
    for (int i = 0; i < TBQ_QK; i++) x[i] *= (float)TBQ_SIGNS_32[i];
}

/* ---- nearest-centroid + 3-bit / 4-bit pack / unpack ---------------- */

static uint8_t tbq_nearest(int n, const float * cb, float v) {
    if (v <= cb[0])     return 0;
    if (v >= cb[n - 1]) return (uint8_t)(n - 1);
    int lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        int mid = (lo + hi) / 2;
        if (v < cb[mid]) hi = mid; else lo = mid;
    }
    return (uint8_t)((v - cb[lo] <= cb[hi] - v) ? lo : hi);
}

static inline uint8_t tbq3_get(const uint8_t * qs, int idx) {
    const int bit = idx * 3;
    const int byte = bit >> 3;
    const int shift = bit & 7;
    uint32_t bits = (uint32_t)qs[byte] >> shift;
    if (shift > 5 && byte + 1 < (TBQ_QK * 3 / 8)) {
        bits |= (uint32_t)qs[byte + 1] << (8 - shift);
    }
    return (uint8_t)(bits & 0x7u);
}
static inline void tbq3_set(uint8_t * qs, int idx, uint8_t code) {
    const int bit = idx * 3;
    const int byte = bit >> 3;
    const int shift = bit & 7;
    qs[byte] = (uint8_t)(qs[byte] | ((code & 0x7u) << shift));
    if (shift > 5 && byte + 1 < (TBQ_QK * 3 / 8)) {
        qs[byte + 1] = (uint8_t)(qs[byte + 1] | ((code & 0x7u) >> (8 - shift)));
    }
}
static inline uint8_t tbq4_get(const uint8_t * qs, int idx) {
    const int j = idx % (TBQ_QK / 2);
    return idx < TBQ_QK / 2 ? (uint8_t)(qs[j] & 0x0F) : (uint8_t)(qs[j] >> 4);
}
static inline void tbq4_set(uint8_t * qs, int idx, uint8_t code) {
    const int j = idx % (TBQ_QK / 2);
    if (idx < TBQ_QK / 2) qs[j] = (uint8_t)((qs[j] & 0xF0u) | (code & 0x0Fu));
    else                  qs[j] = (uint8_t)((qs[j] & 0x0Fu) | ((code & 0x0Fu) << 4));
}

/* ---- public API ---------------------------------------------------- */

void tbq_quantize_tbq3_block(const float src[32], tbq_block_tbq3_0 * dst) {
    float rotated[32];
    tbq_precondition(src, rotated);
    float sumsq = 0.0f;
    for (int j = 0; j < TBQ_QK; j++) sumsq += rotated[j] * rotated[j];
    const float d = sqrtf(sumsq / (float)TBQ_QK);
    dst->d = tbq_fp32_to_fp16(d);
    memset(dst->qs, 0, sizeof(dst->qs));
    if (d == 0.0f) return;
    const float id = 1.0f / d;
    for (int j = 0; j < TBQ_QK; j++) {
        tbq3_set(dst->qs, j, tbq_nearest(8, TBQ3_CODEBOOK, rotated[j] * id));
    }
}

void tbq_quantize_tbq4_block(const float src[32], tbq_block_tbq4_0 * dst) {
    float rotated[32];
    tbq_precondition(src, rotated);
    float sumsq = 0.0f;
    for (int j = 0; j < TBQ_QK; j++) sumsq += rotated[j] * rotated[j];
    const float d = sqrtf(sumsq / (float)TBQ_QK);
    dst->d = tbq_fp32_to_fp16(d);
    memset(dst->qs, 0, sizeof(dst->qs));
    if (d == 0.0f) return;
    const float id = 1.0f / d;
    for (int j = 0; j < TBQ_QK; j++) {
        tbq4_set(dst->qs, j, tbq_nearest(16, TBQ4_CODEBOOK, rotated[j] * id));
    }
}

void tbq_decode_tbq3_block(const tbq_block_tbq3_0 * src, float dst[32]) {
    const float d = tbq_fp16_to_fp32(src->d);
    if (d == 0.0f) { memset(dst, 0, 32 * sizeof(float)); return; }
    for (int i = 0; i < TBQ_QK; i++) dst[i] = d * TBQ3_CODEBOOK[tbq3_get(src->qs, i)];
    tbq_uncondition(dst);
}

void tbq_decode_tbq4_block(const tbq_block_tbq4_0 * src, float dst[32]) {
    const float d = tbq_fp16_to_fp32(src->d);
    if (d == 0.0f) { memset(dst, 0, 32 * sizeof(float)); return; }
    for (int i = 0; i < TBQ_QK; i++) dst[i] = d * TBQ4_CODEBOOK[tbq4_get(src->qs, i)];
    tbq_uncondition(dst);
}
