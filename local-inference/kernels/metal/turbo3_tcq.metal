// DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
//
// turbo3_tcq KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Decode-only port of buun-llama-cpp's CUDA dequantize_turbo3_tcq from
// ggml/src/ggml-cuda/turbo-quant-cuda.cuh (commit 6575873e9c). The 512-state
// Viterbi ENCODE path (k_set_rows_turbo3_tcq) is intentionally omitted — it
// requires a 64×128-byte threadgroup-shared backtrace and 512 threads per
// group, which exceeds many Apple GPU threadgroup-size budgets and is
// unnecessary for the FA dot-product hot path. Encode happens host-side
// today; if/when on-device encode is needed, port the Viterbi pass in a
// separate shader.
//
// Block layout (block_turbo3_tcq in ggml-common.h, 52 bytes):
//     half  norm                 // [0..1]
//     uchar qs[49]               // [2..50]  6 prefix bits + 128 × 3-bit symbols
//     uchar pad                  // [51]
//
// Decode: state[t] = read_9_bits(qs, t*3); recon[t] = codebook[state[t]] * norm
// (matches CUDA dequantize_turbo3_tcq exactly).

#include <metal_stdlib>
using namespace metal;

struct block_turbo3_tcq {
    half     norm;
    uint8_t  qs[49];
    uint8_t  pad;
};

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 1 for d=128
    uint q_head;
    uint head_offset_bytes;
};

// Codebook supplied as a const constant buffer (2 KB). 512 entries inlined
// would also work but bloats every shader variant; binding makes it shareable.
kernel void kernel_turbo3_tcq_dot(
        device const float            * q             [[buffer(0)]],
        device const block_turbo3_tcq * k_blocks      [[buffer(1)]],
        device       float            * scores        [[buffer(2)]],
        constant     float            * codebook      [[buffer(3)]],   // 512 entries
        constant     turbo_dot_args   & args          [[buffer(4)]],
        uint                            tid           [[thread_position_in_threadgroup]],
        uint                            kv_idx        [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv) return;

    device const block_turbo3_tcq * blk =
        (device const block_turbo3_tcq *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    float norm = float(blk->norm);

    float acc = 0.0f;
    // Each thread handles 4 of 128 timesteps.
    for (uint local = 0; local < 4; ++local) {
        uint t = tid * 4 + local;            // 0..127
        uint bit_pos = t * 3;
        uint byte_idx = bit_pos >> 3;
        uint bit_off  = bit_pos & 7;
        // Two-byte window is sufficient (max bit_off + 9 = 16).
        uint b0 = blk->qs[byte_idx];
        uint b1 = (byte_idx + 1 < 49) ? blk->qs[byte_idx + 1] : 0;
        uint raw = b0 | (b1 << 8);
        uint state = (raw >> bit_off) & 0x1FF;
        float k_val = codebook[state] * norm;
        float q_val = q[args.q_head * args.head_dim + t];
        acc += q_val * k_val;
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}
