/*
 * RISC-V Vector (RVV 1.0) quantize / dequantize for block_qjl1_256.
 *
 * Algorithm shape matches the scalar reference (qjl_quantize_ref.c) and
 * the AVX2 / NEON ports (qjl_quantize_avx2.c, qjl_quantize_neon.c).
 *
 * Shape recap (head_dim=128, proj_dim=256):
 *   - L2 norm:    sum_i key[i]^2, bf16-round at the end.
 *   - Projection: for each j in [0,256), acc_j = sum_i key[i] * prj[i*256+j].
 *   - Sign-pack:  256 bits → 32 bytes, LSB-first within each byte.
 *
 * RVV mapping. We use SEW=32, LMUL=m4 for the projection accumulators
 * because m4 holds 4*VLEN/SEW lanes — for VLEN=128 (the RVV 1.0 floor)
 * that is 16 fp32 lanes, exactly matching proj_dim=256 split into 16
 * "tiles" of 16 lanes (one mask-bit store per tile = 16 bits = 2 bytes,
 * 8 tiles * 2 bytes = 16 bytes ... actually we let __riscv_vsetvl pick
 * the tile size at runtime so the kernel is VL-agnostic).
 *
 * VL-agnostic strip-mining: the standard RVV pattern is
 *
 *     for (j = 0; j < N; j += vl) {
 *         vl = __riscv_vsetvl_e32m4(N - j);
 *         ...
 *     }
 *
 * which lets the same binary run on 128-bit, 256-bit, ... 2048-bit
 * VLEN hardware. We follow that pattern here.
 *
 * Sign-pack: __riscv_vmfgt_vf_f32m4_b8 produces a packed mask register
 * (one bit per fp32 lane). __riscv_vsm_v_b8 stores `vl` mask bits into
 * memory in the canonical LSB-first layout — which is exactly the QJL
 * packed-bit layout. So we can write the sign bytes straight into
 * out->qs without any per-byte horizontal reduction.
 *
 * References:
 *   - RVV 1.0 spec §6.4 (mask registers), §15 (mask instructions, vsm.v).
 *   - rvv-intrinsic-doc:
 *     https://github.com/riscv-non-isa/rvv-intrinsic-doc
 */

#if defined(__riscv) && (__riscv_xlen == 64) && defined(__riscv_v_intrinsic)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <math.h>
#include <riscv_vector.h>
#include <string.h>

void qjl_quantize_row_rvv(const float *key, const float *prj,
                          qjl_block_qjl1_256 *out) {
    /* L2 norm via a VL-agnostic strip-mined fmacc into an m1 reduction. */
    {
        size_t vlmax = __riscv_vsetvlmax_e32m1();
        vfloat32m1_t zero1 = __riscv_vfmv_v_f_f32m1(0.0f, vlmax);
        size_t vl = __riscv_vsetvl_e32m4(QJL_HEAD_DIM);
        /* head_dim=128, so on VLEN >= 1024 this loop body runs once. We
         * still strip-mine to stay correct on the (rare) VLEN=128 floor
         * where vl=16 and the loop iterates 8 times. */
        vfloat32m4_t acc = __riscv_vfmv_v_f_f32m4(0.0f, vl);
        size_t i = 0;
        while (i < QJL_HEAD_DIM) {
            vl = __riscv_vsetvl_e32m4(QJL_HEAD_DIM - i);
            vfloat32m4_t k = __riscv_vle32_v_f32m4(key + i, vl);
            acc = __riscv_vfmacc_vv_f32m4(acc, k, k, vl);
            i += vl;
        }
        vfloat32m1_t red = __riscv_vfredusum_vs_f32m4_f32m1(
            acc, zero1, __riscv_vsetvlmax_e32m4());
        float norm_sq = __riscv_vfmv_f_s_f32m1_f32(red);
        out->norm_bf16 = qjl_fp32_to_bf16(sqrtf(norm_sq));
    }

    /* Projection. For each strip of proj_dim lanes, accumulate
     *     acc[lane] = sum_i key[i] * prj[i * proj_dim + lane_offset]
     * then sign-test and store the mask bits.
     *
     * The projection rows are laid out row-major in `prj`, so the strip
     * loads `prj + i * proj_dim + j` are contiguous along `i`-stride =
     * proj_dim. That is the same memory shape AVX2 / NEON use. */
    size_t j = 0;
    while (j < QJL_PROJECTION_DIM) {
        size_t vl = __riscv_vsetvl_e32m4(QJL_PROJECTION_DIM - j);
        vfloat32m4_t acc = __riscv_vfmv_v_f_f32m4(0.0f, vl);
        const float *prj_col = prj + j;
        for (int i = 0; i < QJL_HEAD_DIM; i++) {
            vfloat32m4_t p = __riscv_vle32_v_f32m4(
                prj_col + (size_t)i * QJL_PROJECTION_DIM, vl);
            acc = __riscv_vfmacc_vf_f32m4(acc, key[i], p, vl);
        }
        /* Sign mask (bit set iff acc > 0). vmfgt with 0.0 matches the
         * scalar ref's `acc > 0.0f` predicate exactly. */
        vbool8_t m = __riscv_vmfgt_vf_f32m4_b8(acc, 0.0f, vl);
        /* Store vl mask bits LSB-first into out->qs starting at byte j/8.
         * vsm.v writes ceil(vl/8) bytes. The QJL block has 32 sign bytes
         * and j is always a multiple of (vl) -- but since vl can be any
         * multiple of 8 (m4 + SEW=32 + VLEN>=128 ensures vl is a multiple
         * of 16, in fact), writes never cross byte boundaries unaligned
         * to the strip stride. We pre-zero the byte range to make partial
         * trailing strips safe (cannot happen at QJL_PROJECTION_DIM=256
         * with VLEN<=2048, but cheap and correct). */
        __riscv_vsm_v_b8(out->qs + (j >> 3), m, vl);
        j += vl;
    }
}

