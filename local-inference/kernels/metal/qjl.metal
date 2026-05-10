// DRAFT: COMPILED locally NOT YET — agent runs on Linux without xcrun metal.
// SOURCE-LEVEL VERIFIED against the QJL CPU reference at
// packages/native-plugins/qjl-cpu/src/qjl_score_ref.c (W1-A's authoritative
// CPU side). The block layout (`block_qjl1_256`) and score formula
// (||k|| * sqrt(pi/2)/proj_dim * sum_j sign(j)*q_sketch[j]) are bit-identical.
//
// Hardware verification still required — see
// local-inference/kernels/README.md "Verification matrix".
//
// QJL = K-side compression: store sign(Π·k) packed 8-per-byte plus per-token
// bf16 norm. Q is sketched once via the same Π and the score per
// (q_head, token) is reconstructed from the packed signs.
//
// Block layout (block_qjl1_256, 34 bytes, alignment 2):
//     uchar qs[32]               // 256 sign bits, LSB = bit 0 of byte 0
//     ushort norm_bf16           // bf16 storage of ||k||_2
//
// Total compressed bits/element at head_dim=128: 34*8 / 128 = 2.125 bpw,
// 7.53× vs bf16 K-cache.
//
// Three kernels:
//   - kernel_get_rows_qjl1_256  : decode signs * Π reconstruction (used by
//                                  the dequant fallback path; not the hot path).
//   - kernel_mul_mv_qjl1_256_f32: matrix-vector multiply against an fp32
//                                  query, for non-attention call sites.
//   - kernel_attn_score_qjl1_256: the attention-score hot path; consumes a
//                                  pre-projected query sketch and emits
//                                  scores[h_q, t] directly.

#include <metal_stdlib>
using namespace metal;

#define QJL_HEAD_DIM        128
#define QJL_PROJECTION_DIM  256
#define QJL_PACKED_BYTES    32   // 256 / 8

struct block_qjl1_256 {
    uint8_t  qs[QJL_PACKED_BYTES];
    ushort   norm_bf16;
};

// bf16 -> fp32 zero-extension (matches qjl_bf16_to_fp32 in qjl-cpu).
static inline float qjl_bf16_to_fp32(ushort b) {
    uint u = ((uint)b) << 16;
    return as_type<float>(u);
}

// sqrt(pi/2) — matches CUDA score kernel line 175 and qjl_score_qk_ref's
// scl_base = 1.2533141373155003f / proj_dim.
constant float QJL_SQRT_HALF_PI = 1.2533141373155003f;
constant float QJL_SCORE_SCALE  = 1.2533141373155003f / float(QJL_PROJECTION_DIM);

// ---------- attention score (hot path) ----------
//
// score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim * sum_j sign_packed[t,j] * q_sketch[h_q, j]
//
// Inputs:
//   q_sketch    : (n_heads, proj_dim) fp32, pre-projected query
//   packed_k    : (n_kv_heads, n_tokens, block_qjl1_256), row-major
//   scores      : (n_heads, n_tokens) fp32 output
//
// args.n_heads / args.n_kv_heads encode the GQA fanout: h_kv = h_q / (n_heads/n_kv_heads).
//
// Dispatch: one threadgroup per (h_q, t). Threadgroup size = 32 (one Apple
// SIMD-group). Each thread handles 256/32 = 8 of the 256 projection bits.

struct qjl_score_args {
    uint n_heads;       // total query heads
    uint n_kv_heads;    // KV heads (n_heads / n_kv_heads = GQA factor, >= 1)
    uint n_tokens;      // sequence length being scored
    uint proj_dim;      // must equal 256
};

kernel void kernel_attn_score_qjl1_256(
        device const float          * q_sketch     [[buffer(0)]],   // (n_heads, proj_dim)
        device const block_qjl1_256 * packed_k     [[buffer(1)]],   // (n_kv_heads, n_tokens)
        device       float          * scores       [[buffer(2)]],   // (n_heads, n_tokens)
        constant     qjl_score_args & args         [[buffer(3)]],
        uint                          tid          [[thread_position_in_threadgroup]],
        uint2                         tg_pos       [[threadgroup_position_in_grid]]) {
    uint h_q = tg_pos.x;
    uint t   = tg_pos.y;
    if (h_q >= args.n_heads || t >= args.n_tokens) return;

    uint gqa = args.n_heads / args.n_kv_heads;          // >= 1
    uint h_k = h_q / gqa;

    device const block_qjl1_256 * blk = packed_k + h_k * args.n_tokens + t;
    device const float          * qs  = q_sketch + h_q * QJL_PROJECTION_DIM;

    // Each of 32 threads owns one byte of qs[] = 8 sign bits.
    // Reads 8 q_sketch entries per thread.
    float acc = 0.0f;
    uint byte_i = tid;                                  // 0..31
    uint bits   = blk->qs[byte_i];
    uint base   = byte_i * 8;                           // 0..248
    for (uint k = 0; k < 8; ++k) {
        float qv = qs[base + k];
        // bit set => +1, clear => -1 (matches qjl_score_qk_ref).
        acc += ((bits >> k) & 1u) ? qv : -qv;
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
        scores[h_q * args.n_tokens + t] = QJL_SCORE_SCALE * norm_k * sum;
    }
}

