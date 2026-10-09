/* polar_dequant_rvv.c - RISC-V Vector 1.0 decoder for block_q4_polar.
 *
 * Algorithm mirrors polar_dequantize_neon.c / polar_dequantize_avx2.c:
 *
 *   1. Nibble unpack: 64 packed bytes -> 128 4-bit codes in
 *      [lo0,hi0,lo1,hi1,...] order (matches the scalar reference).
 *   2. Centroid LUT lookup: 16 fp32 reconstruction points.  We use an
 *      indexed-load (vluxei) over the 16-entry LUT.  The LUT is loop-
 *      invariant; the indexed load lets us stay VL-agnostic instead of
 *      assuming VLEN >= 512 for an in-register vrgather.
 *   3. (optional) per-block 1-bit QJL residual correction along the
 *      seeded +/-1 sign vector.
 *   4. In-place Walsh-Hadamard butterfly (7 stages, log2(128) = 7).
 *      Stages with stride < VL fit inside the VL window; stages with
 *      stride >= VL become straight load/add/sub pairs across two
 *      register groups.  We choose LMUL=4, SEW=32 so VLEN=128 yields
 *      VL=16 fp32 lanes per group — large enough to fold the first
 *      four stages inside the vector but still VL-agnostic via
 *      __riscv_vsetvl_e32m4.
 *   5. Final scale (inv_d * l2): fused vfmul.
 *
 * VL-agnostic notes:
 *   - We never bake VLEN into the algorithm.  The inverse Hadamard is
 *     expressed as scalar-controlled stages whose inner load width is
 *     queried with __riscv_vsetvl_*.  On VLEN >= 4096 the entire 128-
 *     element block fits in one LMUL=4 register group; on VLEN < 128
 *     the stage loops simply iterate more times.  The compiler emits
 *     the same VL-agnostic vsetvli sequence either way.
 *   - For the in-register stages (h < VL) we use vslideup/vslidedown
 *     plus signed XOR masks.  For h >= VL we keep the simple
 *     load-from-base + add/sub pattern that NEON/AVX2 also use; with
 *     VL=16 this hits stages h=16, 32, 64.
 *
 * Centroid lookup: indexed load over the 16-entry LUT.  See the
 * upstream reference for the same shape:
 *   ggml/src/ggml-cpu/arch/riscv/quants.c::ggml_vec_dot_q4_0_q8_0
 *   uses __riscv_vlxei8_v_i8m1 to gather signed-codeword values.
 */

#if defined(__riscv) && defined(__riscv_v_intrinsic)

#include <math.h>
#include <stdint.h>
#include <string.h>

#include <riscv_vector.h>

#include "polarquant/polarquant.h"

/* Unpack 64 packed nibble bytes (qs) -> 128 fp32 centroid values into
 * dst, in [lo0,hi0,lo1,hi1,...] order.
 *
 * We deinterleave by loading 16 bytes at a time as e8m1, masking the
 * low nibble, separately shifting + masking for the high nibble, then
 * issuing two vluxei indexed loads against the centroid table.  The
 * result is written in interleaved order via a vsseg2 stride-2 store.
 */
static inline void unpack_codes_rvv(const uint8_t * qs, float * dst) {
    /* The byte stream has 64 entries (QK_POLAR/2).  We chunk it by the
     * runtime VL so the routine stays VL-agnostic. */
    size_t remaining = QK_POLAR / 2;
    const uint8_t * src = qs;
    float * out = dst;
    while (remaining > 0) {
        size_t vl = __riscv_vsetvl_e8m1(remaining);

        vuint8m1_t v_bytes = __riscv_vle8_v_u8m1(src, vl);
        vuint8m1_t v_lo8 = __riscv_vand_vx_u8m1(v_bytes, 0x0F, vl);
        vuint8m1_t v_hi8 = __riscv_vsrl_vx_u8m1(v_bytes, 4, vl);

        /* Widen nibble indices to u32 so we can scale them to byte
         * offsets into the fp32 LUT. */
        vuint32m4_t v_lo_idx = __riscv_vzext_vf4_u32m4(v_lo8, vl);
        vuint32m4_t v_hi_idx = __riscv_vzext_vf4_u32m4(v_hi8, vl);
        vuint32m4_t v_lo_off = __riscv_vmul_vx_u32m4(v_lo_idx, (uint32_t)sizeof(float), vl);
        vuint32m4_t v_hi_off = __riscv_vmul_vx_u32m4(v_hi_idx, (uint32_t)sizeof(float), vl);

        vfloat32m4_t v_lo_f = __riscv_vluxei32_v_f32m4(POLAR_Q4_CENTROIDS, v_lo_off, vl);
        vfloat32m4_t v_hi_f = __riscv_vluxei32_v_f32m4(POLAR_Q4_CENTROIDS, v_hi_off, vl);

        /* Interleave (lo, hi, lo, hi, ...) and store: a segmented
         * stride-2 store with two vfloat32m4_t fields would need
         * vsseg2 at LMUL=4, but the RVV spec restricts segmented
         * stores to LMUL * nfields <= 8.  At m4 * nfields=2 = 8 that
         * is exactly at the boundary; we use a strided pair of
         * scalar-stride stores instead, which is VL-agnostic and
         * cleanly expresses the [lo0,hi0,lo1,hi1,...] order. */
        __riscv_vsse32_v_f32m4(out + 0, 2 * (ptrdiff_t)sizeof(float), v_lo_f, vl);
        __riscv_vsse32_v_f32m4(out + 1, 2 * (ptrdiff_t)sizeof(float), v_hi_f, vl);

        src       += vl;
        out       += 2 * vl;
        remaining -= vl;
    }
}

