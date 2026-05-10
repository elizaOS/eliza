// DRAFT: COMPILED locally NOT YET — agent runs on Linux without xcrun metal.
// SOURCE-LEVEL VERIFIED against the CUDA dequantize_turbo3_tcq decode path
// (sliding 9-bit window, codebook lookup) at
// ggml/src/ggml-cuda/turbo-quant-cuda.cuh and the reference C impl in
// kernels/reference/turbo_kernels.c. Hardware verification still required.
//
// turbo3_tcq KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Decode-only: the 512-state Viterbi encode path runs host-side via the
// reference C impl. Decode = read_9_bits(qs, t*3); recon = codebook[state] * norm.
//
// Block layout (block_turbo3_tcq in ggml-common.h, 52 bytes, alignment 2):
//     half  norm                 // [0..1]
//     uchar qs[49]               // [2..50]  6 prefix bits + 128 × 3-bit symbols
//     uchar pad                  // [51]
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 timesteps.

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
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo3_tcq) (52)
};

// Codebook bound at buffer(3) (512 entries = 2 KB; well under Apple's
// constant-address-space cap). Sharing as a buffer instead of inlining
// avoids 2 KB of constant memory per shader-variant baked into the library.
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
    uint q_base = args.q_head * args.head_dim + tid * 4;

    float acc = 0.0f;
    // Each thread handles 4 of 128 timesteps.
    for (uint local = 0; local < 4; ++local) {
        uint t = tid * 4 + local;            // 0..127
        uint bit_pos = t * 3;
        uint byte_idx = bit_pos >> 3;
        uint bit_off  = bit_pos & 7;
        // Two-byte window covers max bit_off + 9 = 16. The trellis stream is
        // 128*3 = 384 bits = 48 bytes; qs[] is 49 bytes (one slack byte) so
        // byte_idx + 1 is always in range — the bounds branch was dead.
        uint b0 = blk->qs[byte_idx];
        uint b1 = blk->qs[byte_idx + 1];
        uint raw = b0 | (b1 << 8);
        uint state = (raw >> bit_off) & 0x1FFu;
        float k_val = codebook[state] * norm;
        float q_val = q[q_base + local];
        acc = fma(q_val, k_val, acc);
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}

// Multi-block-per-dispatch variant. Same math as kernel_turbo3_tcq_dot; the
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

kernel void kernel_turbo3_tcq_dot_multi(
        device const float            * q             [[buffer(0)]],
        device const block_turbo3_tcq * k_blocks      [[buffer(1)]],
        device       float            * scores        [[buffer(2)]],
        constant     float            * codebook      [[buffer(3)]],
        constant     turbo_dot_multi_args & args      [[buffer(4)]],
        uint                            tid           [[thread_position_in_threadgroup]],
        uint                            tg_idx        [[threadgroup_position_in_grid]]) {
    uint q_base = args.q_head * args.head_dim + tid * 4;

    uint kv_base = tg_idx * args.blocks_per_threadgroup;
    for (uint b = 0; b < args.blocks_per_threadgroup; ++b) {
        uint kv_idx = kv_base + b;
        if (kv_idx >= args.n_kv) return;

        device const block_turbo3_tcq * blk =
            (device const block_turbo3_tcq *)((device const uchar *)k_blocks + args.head_offset_bytes)
            + kv_idx * args.kv_stride_blocks;
        float norm = float(blk->norm);

        float acc = 0.0f;
        for (uint local = 0; local < 4; ++local) {
            uint t = tid * 4 + local;
            uint bit_pos = t * 3;
            uint byte_idx = bit_pos >> 3;
            uint bit_off  = bit_pos & 7;
            uint b0 = blk->qs[byte_idx];
            uint b1 = blk->qs[byte_idx + 1];
            uint raw = b0 | (b1 << 8);
            uint state = (raw >> bit_off) & 0x1FFu;
            float k_val = codebook[state] * norm;
            float q_val = q[q_base + local];
            acc = fma(q_val, k_val, acc);
        }

        float sum = simd_sum(acc);
        if (tid == 0) {
            scores[args.q_head * args.n_kv + kv_idx] = sum;
        }
    }
}
