// AUTHORED — hardware-verify pending (no Apple HW on the authoring machine).
//
// kernel_attn_score_q4_polar_preht_f32 (+ _multi) — Polar V-cache score against
// a pre-Hadamarded query, in the attention-score ABI (q_head / n_kv /
// head_offset semantics), as opposed to the mat-vec ABI of
// kernel_mul_mv_q4_polar_preht_f32 in polar.metal. Uses the identity
//
//     dot(H*x, q) == dot(x, H*q)
//
// where H is the unnormalised 128-point Walsh-Hadamard transform the Polar
// decoder applies per K row. The caller supplies q_preht = H*q, so this kernel
// never runs the per-K-row butterfly. Numerically identical (within the 1e-3
// fixture tolerance) to eliza_polar_mul_mv / kernel_mul_mv_q4_polar_f32 — the
// ×(norm/128) scalar is applied once after the simd reduction; the residual is
// NOT folded into the LUT and the centroid constants are unchanged.
//
// See reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md
// Part 1; the Vulkan sibling is vulkan/polar_preht.comp (hardware-verified on
// Intel ARL Mesa ANV + Apple M4 Max via MoltenVK).
//
// DO NOT route this kernel behind an existing raw-q Polar graph dispatch — the
// q buffer must already contain H*q (manifest `polar_q_pretransform:
// "hadamard128"`) or the result is mathematically wrong.

#include <metal_stdlib>
using namespace metal;

#define QK_POLAR             128
#define QJL_RESIDUAL_BYTES   (QK_POLAR / 8)
#define POLAR_Q4_N_LEVELS    16

constant float POLAR_QJL_CORRECTION_MAGNITUDE = 0.5f;
constant float POLAR_QJL_INV_SQRT_QK = 0.08838834764831845f;   // 1/sqrt(128)
constant float POLAR_INV_QK = 1.0f / float(QK_POLAR);          // (1 / QK_POLAR) Hadamard compensation

// Bit-identical to POLAR_Q4_CENTROIDS in polarquant-cpu/include/polarquant/polar_centroids.h.
constant float POLAR_Q4_CENTROIDS[POLAR_Q4_N_LEVELS] = {
    -2.754354807f, -2.093562707f, -1.643041510f, -1.279739752f,
    -0.962640978f, -0.672392117f, -0.397897103f, -0.131757782f,
     0.131757782f,  0.397897103f,  0.672392117f,  0.962640978f,
     1.279739752f,  1.643041510f,  2.093562707f,  2.754354807f,
};
// xorshift32(seed=42) sign vector for the optional Polar QJL residual.
constant float POLAR_QJL_SIGNS[QK_POLAR] = {
    -1.0f, -1.0f,  1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f,
     1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,  1.0f,
    -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f, -1.0f,
    -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f, -1.0f, -1.0f,
    -1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,
    -1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f,
     1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,  1.0f,
     1.0f,  1.0f, -1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,
     1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f,  1.0f,
    -1.0f, -1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f, -1.0f,
     1.0f, -1.0f, -1.0f,  1.0f,  1.0f,  1.0f,  1.0f, -1.0f,
    -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,  1.0f,
     1.0f, -1.0f, -1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,
    -1.0f,  1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,
     1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,
     1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,
};

struct block_q4_polar {
    half     d;
    uint8_t  qs[QK_POLAR / 2];
    uint8_t  qjl[QJL_RESIDUAL_BYTES];
};

struct polar_score_args {
    uint head_dim;          // must equal QK_POLAR (128)
    uint n_kv;              // number of Polar V-blocks (one per token) for this head
    uint kv_stride_blocks;  // 1 for head_dim=128 (one 128-elem block per token)
    uint q_head;            // which query head's pre-Hadamarded row to read
    uint head_offset_bytes; // byte offset into k_blocks for this KV head; multiple of 82
    uint use_qjl;           // 0 / 1 — whether the block's qjl[] residual is meaningful
};