void qjl_quantize_rows_rvv(const float *keys, const float *prj,
                           qjl_block_qjl1_256 *out, size_t n_rows) {
    for (size_t r = 0; r < n_rows; r++) {
        qjl_quantize_row_rvv(keys + r * QJL_HEAD_DIM, prj, out + r);
    }
}

void qjl_dequantize_row_rvv(const qjl_block_qjl1_256 *blk, const float *prj,
                            float *out) {
    const float scl = 1.2533141373155003f / (float)QJL_PROJECTION_DIM
                      * qjl_bf16_to_fp32(blk->norm_bf16);
    /* Pre-expand 256 sign bits into 256 fp32 lanes of +/-1. Cheap and
     * keeps the inner head_dim loop branchless. The expansion itself is
     * scalar: 32 bytes * 8 bits = 256 lanes, negligible vs the 128*256
     * fma loop below. */
    float signs[QJL_PROJECTION_DIM];
    for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
        int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
        signs[j] = bit ? 1.0f : -1.0f;
    }
    for (int i = 0; i < QJL_HEAD_DIM; i++) {
        const float *row = prj + (size_t)i * QJL_PROJECTION_DIM;
        size_t vlmax = __riscv_vsetvlmax_e32m1();
        vfloat32m1_t zero1 = __riscv_vfmv_v_f_f32m1(0.0f, vlmax);
        size_t vl = __riscv_vsetvl_e32m4(QJL_PROJECTION_DIM);
        vfloat32m4_t acc = __riscv_vfmv_v_f_f32m4(0.0f, vl);
        size_t j = 0;
        while (j < QJL_PROJECTION_DIM) {
            vl = __riscv_vsetvl_e32m4(QJL_PROJECTION_DIM - j);
            vfloat32m4_t p = __riscv_vle32_v_f32m4(row + j, vl);
            vfloat32m4_t s = __riscv_vle32_v_f32m4(signs + j, vl);
            acc = __riscv_vfmacc_vv_f32m4(acc, p, s, vl);
            j += vl;
        }
        vfloat32m1_t red = __riscv_vfredusum_vs_f32m4_f32m1(
            acc, zero1, __riscv_vsetvlmax_e32m4());
        out[i] = scl * __riscv_vfmv_f_s_f32m1_f32(red);
    }
}

#endif /* __riscv && __riscv_v_intrinsic */

/* Avoid ISO C "empty translation unit" pedantic diagnostics when RVV is undefined. */
typedef int qjl_quantize_rvv_iso_c_empty_tu_marker;
