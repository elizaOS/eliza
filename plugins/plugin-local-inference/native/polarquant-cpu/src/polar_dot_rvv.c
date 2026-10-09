/* polar_dot_rvv.c - RISC-V Vector 1.0 dot product between a Q4_POLAR
 * row and a Q8_0 row.
 *
 * Layout: QK_POLAR (128) = 4 * QK8_0 (32), so each Q4_POLAR block lines
 * up with 4 consecutive Q8_0 blocks.
 *
 * Fusion vs NEON/AVX2:
 *   The NEON variant first calls dequantize_row_q4_polar_neon() into a
 *   128-float scratch buffer, then loops 4 times over Q8_0 chunks and
 *   accumulates buf[i] * q8[i] * scale.  The two-pass shape forces a
 *   round-trip through L1.
 *
 *   This RVV kernel keeps the per-block decoded weights in a stack
 *   buffer (the inverse Hadamard butterfly still needs a 128-float
 *   working set), but bypasses the dequantize entry point and folds
 *   the per-Q8_0 i8->fp32 widening + FMA + per-block scaling into a
 *   single fused pass.  We never re-load the dequantized weights from
 *   the dispatched dequantize_row_q4_polar entry, which costs an
 *   extra vse32/vle32 round per element on cores where the renaming
 *   cannot fold them.
 *
 * Per-Q8_0-chunk strategy:
 *   - Load 32 i8 codes via vle8_v_i8m1.
 *   - Widen i8 -> i16 via vwadd.vx with 0.
 *   - Widen i16 -> i32 via vwadd.vx with 0.
 *   - Convert i32 -> f32 via vfcvt.
 *   - Multiply against the dequantized weight tile via vfmacc.
 *   - vfredusum to reduce the partial sum, then scale by the Q8_0
 *     per-block fp16 scale into a double-precision accumulator.
 *
 * Cited upstream reference:
 *   ggml/src/ggml-cpu/arch/riscv/quants.c::ggml_vec_dot_q4_0_q8_0
 *   uses the same i8->i16->i32 widening shape over q8_0 codes
 *   (with the q4_0 path doing nibble unpack directly on i8).
 */

#if defined(__riscv) && defined(__riscv_v_intrinsic)

#include <math.h>
#include <stdint.h>

#include <riscv_vector.h>

#include "polarquant/polarquant.h"

/* Materialise 128 dequantized fp32 weights for one Q4_POLAR block,
 * with the inverse Hadamard + (1/QK_POLAR)*l2 scale applied.  This is
 * the loop body of polar_dequant_rvv.c lifted inline so the dot path
 * can keep the buffer hot in cache (and so a future kernel can fuse
 * across the H block without re-entering the dispatcher).
 *
 * Kept private to this TU; the public entry point lives in
 * polar_dequant_rvv.c. */
static inline void dequant_block_rvv(
    const block_q4_polar * src,
    float * buf,
    int use_qjl,
    const float * qjl_signs)
{
    /* Nibble unpack + centroid LUT lookup. */
    size_t remaining = QK_POLAR / 2;
    const uint8_t * qs = src->qs;
    float * out = buf;
    while (remaining > 0) {
        size_t vl = __riscv_vsetvl_e8m1(remaining);
        vuint8m1_t v_bytes = __riscv_vle8_v_u8m1(qs, vl);
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
        qs        += vl;
        out       += 2 * vl;
        remaining -= vl;
    }

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

    /* In-place Walsh-Hadamard butterfly. */
    for (int h = 1; h < 16; h <<= 1) {
        for (int i = 0; i < QK_POLAR; i += (h << 1)) {
            for (int j = i; j < i + h; j++) {
                const float a = buf[j];
                const float b = buf[j + h];
                buf[j]     = a + b;
                buf[j + h] = a - b;
            }
        }
    }
    for (int h = 16; h < QK_POLAR; h <<= 1) {
        for (int g = 0; g < QK_POLAR; g += (h << 1)) {
            int j = 0;
            while (j < h) {
                size_t vl = __riscv_vsetvl_e32m4((size_t)(h - j));
                vfloat32m4_t va = __riscv_vle32_v_f32m4(buf + g + j,     vl);
                vfloat32m4_t vb = __riscv_vle32_v_f32m4(buf + g + j + h, vl);
                __riscv_vse32_v_f32m4(buf + g + j,     __riscv_vfadd_vv_f32m4(va, vb, vl), vl);
                __riscv_vse32_v_f32m4(buf + g + j + h, __riscv_vfsub_vv_f32m4(va, vb, vl), vl);
                j += (int)vl;
            }
        }
    }

    const float inv_d = 1.0f / (float)QK_POLAR;
    const float l2    = polar_fp16_to_fp32(src->d);
    const float scale = inv_d * l2;
    int i = 0;
    while (i < QK_POLAR) {
        size_t vl = __riscv_vsetvl_e32m4((size_t)(QK_POLAR - i));
        vfloat32m4_t v = __riscv_vle32_v_f32m4(buf + i, vl);
        v = __riscv_vfmul_vf_f32m4(v, scale, vl);
        __riscv_vse32_v_f32m4(buf + i, v, vl);
        i += (int)vl;
    }
}

