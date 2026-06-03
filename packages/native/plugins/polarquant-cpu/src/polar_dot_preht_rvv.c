/* polar_dot_preht_rvv.c - RISC-V Vector 1.0 pre-Hadamard-query dot
 * for block_q4_polar against an fp32 query vector.
 *
 * Same algebra as polar_dot_preht_neon.c / polar_dot_preht_avx2.c:
 * caller supplies q_preht = H * q (one Hadamard per query head/chunk),
 * so each Q4_POLAR block reduces to:
 *
 *   1. unpack 64 nibble bytes -> 128 centroid floats
 *   2. (optional) add the per-block 1-bit QJL residual along the
 *      seeded +/-1 sign vector
 *   3. dot directly against q_preht (no inverse Hadamard, no scratch
 *      decode followed by a separate FMA pass)
 *   4. accumulate (norm/128) * dot
 *
 * Centroid unpack: identical to the dequantize path — vluxei indexed
 * load against the 16-entry LUT, low/high nibbles materialised in
 * separate vector groups and interleaved via a strided store.
 *
 * FMA accumulator: a single vfloat32m4_t carried across the 128-element
 * tile.  At VLEN=128 that's 16 lanes/m4, so 8 vector iters per block;
 * at VLEN=512 it's 64 lanes, so 2 iters per block.  We pay a single
 * vfredusum at the end of the block instead of one per chunk.
 *
 * Bit-exact relative to ggml_vec_dot_q4_polar_preht_f32_ref up to fp32
 * rounding-order drift (the parity test tolerates 1e-5 relative).
 */

#if defined(__riscv) && defined(__riscv_v_intrinsic)

#include <math.h>
#include <stdint.h>

#include <riscv_vector.h>

#include "polarquant/polarquant.h"

/* Unpack 64 nibble bytes (qs) into 128 centroid floats in dst, in the
 * [lo0,hi0,lo1,hi1,...] order the scalar reference uses.  Shared shape
 * with polar_dequant_rvv.c::unpack_codes_rvv but kept TU-local so each
 * SIMD TU stays self-contained. */
static inline void unpack_centroids_rvv(const uint8_t * qs, float * dst) {
    size_t remaining = QK_POLAR / 2;
    const uint8_t * src = qs;
    float * out = dst;
    while (remaining > 0) {
        size_t vl = __riscv_vsetvl_e8m1(remaining);
        vuint8m1_t v_bytes = __riscv_vle8_v_u8m1(src, vl);
        vuint8m1_t v_lo8 = __riscv_vand_vx_u8m1(v_bytes, 0x0F, vl);
        vuint8m1_t v_hi8 = __riscv_vsrl_vx_u8m1(v_bytes, 4, vl);
        vuint32m4_t v_lo_idx = __riscv_vzext_vf4_u32m4(v_lo8, vl);
        vuint32m4_t v_hi_idx = __riscv_vzext_vf4_u32m4(v_hi8, vl);
        vuint32m4_t v_lo_off = __riscv_vmul_vx_u32m4(v_lo_idx, (uint32_t)sizeof(float), vl);
        vuint32m4_t v_hi_off = __riscv_vmul_vx_u32m4(v_hi_idx, (uint32_t)sizeof(float), vl);
        vfloat32m4_t v_lo_f = __riscv_vluxei32_v_f32m4(POLAR_Q4_CENTROIDS, v_lo_off, vl);
        vfloat32m4_t v_hi_f = __riscv_vluxei32_v_f32m4(POLAR_Q4_CENTROIDS, v_hi_off, vl);
        __riscv_vsse32_v_f32m4(out + 0, 2 * (ptrdiff_t)sizeof(float), v_lo_f, vl);
        __riscv_vsse32_v_f32m4(out + 1, 2 * (ptrdiff_t)sizeof(float), v_hi_f, vl);
        src       += vl;
        out       += 2 * vl;
        remaining -= vl;
    }
}

void ggml_vec_dot_q4_polar_preht_f32_rvv(
    int n, float * s, const block_q4_polar * x, const float * q_preht, int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) return;

    const float * const signs = use_qjl ? polar_qjl_signs_cached() : NULL;
    const float residual_mag = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);

    const int nb = n / QK_POLAR;
    double acc_total = 0.0;

    float cbuf[QK_POLAR];

    for (int b = 0; b < nb; ++b) {
        const block_q4_polar *blk = x + b;
        const float *q = q_preht + b * QK_POLAR;
        const float norm_scale  = polar_fp16_to_fp32(blk->d) * (1.0f / (float)QK_POLAR);
        const int   residual_bit = blk->qjl[0] & 1;
        const float residual = (residual_bit ? 1.0f : -1.0f) * residual_mag;

        unpack_centroids_rvv(blk->qs, cbuf);

        /* Initialise the accumulator at max-VL so unused lanes are
         * zero-padded for the final reduction. */
        size_t vl_acc = __riscv_vsetvl_e32m4((size_t)QK_POLAR);
        vfloat32m4_t v_acc = __riscv_vfmv_v_f_f32m4(0.0f, vl_acc);

        int i = 0;
        while (i < QK_POLAR) {
            size_t vl = __riscv_vsetvl_e32m4((size_t)(QK_POLAR - i));
            vfloat32m4_t v_c = __riscv_vle32_v_f32m4(cbuf + i, vl);
            if (use_qjl) {
                vfloat32m4_t v_s = __riscv_vle32_v_f32m4(signs + i, vl);
                v_c = __riscv_vfmacc_vf_f32m4(v_c, residual, v_s, vl);
            }
            vfloat32m4_t v_q = __riscv_vle32_v_f32m4(q + i, vl);
            v_acc = __riscv_vfmacc_vv_f32m4(v_acc, v_c, v_q, vl);
            i += (int)vl;
        }

        vfloat32m1_t zero = __riscv_vfmv_v_f_f32m1(0.0f, __riscv_vsetvl_e32m1(1));
        vfloat32m1_t r    = __riscv_vfredusum_vs_f32m4_f32m1(v_acc, zero, vl_acc);
        const float d     = __riscv_vfmv_f_s_f32m1_f32(r);
        acc_total += (double)norm_scale * (double)d;
    }
    *s = (float)acc_total;
}

#endif /* __riscv && __riscv_v_intrinsic */

typedef int polar_dot_preht_rvv_iso_c_translation_unit_anchor;
