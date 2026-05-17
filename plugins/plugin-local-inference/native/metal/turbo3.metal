// HARDWARE VERIFIED on Apple M4 Max (Metal runtime JIT): 8/8 PASS against the
// fixture harness. Source-level verified against fork's dequantize_turbo3_0_t4
// at ggml/src/ggml-metal/ggml-metal.metal:700 (commit 6575873e9c).
//
// turbo3 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Ports buun-llama-cpp's CUDA dequantize_turbo3_0 from
// ggml/src/ggml-cuda/turbo-quant-cuda.cuh and matches the fork's Metal
// dequantize_turbo3_0_t4 byte-for-byte.
//
// Block layout (block_turbo3_0 in ggml-common.h, 14 bytes):
//     half  norm                 // [0..1]   fp16 corrected group norm
//     uchar qs[8]                // [2..9]   QK_TURBO3/4 = 8 bytes (4 elements per byte, low 2 bits)
//     uchar signs[4]             // [10..13] QK_TURBO3/8 = 4 bytes (1 sign-bit per element)
//
// Element decode (matches fork's _t4 path):
//     elem 0..31 within a 32-element block:
//         qb  = qs[elem >> 2]                           // 4 elements per byte
//         low2 = (qb >> ((elem & 3) * 2)) & 0x3
//         sb  = signs[elem >> 3]                        // 1 bit per element
//         hi1 = (sb >> (elem & 7)) & 0x1
//         idx = low2 | (hi1 << 2)                       // full 3-bit index
//         k   = TURBO_CENTROIDS_3BIT[idx] * norm
//
// Four 32-element blocks form one 128-element rotation group.
//
// CORRECTNESS: TurboQuant stores k as `precondition(k_raw) = H32(sign .* k_raw)`
// (see tbq_precondition_block in ggml-quants.c). The canonical attention
// score is <q, k_raw>, so the shader needs to "uncondition" the dequantized
// k before the dot product. Earlier versions of this kernel skipped that
// step on the assumption that the graph would pre-rotate Q externally; that
// assumption was wrong (the model graph never inserted a Hadamard on q for
// ATTN_SCORE_TBQ), which caused the parity tests in test-backend-ops.cpp to
// observe NMSE ~62 / ~2.4 / ~75 vs the CPU reference at
// ggml-cpu/attn-score-tbq-polar.c. By the symmetry
//     <q, sign .* H32(k_raw)> = <H32(q .* sign), k_raw>
// we precompute q_t = H32(q .* sign) once per kernel launch (4 blocks of
// 32 in threadgroup memory) and dot against the raw codebook-decoded k
// for each KV index. That matches the CPU output within fp16 tolerance.
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 elements and
// the per-threadgroup reduction is a single simd_sum.

#include <metal_stdlib>
using namespace metal;

// Match block_turbo3_0 layout exactly (14 bytes, alignment 2).
struct block_turbo3_0 {
    half     norm;
    uint8_t  qs[8];
    uint8_t  signs[4];
};

constant float TURBO_CENTROIDS_3BIT[8] = {
    -0.190685f, -0.117832f, -0.065717f, -0.021460f,
     0.021460f,  0.065717f,  0.117832f,  0.190685f,
};

// Per-block (QK_TBQ=32) sign vector from k_tbq_signs in ggml-quants.c.
// Used by the precompute pass to flip q before the per-block Hadamard.
constant int K_TBQ_SIGNS[32] = {
     1, -1,  1,  1, -1,  1, -1, -1,
     1,  1, -1,  1, -1, -1,  1, -1,
    -1,  1,  1, -1,  1, -1, -1,  1,
     1, -1,  1, -1, -1,  1, -1,  1,
};