// ---------- dequantize one row (debug / dequant-then-fp32 fallback) ----------
//
// recon[i] = (||k|| * sqrt(pi/2) / proj_dim) * sum_j sign(j) * prj[i*proj_dim + j]
//
// Matches qjl_dequantize_row_ref exactly. NOT the production path — the
// score kernel above avoids materialising recon[]. Provided so a host can
// validate decode correctness end-to-end without going through attention.

struct qjl_dequant_args {
    uint head_dim;          // must equal 128
    uint proj_dim;          // must equal 256
};

kernel void kernel_get_rows_qjl1_256(
        device const block_qjl1_256 * blk          [[buffer(0)]],   // single block
        device const float          * prj          [[buffer(1)]],   // (head_dim, proj_dim) row-major
        device       float          * out          [[buffer(2)]],   // head_dim
        constant     qjl_dequant_args & args       [[buffer(3)]],
        uint                          tid          [[thread_position_in_threadgroup]],
        uint                          tg_size      [[threads_per_threadgroup]]) {
    if (args.head_dim != QJL_HEAD_DIM || args.proj_dim != QJL_PROJECTION_DIM) return;

    float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
    float scale  = QJL_SCORE_SCALE * norm_k;

    // Walk each output element with stride = tg_size; each thread sums proj_dim
    // signed projection rows.
    for (uint i = tid; i < QJL_HEAD_DIM; i += tg_size) {
        float acc = 0.0f;
        device const float * row = prj + i * QJL_PROJECTION_DIM;
        for (uint j = 0; j < QJL_PROJECTION_DIM; ++j) {
            uint bit = (blk->qs[j >> 3] >> (j & 7)) & 1u;
            acc += bit ? row[j] : -row[j];
        }
        out[i] = scale * acc;
    }
}

// ---------- mat-vec multiply against an fp32 query (non-attention call sites) ----------
//
// y[i] = sum over packed K rows of (decoded K_i · q[...]); used for non-FA
// linear layers that reference QJL-quantized weights. Provided as the
// kernel_mul_mv_qjl1_256_f32 entrypoint asked for by the porting plan.
//
// Input layout:
//   k_blocks : (n_rows, block_qjl1_256), row-major
//   q        : (proj_dim) fp32 sketch (caller pre-projects via Π)
//   y        : (n_rows) fp32 output
//
// Threadgroup-per-row dispatch (matches kernel_attn_score_qjl1_256 layout but
// without the GQA fanout / head loop).

struct qjl_mv_args {
    uint n_rows;
    uint proj_dim;          // must equal 256
};

kernel void kernel_mul_mv_qjl1_256_f32(
        device const block_qjl1_256 * k_blocks    [[buffer(0)]],
        device const float          * q           [[buffer(1)]],
        device       float          * y           [[buffer(2)]],
        constant     qjl_mv_args    & args        [[buffer(3)]],
        uint                          tid         [[thread_position_in_threadgroup]],
        uint                          row         [[threadgroup_position_in_grid]]) {
    if (row >= args.n_rows) return;
    if (args.proj_dim != QJL_PROJECTION_DIM) return;

    device const block_qjl1_256 * blk = k_blocks + row;

    // Same pattern as the attention score kernel: 32 threads × 8 bits each.
    float acc = 0.0f;
    uint byte_i = tid;
    uint bits   = blk->qs[byte_i];
    uint base   = byte_i * 8;
    for (uint k = 0; k < 8; ++k) {
        float qv = q[base + k];
        acc += ((bits >> k) & 1u) ? qv : -qv;
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
        y[row] = QJL_SCORE_SCALE * norm_k * sum;
    }
}
