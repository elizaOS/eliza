// DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
//
// turbo4 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Companion to the in-tree patch at
// scripts/build-llama-cpp-dflash.mjs:181 (`patchMetalTurbo4`), which rewrites
// the fork's stale Metal turbo4 path to the current pure-4-bit PolarQuant
// layout (norm + qs[64], no QJL residuals).
//
// This standalone shader is for offline numerical verification: same block
// decode, same constants, isolated from the rest of the Metal library.
//
// Block layout (block_turbo4_0 in ggml-common.h, 66 bytes):
//     half     norm        // fp16 corrected norm = (norm/recon_norm) * alpha
//     uchar    qs[64]      // 4-bit indices, 2 per byte (low nibble first)
//
// Graph pre-rotates Q so we accumulate (rotated_Q · centroids) * norm.
// CUDA: dequantize_turbo4_0 in turbo-quant-cuda.cuh.

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
    uint head_offset_bytes;
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

    float acc = 0.0f;
    for (uint local = 0; local < 4; ++local) {
        uint elem = tid * 4 + local;          // 0..127
        uint qb = blk->qs[elem >> 1];
        uint idx = ((elem & 1) == 0) ? (qb & 0xF) : (qb >> 4);
        float k_val = TURBO_CENTROIDS_4BIT[idx] * norm;
        float q_val = q[args.q_head * args.head_dim + elem];
        acc += q_val * k_val;
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}
