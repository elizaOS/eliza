// DRAFT: COMPILED locally NOT YET — agent runs on Linux without xcrun metal.
// SOURCE-LEVEL VERIFIED against the always-on patchMetalTurbo4 hook in
// scripts/build-llama-cpp-dflash.mjs (current pure-4-bit PolarQuant layout,
// no QJL residuals). Hardware verification still required —
// see packages/inference/README.md "Verification matrix".
//
// turbo4 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Block layout (block_turbo4_0 in ggml-common.h, 66 bytes, alignment 2):
//     half     norm        // fp16 corrected norm = (orig_norm/recon_norm) * alpha
//     uchar    qs[64]      // 4-bit indices, 2 per byte (low nibble first)
//
// Element decode (matches reference / Python ground truth):
//     elem 0..127:
//         qb  = qs[elem >> 1]
//         idx = (elem & 1) == 0 ? (qb & 0xF) : (qb >> 4)
//         k   = TURBO_CENTROIDS_4BIT[idx] * norm
//
// Graph pre-rotates Q so we accumulate (rotated_Q · centroids) * norm.
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 elements.

#include <metal_stdlib>
using namespace metal;

struct block_turbo4_0 {
    half     norm;
    uint8_t  qs[64];
};

constant float TURBO_CENTROIDS_4BIT[16] = {
    -0.241556f, -0.182907f, -0.143047f, -0.111065f,
    -0.083317f, -0.058069f, -0.034311f, -0.011353f,
     0.011353f,  0.034311f,  0.058069f,  0.083317f,
     0.111065f,  0.143047f,  0.182907f,  0.241556f,
};

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 1 for d=128 (one block IS the group)
    uint q_head;
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo4_0) (66)
};

kernel void kernel_turbo4_dot(
        device const float          * q             [[buffer(0)]],
        device const block_turbo4_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_args & args          [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          kv_idx        [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv) return;

    device const block_turbo4_0 * blk =
        (device const block_turbo4_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    float norm = float(blk->norm);

    // Each thread's 4 elements (tid*4 + 0..3) consume two consecutive qs[]
    // bytes (a low-nibble + high-nibble pair per byte). Load those two bytes
    // up front and pull the four nibbles out branchlessly via a shift+mask
    // (`(qb >> ((elem & 1) << 2)) & 0xF`), which avoids the conditional in
    // the inner loop and keeps the dependency chain on `acc` short.
    uint elem0  = tid * 4;
    uint qb_lo  = blk->qs[(elem0 >> 1)];      // covers elem0, elem0+1
    uint qb_hi  = blk->qs[(elem0 >> 1) + 1];  // covers elem0+2, elem0+3
    uint q_base = args.q_head * args.head_dim + elem0;

    float acc = 0.0f;
    for (uint local = 0; local < 4; ++local) {
        uint qb  = (local < 2) ? qb_lo : qb_hi;
        uint sh  = ((local & 1) << 2);            // 0 or 4
        uint idx = (qb >> sh) & 0xFu;
        float k_val = TURBO_CENTROIDS_4BIT[idx] * norm;
        float q_val = q[q_base + local];
        acc = fma(q_val, k_val, acc);
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}