// One lane's contribution to <decoded(blk), q_preht>: 4 centroid codes (2 bytes)
// per stride step, fp32 accumulate, residual added before the dot if use_qjl.
static inline float polar_preht_lane_acc(
        device const block_q4_polar * blk,
        device const float * qp,
        uint use_qjl, uint tid) {
    float acc = 0.0f;
    for (uint b = tid; b < QK_POLAR / 2u; b += 32u) {
        uint8_t byte = blk->qs[b];
        uint i0 = 2u * b, i1 = i0 + 1u;
        float x0 = POLAR_Q4_CENTROIDS[byte & 0xFu];
        float x1 = POLAR_Q4_CENTROIDS[(byte >> 4) & 0xFu];
        if (use_qjl != 0u) {
            float scaled = ((blk->qjl[0] & 1u) ? 1.0f : -1.0f)
                         * POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
            x0 += scaled * POLAR_QJL_SIGNS[i0];
            x1 += scaled * POLAR_QJL_SIGNS[i1];
        }
        acc = fma(x0, qp[i0], acc);
        acc = fma(x1, qp[i1], acc);
    }
    return acc;
}

kernel void kernel_attn_score_q4_polar_preht_f32(
        device const float          * q_preht  [[buffer(0)]],   // (n_heads, head_dim) fp32 = H*q
        device const block_q4_polar * k_blocks [[buffer(1)]],   // (n_kv_heads, n_kv) row-major
        device       float          * scores   [[buffer(2)]],   // (n_heads, n_kv) fp32
        constant     polar_score_args & args    [[buffer(3)]],
        uint                            tid      [[thread_position_in_threadgroup]],
        uint                            kv_idx   [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv || args.head_dim != QK_POLAR) return;
    device const block_q4_polar * blk =
        (device const block_q4_polar *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;
    device const float * qp = q_preht + args.q_head * QK_POLAR;

    float acc = polar_preht_lane_acc(blk, qp, args.use_qjl, tid);
    float sum = simd_sum(acc);              // threadgroup == one 32-lane SIMD-group
    if (tid == 0u) scores[args.q_head * args.n_kv + kv_idx] = sum * float(blk->d) * POLAR_INV_QK;
}

// Multi-block-per-dispatch variant — the threadgroup processes
// `blocks_per_threadgroup` consecutive KV indices serially in a 32-thread loop,
// trading dispatch grid breadth for amortised launch tax. Bench shape:
//     grid_x = ceil(n_kv / blocks_per_threadgroup); tg_x = 32
struct polar_score_multi_args {
    uint head_dim;
    uint n_kv;
    uint kv_stride_blocks;
    uint q_head;
    uint head_offset_bytes;
    uint use_qjl;
    uint blocks_per_threadgroup;
};

kernel void kernel_attn_score_q4_polar_preht_f32_multi(
        device const float          * q_preht  [[buffer(0)]],
        device const block_q4_polar * k_blocks [[buffer(1)]],
        device       float          * scores   [[buffer(2)]],
        constant     polar_score_multi_args & args [[buffer(3)]],
        uint                            tid      [[thread_position_in_threadgroup]],
        uint                            tg_idx   [[threadgroup_position_in_grid]]) {
    if (args.head_dim != QK_POLAR) return;
    device const float * qp = q_preht + args.q_head * QK_POLAR;
    uint kv_base = tg_idx * args.blocks_per_threadgroup;
    for (uint b = 0u; b < args.blocks_per_threadgroup; ++b) {
        uint kv_idx = kv_base + b;
        if (kv_idx >= args.n_kv) return;
        device const block_q4_polar * blk =
            (device const block_q4_polar *)((device const uchar *)k_blocks + args.head_offset_bytes)
            + kv_idx * args.kv_stride_blocks;
        float acc = polar_preht_lane_acc(blk, qp, args.use_qjl, tid);
        float sum = simd_sum(acc);
        if (tid == 0u) scores[args.q_head * args.n_kv + kv_idx] = sum * float(blk->d) * POLAR_INV_QK;
    }
}
