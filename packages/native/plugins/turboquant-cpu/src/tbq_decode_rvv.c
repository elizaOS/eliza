/* tbq_decode_rvv.c - RVV 1.0 intrinsic TB3 / TB4 block decode.
 *
 * Inverse of tbq_encode_rvv.c, bit-exact to
 * tbq_block_ref.c::tbq_decode_tbq{3,4}_block_ref:
 *
 *   1. codebook lookup (TBQ3: 8 entries via vrgather; TBQ4: 16 entries
 *      same) scaled by `d`
 *   2. orthonormal inverse Hadamard-32 (self-inverse with 1/sqrt(32))
 *   3. ±1 sign flip per TBQ_SIGNS_32
 *
 * Built only on riscv64 with `-march=rv64gcv1p0`. Same VL-agnostic
 * layout as the encode: 32 floats in a single vfloat32m8_t register
 * group, butterflies via vrgather + merge mask. */

#if defined(__riscv) && defined(__riscv_v_intrinsic)

#include "turboquant/turboquant.h"

#include <riscv_vector.h>
#include <math.h>
#include <string.h>
#include <stddef.h>

/* fp16 conversion lives in the scalar TU. */
extern float tbq_fp16_to_fp32(uint16_t h);

/* Hadamard-32 and sign-mask helpers are duplicated here intentionally:
 * keeping each SIMD TU self-contained avoids cross-TU inlining issues
 * when the file is built with a different -march than the rest of the
 * library. */

static inline void tbq_rvv_layer_indices(
    uint32_t len,
    uint32_t * out_lo, uint32_t * out_hi, uint8_t * out_mask)
{
    for (uint32_t i = 0; i < 32; ++i) {
        out_lo[i]   = i & ~len;
        out_hi[i]   = i | len;
        out_mask[i] = (i & len) ? 1 : 0;
    }
}

static inline vfloat32m8_t tbq_rvv_hadamard32(vfloat32m8_t x, size_t vl) {
    static const uint32_t kStrides[5] = { 1, 2, 4, 8, 16 };
    uint32_t lo_idx[32], hi_idx[32];
    uint8_t  upper[32];
    for (int layer = 0; layer < 5; ++layer) {
        const uint32_t len = kStrides[layer];
        tbq_rvv_layer_indices(len, lo_idx, hi_idx, upper);

        vuint32m8_t vlo_idx = __riscv_vle32_v_u32m8(lo_idx, vl);
        vuint32m8_t vhi_idx = __riscv_vle32_v_u32m8(hi_idx, vl);

        vfloat32m8_t lo = __riscv_vrgather_vv_f32m8(x, vlo_idx, vl);
        vfloat32m8_t hi = __riscv_vrgather_vv_f32m8(x, vhi_idx, vl);

        vfloat32m8_t sum  = __riscv_vfadd_vv_f32m8(lo, hi, vl);
        vfloat32m8_t diff = __riscv_vfsub_vv_f32m8(lo, hi, vl);

        vuint8m2_t mask_bytes = __riscv_vle8_v_u8m2(upper, vl);
        vbool4_t   mask       = __riscv_vmsne_vx_u8m2_b4(mask_bytes, 0, vl);

        x = __riscv_vmerge_vvm_f32m8(sum, diff, mask, vl);
    }
    const float norm = 0.1767766952966369f;
    x = __riscv_vfmul_vf_f32m8(x, norm, vl);
    return x;
}

/* ---------- unpack 3-bit indices (TBQ3 wire format) ----------
 *
 * Mirrors tbq3_get() in the scalar ref. Done scalar because the 3-bit
 * stride doesn't align with any vector lane width. The expensive part
 * (codebook lookup + Hadamard) is what we vectorise downstream. */
static void tbq_rvv_unpack3(const uint8_t qs[12], uint8_t codes[32]) {
    for (int idx = 0; idx < 32; ++idx) {
        const int bit = idx * 3;
        const int byte = bit >> 3;
        const int shift = bit & 7;
        uint32_t bits = (uint32_t)qs[byte] >> shift;
        if (shift > 5 && byte + 1 < 12) {
            bits |= (uint32_t)qs[byte + 1] << (8 - shift);
        }
        codes[idx] = (uint8_t)(bits & 0x7u);
    }
}