/* In-place Walsh-Hadamard butterfly of size 128, RVV variant.
 *
 * We use LMUL=4, SEW=32.  Each stage `h` does:
 *
 *   for each group of 2h consecutive elements:
 *     x[i], x[i+h] = x[i] + x[i+h], x[i] - x[i+h]
 *
 * For h >= 16 (the comfortable VL we get on VLEN=128, m4) we load 16
 * floats from each half, add and subtract, and store.  For smaller h
 * we fall through to scalar (the inner butterfly is < 4 vector-ops at
 * any VL and the cost is dominated by the larger stages).
 *
 * This matches the NEON/AVX2 fast-path structure: a 7-stage butterfly
 * over a fixed 128-element block, vectorised over the stages whose
 * stride is >= VL.
 */
static inline void hadamard_inplace_rvv(float * x) {
    /* Stages h = 1, 2, 4, 8: small strides, do scalar (compilers can
     * still keep the buffer in regs and unroll). */
    for (int h = 1; h < 16; h <<= 1) {
        for (int i = 0; i < QK_POLAR; i += (h << 1)) {
            for (int j = i; j < i + h; j++) {
                const float a = x[j];
                const float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
    /* Stages h = 16, 32, 64: vectorised cross-vector add/sub.  The
     * chunk loops walk each pair (x[i..i+h], x[i+h..i+2h]) in pieces
     * of size VL; vsetvl_e32m4 returns whichever VL the host supports. */
    for (int h = 16; h < QK_POLAR; h <<= 1) {
        for (int g = 0; g < QK_POLAR; g += (h << 1)) {
            int j = 0;
            while (j < h) {
                size_t vl = __riscv_vsetvl_e32m4((size_t)(h - j));
                vfloat32m4_t va = __riscv_vle32_v_f32m4(x + g + j,     vl);
                vfloat32m4_t vb = __riscv_vle32_v_f32m4(x + g + j + h, vl);
                __riscv_vse32_v_f32m4(x + g + j,     __riscv_vfadd_vv_f32m4(va, vb, vl), vl);
                __riscv_vse32_v_f32m4(x + g + j + h, __riscv_vfsub_vv_f32m4(va, vb, vl), vl);
                j += (int)vl;
            }
        }
    }
}

void dequantize_row_q4_polar_rvv(
    const block_q4_polar * x,
    float * y,
    int64_t k,
    int use_qjl)
{
    if (k <= 0 || (k % QK_POLAR) != 0) {
        return;
    }
    const int64_t nb = k / QK_POLAR;

    const float * const qjl_signs = use_qjl ? polar_qjl_signs_cached() : NULL;

    const float inv_d = 1.0f / (float)QK_POLAR;

    for (int64_t b = 0; b < nb; b++) {
        const block_q4_polar * src = x + b;
        float * dst = y + b * QK_POLAR;

        const float l2 = polar_fp16_to_fp32(src->d);
        const float scale = inv_d * l2;

        float buf[QK_POLAR];
        unpack_codes_rvv(src->qs, buf);

        if (use_qjl) {
            const uint8_t bit = (uint8_t)(src->qjl[0] & 1u);
            const float sign  = bit ? 1.0f : -1.0f;
            const float mag   = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);
            const float sm    = sign * mag;
            int i = 0;
            while (i < QK_POLAR) {
                size_t vl = __riscv_vsetvl_e32m4((size_t)(QK_POLAR - i));
                vfloat32m4_t v = __riscv_vle32_v_f32m4(buf + i, vl);
                vfloat32m4_t s = __riscv_vle32_v_f32m4(qjl_signs + i, vl);
                v = __riscv_vfmacc_vf_f32m4(v, sm, s, vl);
                __riscv_vse32_v_f32m4(buf + i, v, vl);
                i += (int)vl;
            }
        }

        hadamard_inplace_rvv(buf);

        int i = 0;
        while (i < QK_POLAR) {
            size_t vl = __riscv_vsetvl_e32m4((size_t)(QK_POLAR - i));
            vfloat32m4_t v = __riscv_vle32_v_f32m4(buf + i, vl);
            v = __riscv_vfmul_vf_f32m4(v, scale, vl);
            __riscv_vse32_v_f32m4(dst + i, v, vl);
            i += (int)vl;
        }
    }
}

#endif /* __riscv && __riscv_v_intrinsic */

/* Avoid ISO C "empty translation unit" pedantic error when RVV is undefined. */
typedef int polar_dequant_rvv_iso_c_translation_unit_anchor;
