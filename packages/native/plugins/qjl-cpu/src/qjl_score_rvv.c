/*
 * RISC-V Vector (RVV 1.0) GQA attention-score kernel (fp32 sketch).
 *
 * Algorithm shape matches qjl_score_ref.c and qjl_score_neon.c:
 *
 *   score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim *
 *                   sum_j (2 * bit_packed[t, j] - 1) * q_sketch[h_q, j]
 *
 * Implementation strategy:
 *
 * The "obvious" approach (NEON-style) is to expand each byte of the
 * packed signs into 8 fp32 +/-1 lanes, FMA against the matching 8 fp32
 * lanes of q_sketch, accumulate, reduce. That works but on RVV the bit
 * expansion is awkward — there is no direct "load 8 bits into 8 lanes
 * of +/-1" primitive.
 *
 * A cleaner RVV idiom: load the 256-bit sign vector once into a mask
 * register via __riscv_vlm_v_b8 (mask load from memory, LSB-first byte
 * layout — exactly the QJL packed-bit layout), then for each strip of
 * the q_sketch use vfneg under the inverted mask to flip the sign of
 * lanes whose bit is 0. That gives us a vector of signed q values to
 * FMA against an accumulator, in one mask-merge instruction per strip.
 *
 * vfneg has a tail-undisturbed / mask-undisturbed semantics; we use
 * __riscv_vfneg_v_f32m8_m to negate only the masked-off (bit=0) lanes
 * and leave the bit=1 lanes intact. Since the mask register holds
 * proj_dim=256 bits and we strip across the same axis, the mask slice
 * for the current strip is auto-selected by vl.
 *
 * LMUL m8 is used here for f32 to maximize throughput on wide-VLEN
 * implementations: on VLEN=2048 this is 64 fp32 lanes per strip,
 * covering proj_dim=256 in 4 strips. m8 leaves no spare LMUL groups
 * for the accumulator since v0 is the mask — that's fine, we keep
 * the mask in v0 and the accumulator in a m8 register group.
 *
 * Reduction across strips: per (h_q, t) we maintain one m1 partial
 * sum, accumulated via __riscv_vfredusum_vs_f32m8_f32m1 outside the
 * strip loop (or, to keep the inner loop tight, accumulate in m8 and
 * reduce once at the end — see the implementation below).
 *
 * Reduction order vs scalar: RVV's vfredusum has implementation-defined
 * intermediate ordering (tree-shaped on most hardware), so the result
 * is not bit-identical to the scalar left-to-right sum. The error is
 * bounded by ~ULP * proj_dim and we test against a 1e-4 absolute
 * tolerance (same as the AVX2 path — see qjl_bench --parity).
 */

#if defined(__riscv) && (__riscv_xlen == 64) && defined(__riscv_v_intrinsic)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <riscv_vector.h>

void qjl_score_qk_rvv(const float *q_sketch,
                      const qjl_block_qjl1_256 *packed_k,
                      int n_heads, int n_kv_heads, int n_tokens,
                      float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    /* m1 zero reduction-init, reused across (h_q, t). */
    size_t vl1 = __riscv_vsetvlmax_e32m1();
    vfloat32m1_t zero1 = __riscv_vfmv_v_f_f32m1(0.0f, vl1);

    for (int hq = 0; hq < n_heads; hq++) {
        int hk = hq / gqa;
        const float *qs = q_sketch + (size_t)hq * QJL_PROJECTION_DIM;

        for (int t = 0; t < n_tokens; t++) {
            const qjl_block_qjl1_256 *blk = packed_k + (size_t)hk * n_tokens + t;

            /* Strip-mine proj_dim=256 with LMUL m8 (SEW=32). The mask
             * register for the strip is loaded from the matching slice
             * of blk->qs via vlm.v. */
            size_t j = 0;
            /* Tail-accumulator: we sum the per-strip reductions in
             * scalar `dot` to keep the inner FMA dependency chain on a
             * single m8 register group. An alternative is to keep the
             * accumulator across strips at LMUL=m8 -- equivalent latency
             * on most hardware. */
            float dot = 0.0f;
            while (j < QJL_PROJECTION_DIM) {
                size_t vl = __riscv_vsetvl_e32m8(QJL_PROJECTION_DIM - j);
                /* Load the bit-slice of `blk->qs` covering lanes [j, j+vl).
                 * vlm.v reads ceil(vl/8) bytes starting at the byte offset
                 * j/8. The mask lives in v0 (and adjacent regs depending
                 * on the implementation). */
                vbool4_t m = __riscv_vlm_v_b4(blk->qs + (j >> 3), vl);
                vfloat32m8_t q = __riscv_vle32_v_f32m8(qs + j, vl);
                /* Where bit=1, lane holds +q. Where bit=0, lane holds -q.
                 * vfneg under the *inverse* mask: vfneg_v_..._m flips the
                 * sign of lanes for which the mask bit is 1. So we want
                 * the mask to be set where bit=0. RVV provides vmnot
                 * (mask-bit invert) but a simpler idiom is to negate
                 * where bit=0 by using the not-mask. We compute the
                 * not-mask via __riscv_vmnot_m_b4. */
                vbool4_t nm = __riscv_vmnot_m_b4(m, vl);
                vfloat32m8_t signed_q = __riscv_vfneg_v_f32m8_m(nm, q, vl);
                /* Reduce this strip into the partial sum. */
                vfloat32m1_t s = __riscv_vfredusum_vs_f32m8_f32m1(
                    signed_q, zero1, vl);
                dot += __riscv_vfmv_f_s_f32m1_f32(s);
                j += vl;
            }
            float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[(size_t)hq * n_tokens + t] = scl_base * norm_k * dot;
        }
    }
}

#endif /* __riscv && __riscv_v_intrinsic */

/* Avoid ISO C "empty translation unit" pedantic diagnostics when RVV is undefined. */
typedef int qjl_score_rvv_iso_c_empty_tu_marker;