/* ---------- unpack 4-bit indices (TBQ4 wire format) ----------
 *
 * q4_0-style: codes[j] is the low nibble of qs[j], codes[j+16] is the
 * high nibble. Mirrors tbq4_get() in the scalar ref. */
static void tbq_rvv_unpack4(const uint8_t qs[16], uint8_t codes[32]) {
    for (int j = 0; j < 16; ++j) {
        codes[j]      = (uint8_t)(qs[j] & 0x0Fu);
        codes[j + 16] = (uint8_t)(qs[j] >> 4);
    }
}

/* ---------- codebook lookup via vrgather ----------
 *
 * The codebook has N <= 16 sorted entries. We broadcast the entries
 * into a vector register and `vrgather` them by the per-lane index. */
static inline vfloat32m8_t tbq_rvv_codebook_lookup(
    const uint8_t codes[32], const float * cb, int n, size_t vl)
{
    /* Load the indices as u32, then vrgather a broadcast of the codebook.
     * We need at least n entries replicated; loading the codebook into
     * an m8 group (32 lanes) with the high lanes zero-padded is safe
     * because every index satisfies 0 <= code < n. */
    float cb_buf[32];
    for (int i = 0; i < n; ++i)        cb_buf[i] = cb[i];
    for (int i = n; i < 32; ++i)       cb_buf[i] = 0.0f;

    uint32_t idx32[32];
    for (int i = 0; i < 32; ++i) idx32[i] = (uint32_t)codes[i];

    vfloat32m8_t cb_vec = __riscv_vle32_v_f32m8(cb_buf, vl);
    vuint32m8_t  idx_v  = __riscv_vle32_v_u32m8(idx32, vl);
    (void)n;
    return __riscv_vrgather_vv_f32m8(cb_vec, idx_v, vl);
}

/* ---------- ±1 sign flip via vfmul ---------- */
static inline vfloat32m8_t tbq_rvv_apply_signs_v(vfloat32m8_t x, size_t vl) {
    float signs_f[32];
    for (int i = 0; i < 32; ++i) signs_f[i] = (float)TBQ_SIGNS_32[i];
    vfloat32m8_t s = __riscv_vle32_v_f32m8(signs_f, vl);
    return __riscv_vfmul_vv_f32m8(x, s, vl);
}

/* ---------- public decode entry points ---------- */

void tbq_decode_tbq3_block_rvv(const tbq_block_tbq3_0 * src, float dst[32]) {
    const float d = tbq_fp16_to_fp32(src->d);
    if (d == 0.0f) { memset(dst, 0, 32 * sizeof(float)); return; }

    const size_t vl = __riscv_vsetvl_e32m8(32);

    uint8_t codes[32];
    tbq_rvv_unpack3(src->qs, codes);

    vfloat32m8_t centroids = tbq_rvv_codebook_lookup(codes, TBQ3_CODEBOOK, 8, vl);
    vfloat32m8_t scaled    = __riscv_vfmul_vf_f32m8(centroids, d, vl);

    /* Inverse Hadamard (self-inverse for the orthonormal form). */
    vfloat32m8_t rot = tbq_rvv_hadamard32(scaled, vl);

    /* Final ±1 sign flip. */
    vfloat32m8_t out = tbq_rvv_apply_signs_v(rot, vl);
    __riscv_vse32_v_f32m8(dst, out, vl);
}

void tbq_decode_tbq4_block_rvv(const tbq_block_tbq4_0 * src, float dst[32]) {
    const float d = tbq_fp16_to_fp32(src->d);
    if (d == 0.0f) { memset(dst, 0, 32 * sizeof(float)); return; }

    const size_t vl = __riscv_vsetvl_e32m8(32);

    uint8_t codes[32];
    tbq_rvv_unpack4(src->qs, codes);

    vfloat32m8_t centroids = tbq_rvv_codebook_lookup(codes, TBQ4_CODEBOOK, 16, vl);
    vfloat32m8_t scaled    = __riscv_vfmul_vf_f32m8(centroids, d, vl);

    vfloat32m8_t rot = tbq_rvv_hadamard32(scaled, vl);
    vfloat32m8_t out = tbq_rvv_apply_signs_v(rot, vl);
    __riscv_vse32_v_f32m8(dst, out, vl);
}

#endif /* __riscv && __riscv_v_intrinsic */