/* Per-Q8_0-chunk fused widen + dot: 32 int8 codes -> f32 partial sum
 * with the matching 32 weights from the dequantized tile.
 *
 * Returns the chunk's pre-scale dot.  The caller multiplies by the
 * Q8_0 per-block fp16 scale and folds into the running double
 * accumulator.
 *
 * We run the FMA at LMUL=m2, SEW=32, with a single m2 vector
 * accumulator across the chunk.  On any RVV 1.0 host VLEN >= 128 this
 * means QK8_0=32 is handled in at most a few vector iterations
 * (VLEN=128 -> 8 lanes/m2, 4 iters; VLEN=512 -> 32 lanes, 1 iter). */
static inline float dot_q8_chunk_rvv(
    const int8_t * codes,
    const float  * weights)
{
    /* Initialise the accumulator at the maximum VL we'll actually use
     * (= QK8_0) so the reduction at the end folds in zeros for any
     * unused lanes regardless of host VLEN. */
    size_t vl_acc = __riscv_vsetvl_e32m2((size_t)QK8_0);
    vfloat32m2_t v_acc = __riscv_vfmv_v_f_f32m2(0.0f, vl_acc);

    int processed = 0;
    while (processed < QK8_0) {
        size_t vl = __riscv_vsetvl_e32m2((size_t)(QK8_0 - processed));

        /* Load `vl` i8 codes at the matching narrow LMUL (mf2 vs m2).
         * Widen i8 -> i16 -> i32 via two vwadd.vx-with-0 steps, then
         * convert i32 -> f32 via vfcvt. */
        vint8mf2_t  v_i8  = __riscv_vle8_v_i8mf2(codes + processed, vl);
        vint16m1_t  v_i16 = __riscv_vwadd_vx_i16m1(v_i8, 0, vl);
        vint32m2_t  v_i32 = __riscv_vwadd_vx_i32m2(v_i16, 0, vl);
        vfloat32m2_t v_q  = __riscv_vfcvt_f_x_v_f32m2(v_i32, vl);
        vfloat32m2_t v_w  = __riscv_vle32_v_f32m2(weights + processed, vl);

        v_acc = __riscv_vfmacc_vv_f32m2(v_acc, v_w, v_q, vl);
        processed += (int)vl;
    }

    /* Single tree-reduction at the end of the 32-element chunk. */
    vfloat32m1_t zero = __riscv_vfmv_v_f_f32m1(0.0f, __riscv_vsetvl_e32m1(1));
    vfloat32m1_t r    = __riscv_vfredusum_vs_f32m2_f32m1(v_acc, zero, vl_acc);
    return __riscv_vfmv_f_s_f32m1_f32(r);
}

void ggml_vec_dot_q4_polar_q8_0_rvv(
    int n,
    float * s,
    const block_q4_polar * x,
    const struct block_q8_0 * y,
    int use_qjl)
{
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) {
        return;
    }

    const int nb_polar       = n / QK_POLAR;
    const int n_q8_per_polar = QK_POLAR / QK8_0; /* = 4 */

    const float * const qjl_signs = use_qjl ? polar_qjl_signs_cached() : NULL;

    float buf[QK_POLAR];
    double acc = 0.0;

    for (int b = 0; b < nb_polar; b++) {
        dequant_block_rvv(x + b, buf, use_qjl, qjl_signs);

        for (int qb = 0; qb < n_q8_per_polar; qb++) {
            const struct block_q8_0 * yb = y + b * n_q8_per_polar + qb;
            const float scale = polar_fp16_to_fp32(yb->d);
            const float * xchunk = buf + qb * QK8_0;

            const float local = dot_q8_chunk_rvv(yb->qs, xchunk);
            acc += (double)scale * (double)local;
        }
    }

    *s = (float)acc;
}

#endif /* __riscv && __riscv_v_intrinsic */

typedef int polar_dot_rvv_iso_c_translation_unit_anchor;
