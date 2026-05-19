// HARDWARE VERIFIED on Apple M4 Max (Metal runtime JIT): standalone fixture
// harness plus built-fork GGML_OP_ATTN_SCORE_TBQ graph dispatch.
// Source-level verified against fork block_tbq4_0 in ggml-common.h.
//
// turbo4 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Block layout (block_tbq4_0 in ggml-common.h, 18 bytes, alignment 2):
//     half     norm        // block RMS after TurboQuant preconditioning
//     uchar    qs[16]      // 4-bit indices packed like q4_0
//
// Element decode (matches reference / Python ground truth):
//     elem 0..31 within a 32-element block:
//         qb  = qs[elem & 15]
//         idx = elem < 16 ? (qb & 0xF) : (qb >> 4)
//         k   = TURBO_CENTROIDS_4BIT[idx] * norm
//
// Four 32-element blocks form one 128-element attention row. Graph pre-rotates
// Q, so the shader accumulates directly against the stored rotated codes.
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 elements.

#include <metal_stdlib>
using namespace metal;

struct block_turbo4_0 {
    half     norm;
    uint8_t  qs[16];
};

constant float TURBO_CENTROIDS_4BIT[16] = {
    -2.7321365f, -2.0685055f, -1.6175243f, -1.2557391f,
    -0.9419147f, -0.6564307f, -0.3878412f, -0.1283243f,
     0.1283243f,  0.3878412f,  0.6564307f,  0.9419147f,
     1.2557391f,  1.6175243f,  2.0685055f,  2.7321365f,
};

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 4 for d=128 (4 blocks per group)
    uint q_head;
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo4_0) (18)
};

kernel void kernel_turbo4_dot(
        device const float          * q             [[buffer(0)]],
        device const block_turbo4_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_args & args          [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          kv_idx        [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv) return;

    device const block_turbo4_0 * grp =
        (device const block_turbo4_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;
    uint elem0   = tid * 4;
    uint blk_idx = elem0 >> 5;
    uint within0 = elem0 & 31;
    device const block_turbo4_0 & blk = grp[blk_idx];
    float norm = float(blk.norm);
    uint q_base = args.q_head * args.head_dim + elem0;

    device const float4 * q4 = (device const float4 *)(q + q_base);
    float4 qv = q4[0];
    uint qb0 = blk.qs[(within0 + 0u) & 15u];
    uint qb1 = blk.qs[(within0 + 1u) & 15u];
    uint qb2 = blk.qs[(within0 + 2u) & 15u];
    uint qb3 = blk.qs[(within0 + 3u) & 15u];
    bool hi = within0 >= 16u;
    uint idx0 = hi ? (qb0 >> 4) : (qb0 & 0xFu);
    uint idx1 = hi ? (qb1 >> 4) : (qb1 & 0xFu);
    uint idx2 = hi ? (qb2 >> 4) : (qb2 & 0xFu);
    uint idx3 = hi ? (qb3 >> 4) : (qb3 & 0xFu);
    float4 kv = float4(
        TURBO_CENTROIDS_4BIT[idx0],
        TURBO_CENTROIDS_4BIT[idx1],
        TURBO_CENTROIDS_4BIT[idx2],
        TURBO_CENTROIDS_4BIT[idx3]) * norm;
    float acc = dot(qv, kv);

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}

// Multi-block-per-dispatch variant. Same math as kernel_turbo4_dot; the
// threadgroup processes `blocks_per_threadgroup` consecutive KV indices in a
// 32-thread serial loop to amortise dispatch launch tax.
struct turbo_dot_multi_args {
    uint head_dim;
    uint n_kv;
    uint kv_stride_blocks;
    uint q_head;
    uint head_offset_bytes;
    uint blocks_per_threadgroup;
};

kernel void kernel_turbo4_dot_multi(
        device const float          * q             [[buffer(0)]],
        device const block_turbo4_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_multi_args & args    [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          tg_idx        [[threadgroup_position_in_grid]]) {
    uint elem0   = tid * 4;
    uint blk_idx = elem0 >> 5;
    uint within0 = elem0 & 31;
    uint q_base  = args.q_head * args.head_dim + elem0;
    device const float4 * q4 = (device const float4 *)(q + q_base);
    float4 qv = q4[0];

    uint kv_base = tg_idx * args.blocks_per_threadgroup;
    for (uint b = 0; b < args.blocks_per_threadgroup; ++b) {
        uint kv_idx = kv_base + b;
        if (kv_idx >= args.n_kv) return;

        device const block_turbo4_0 * grp =
            (device const block_turbo4_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
            + kv_idx * args.kv_stride_blocks;
        device const block_turbo4_0 & blk = grp[blk_idx];
        float norm = float(blk.norm);

        uint qb0 = blk.qs[(within0 + 0u) & 15u];
        uint qb1 = blk.qs[(within0 + 1u) & 15u];
        uint qb2 = blk.qs[(within0 + 2u) & 15u];
        uint qb3 = blk.qs[(within0 + 3u) & 15u];
        bool hi = within0 >= 16u;
        uint idx0 = hi ? (qb0 >> 4) : (qb0 & 0xFu);
        uint idx1 = hi ? (qb1 >> 4) : (qb1 & 0xFu);
        uint idx2 = hi ? (qb2 >> 4) : (qb2 & 0xFu);
        uint idx3 = hi ? (qb3 >> 4) : (qb3 & 0xFu);
        float4 kv = float4(
            TURBO_CENTROIDS_4BIT[idx0],
            TURBO_CENTROIDS_4BIT[idx1],
            TURBO_CENTROIDS_4BIT[idx2],
            TURBO_CENTROIDS_4BIT[idx3]) * norm;
        float acc = dot(qv, kv);

        float sum = simd_sum(acc);
        if (tid == 0) {
            scores[args.q_head * args.n_kv + kv_idx] = sum;
        }
    }
}