// Fill q_t_shared[0..127] with H32(q .* sign) per 32-element block.
// Threadgroup size MUST be 32. Each of the 32 threads writes 4 raw
// (q .* sign) values into shared memory at elem0=tid*4, then threads 0..3
// each drive an in-place serial Hadamard32 over one of the four blocks.
static void eliza_tbq_precompute_qt(
        threadgroup float * q_t_shared,
        device const float * q,
        uint q_head,
        uint head_dim,
        uint tid) {
    uint elem0 = tid * 4u;
    uint within0 = elem0 & 31u;
    uint q_base = q_head * head_dim + elem0;
    device const float4 * q4 = (device const float4 *)(q + q_base);
    float4 qv_raw = q4[0];
    float4 sv = float4(
        (float) K_TBQ_SIGNS[within0 + 0u],
        (float) K_TBQ_SIGNS[within0 + 1u],
        (float) K_TBQ_SIGNS[within0 + 2u],
        (float) K_TBQ_SIGNS[within0 + 3u]);
    float4 qs = qv_raw * sv;
    q_t_shared[elem0 + 0u] = qs.x;
    q_t_shared[elem0 + 1u] = qs.y;
    q_t_shared[elem0 + 2u] = qs.z;
    q_t_shared[elem0 + 3u] = qs.w;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    if (tid < 4u) {
        uint b = tid;
        threadgroup float * blk = q_t_shared + b * 32u;
        for (uint len = 1u; len < 32u; len <<= 1) {
            for (uint i = 0u; i < 32u; i += 2u * len) {
                for (uint j = 0u; j < len; ++j) {
                    float a  = blk[i + j];
                    float bv = blk[i + j + len];
                    blk[i + j]       = a + bv;
                    blk[i + j + len] = a - bv;
                }
            }
        }
        const float hnorm = 0.1767766952966369f;
        for (uint i = 0u; i < 32u; ++i) {
            blk[i] *= hnorm;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
}

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 4 for d=128 (4 blocks per group)
    uint q_head;
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo3_0) (14)
};

kernel void kernel_turbo3_dot(
        device const float          * q             [[buffer(0)]],
        device const block_turbo3_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_args & args          [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          kv_idx        [[threadgroup_position_in_grid]]) {
    // 32 threads × 4 elements = 128 head_dim entries. Each thread's 4 elements
    // (tid*4 + 0..3) lie wholly within ONE 32-element block (since 32 is a
    // multiple of 4 and tid*4 ∈ {0,4,...,124}).
    uint elem0   = tid * 4u;                       // 0,4,...,124
    uint blk_idx = elem0 >> 5;                     // 0..3
    uint within0 = elem0 & 31u;                    // 0,4,...,28

    // Precompute q_t = H32(q .* sign) per block once per launch. All threads
    // participate; threadgroup_barrier inside the helper makes q_t visible.
    threadgroup float q_t_shared[128];
    eliza_tbq_precompute_qt(q_t_shared, q, args.q_head, args.head_dim, tid);

    if (kv_idx >= args.n_kv) return;

    // Resolve the 4-block group for this KV index. Cast through uchar* so the
    // optional head_offset_bytes can be a non-zero stride (still must be a
    // multiple of sizeof(block_turbo3_0) = 14).
    device const block_turbo3_0 * grp =
        (device const block_turbo3_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    device const block_turbo3_0 & blk = grp[blk_idx];
    float norm = float(blk.norm);
    // All four elements of this thread share the same qs[] byte (within>>2 is
    // constant for within = within0..within0+3) and the same signs[] byte
    // (within>>3 is constant for within = within0..within0+3).
    uint qb = blk.qs[within0 >> 2];
    uint sb = blk.signs[within0 >> 3];

    float4 qt = float4(
        q_t_shared[elem0 + 0u],
        q_t_shared[elem0 + 1u],
        q_t_shared[elem0 + 2u],
        q_t_shared[elem0 + 3u]);
    uint sign_shift = within0 & 7u;
    uint idx0 = ((qb >> 0) & 0x3u) | (((sb >> (sign_shift + 0u)) & 0x1u) << 2);
    uint idx1 = ((qb >> 2) & 0x3u) | (((sb >> (sign_shift + 1u)) & 0x1u) << 2);
    uint idx2 = ((qb >> 4) & 0x3u) | (((sb >> (sign_shift + 2u)) & 0x1u) << 2);
    uint idx3 = ((qb >> 6) & 0x3u) | (((sb >> (sign_shift + 3u)) & 0x1u) << 2);
    float4 kv = float4(
        TURBO_CENTROIDS_3BIT[idx0],
        TURBO_CENTROIDS_3BIT[idx1],
        TURBO_CENTROIDS_3BIT[idx2],
        TURBO_CENTROIDS_3BIT[idx3]) * norm;
    float acc = dot(qt, kv);

    // Threadgroup reduction. With threadgroup size == SIMD-group size == 32,
    // simd_sum returns the full 128-element dot product to every lane and lane
    // 0 writes the result. If the dispatch ever uses a larger threadgroup,
    // this needs to switch to threadgroup-shared storage + barrier.
    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}

// Multi-block-per-dispatch variant. Identical math; the threadgroup processes
// `blocks_per_threadgroup` consecutive KV indices serially in a 32-thread loop,
// trading dispatch grid breadth for amortised launch tax. Bench shape:
//
//     grid_x = ceil(n_kv / blocks_per_threadgroup)
//     tg_x   = 32
//
// `args.q_head` / `args.head_offset_bytes` semantics unchanged. The shader
// derives the absolute kv index from `tg_pos.x * blocks_per_threadgroup + b`
// where `b` is the inner loop counter.
struct turbo_dot_multi_args {
    uint head_dim;
    uint n_kv;
    uint kv_stride_blocks;
    uint q_head;
    uint head_offset_bytes;
    uint blocks_per_threadgroup;
};

kernel void kernel_turbo3_dot_multi(
        device const float          * q             [[buffer(0)]],
        device const block_turbo3_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_multi_args & args    [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          tg_idx        [[threadgroup_position_in_grid]]) {
    uint elem0   = tid * 4u;
    uint blk_idx = elem0 >> 5;
    uint within0 = elem0 & 31u;

    // Precompute q_t = H32(q .* sign) per block, amortised across all KV
    // indices this threadgroup processes.
    threadgroup float q_t_shared[128];
    eliza_tbq_precompute_qt(q_t_shared, q, args.q_head, args.head_dim, tid);

    float4 qt = float4(
        q_t_shared[elem0 + 0u],
        q_t_shared[elem0 + 1u],
        q_t_shared[elem0 + 2u],
        q_t_shared[elem0 + 3u]);

    uint kv_base = tg_idx * args.blocks_per_threadgroup;
    for (uint b = 0; b < args.blocks_per_threadgroup; ++b) {
        uint kv_idx = kv_base + b;
        if (kv_idx >= args.n_kv) return;

        device const block_turbo3_0 * grp =
            (device const block_turbo3_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
            + kv_idx * args.kv_stride_blocks;
        device const block_turbo3_0 & blk = grp[blk_idx];
        float norm = float(blk.norm);
        uint qb = blk.qs[within0 >> 2];
        uint sb = blk.signs[within0 >> 3];

        uint sign_shift = within0 & 7u;
        uint idx0 = ((qb >> 0) & 0x3u) | (((sb >> (sign_shift + 0u)) & 0x1u) << 2);
        uint idx1 = ((qb >> 2) & 0x3u) | (((sb >> (sign_shift + 1u)) & 0x1u) << 2);
        uint idx2 = ((qb >> 4) & 0x3u) | (((sb >> (sign_shift + 2u)) & 0x1u) << 2);
        uint idx3 = ((qb >> 6) & 0x3u) | (((sb >> (sign_shift + 3u)) & 0x1u) << 2);
        float4 kv = float4(
            TURBO_CENTROIDS_3BIT[idx0],
            TURBO_CENTROIDS_3BIT[idx1],
            TURBO_CENTROIDS_3BIT[idx2],
            TURBO_CENTROIDS_3BIT[idx3]) * norm;
        float acc = dot(qt, kv);

        float sum = simd_sum(acc);
        if (tid == 0) {
            scores[args.q_head * args.n_kv + kv_idx] = sum;
        }
    }
}
