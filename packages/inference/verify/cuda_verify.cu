// CUDA fixture-parity harness for the turbo3 / turbo4 / turbo3_tcq / qjl /
// polar (+ polar_qjl, optional fused_attn_qjl_tbq) kernels.
//
// Sibling of metal_verify.mm (Apple GPU) and vulkan_verify.cpp (cross-vendor).
// Same contract: load the canonical JSON fixture written by gen_fixture, run
// the corresponding kernel on the GPU, diff scalar scores against the
// reference (`expected_scores` in the fixture, regenerated from the C
// reference in reference/turbo_kernels.c + verify/qjl_polar_ref.c — the same
// reference Metal and Vulkan compare against), report 8/8.
//
// DESIGN — why this harness is self-contained:
//
//   The fixture byte images use the on-disk GGUF block layouts (`block_tbq3_0`
//   etc. == the buun-llama-cpp / ggml-common.h packing the converter writes).
//   The fork's per-block CUDA `__device__` helpers in turboquant.cuh decode a
//   *different* internal layout (3-bit packed, no separate sign bytes). So,
//   exactly like metal_verify / vulkan_verify port the *reference* algorithm
//   into the shader, this harness ports the reference decode/score into CUDA
//   `__device__` kernels that consume the fixture bytes directly. The CUDA
//   numerics (FMA, fp16<->fp32, FWHT order) are exercised end-to-end, and the
//   diff is against the same `expected_scores` Metal/Vulkan pass.
//
//   When the fork's full CUDA KV-cache kernels land (qjl.cu / polarquant.cu /
//   turbo-tcq.cu, exporting attn_score_qjl_cuda etc.), this harness can be
//   extended to ALSO link libggml-cuda.so and cross-check the exported
//   symbols — but fixture parity does not depend on that build artifact.
//
// Build (Linux + CUDA Toolkit; macOS not supported — nvcc absent):
//     make -C packages/inference/verify cuda
// Run:
//     make -C packages/inference/verify cuda-verify       # all fixtures
//     ./cuda_verify fixtures/turbo3.json [tol=1e-3]
//
// Full hardware gate (build the fork target, run fixtures, then drive a real
// GGUF graph dispatch): verify/cuda_runner.sh — see CUDA_VERIFICATION.md.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <cuda_runtime.h>
#include <cuda_fp16.h>

// CPU reference declarations — used only for an on-host double-check of the
// fixture's expected_scores (the same .o that metal_verify / vulkan_verify
// link). The CUDA dispatch path below is independent of these.
extern "C" {
#include "qjl_polar_ref.h"
}

// ============================== error check ===============================

#define CUDA_CHECK(expr) do {                                                  \
    cudaError_t _e = (expr);                                                    \
    if (_e != cudaSuccess) {                                                    \
        std::fprintf(stderr, "[cuda_verify] %s -> %s\n", #expr,                 \
                     cudaGetErrorString(_e));                                   \
        std::exit(1);                                                           \
    }                                                                           \
} while (0)

// ============================ fp16 helpers ================================
// Host-side IEEE-754 binary16 round-trip, bit-identical to the reference's
// eliza_fp32_to_fp16 / eliza_fp16_to_fp32 (round-to-nearest-even).

static inline float fp16_to_fp32_host(uint16_t h) {
    const uint32_t sign = (uint32_t)(h & 0x8000) << 16;
    uint32_t exp  = (h >> 10) & 0x1f;
    uint32_t mant = h & 0x3ff;
    uint32_t u;
    if (exp == 0) {
        if (mant == 0) {
            u = sign;
        } else {
            while (!(mant & 0x400)) { mant <<= 1; exp--; }
            mant &= 0x3ff;
            u = sign | (((uint32_t)(exp + 127 - 15 + 1)) << 23) | (mant << 13);
        }
    } else if (exp == 0x1f) {
        u = sign | 0x7f800000u | (mant << 13);
    } else {
        u = sign | (((uint32_t)(exp + 127 - 15)) << 23) | (mant << 13);
    }
    float f; std::memcpy(&f, &u, 4); return f;
}

__device__ __forceinline__ float fp16_to_fp32_dev(uint16_t h) {
    return __half2float(*reinterpret_cast<const __half *>(&h));
}

__device__ __forceinline__ float bf16_to_fp32_dev(uint16_t b) {
    uint32_t u = (uint32_t)b << 16;
    float f; memcpy(&f, &u, 4); return f;
}

// ===================== constant tables (== reference) =====================

// TurboQuant 3/4-bit centroid LUTs — verbatim from reference/turbo_kernels.c.
__device__ __constant__ float k_turbo_centroids_3bit[8] = {
    -0.190685f, -0.117832f, -0.065717f, -0.021460f,
     0.021460f,  0.065717f,  0.117832f,  0.190685f,
};
__device__ __constant__ float k_turbo_centroids_4bit[16] = {
    -2.7321365f, -2.0685055f, -1.6175243f, -1.2557391f,
    -0.9419147f, -0.6564307f, -0.3878412f, -0.1283243f,
     0.1283243f,  0.3878412f,  0.6564307f,  0.9419147f,
     1.2557391f,  1.6175243f,  2.0685055f,  2.7321365f,
};

// TurboQuant 3-bit TCQ codebook (512 states) — verbatim from buun
// ggml-cuda/turbo-quant-cuda.cuh::d_turbo3_tcq_codebook (credit spiritbuun).
__device__ __constant__ float k_tbq3_tcq_codebook[512] = {
#include "tbq3_tcq_codebook.inc"
};

// PolarQuant Q4 Lloyd-Max centroids — verbatim from
// verify/qjl_polar_ref.c::ELIZA_POLAR_Q4_CENTROIDS.
__device__ __constant__ float k_polar_q4_centroids[16] = {
    -2.754354807f, -2.093562707f, -1.643041510f, -1.279739752f,
    -0.962640978f, -0.672392117f, -0.397897103f, -0.131757782f,
     0.131757782f,  0.397897103f,  0.672392117f,  0.962640978f,
     1.279739752f,  1.643041510f,  2.093562707f,  2.754354807f,
};

// ============================== fixture =================================

namespace {

struct Fixture {
    std::string kernel;
    int head_dim      = 0;
    int n_kv          = 0;   // turbo*: KV slots
    int block_bytes   = 0;
    int blocks_per_kv = 0;   // turbo*: 14B/18B blocks per 128-element row, or 1
    int proj_dim      = 0;   // qjl
    int n_heads       = 0;   // qjl / fused
    int n_kv_heads    = 0;   // qjl / fused
    int n_tokens      = 0;   // qjl / fused
    int n_rows        = 0;   // polar
    int use_qjl       = 0;   // polar
    std::vector<float>   q;
    std::vector<float>   q_sketch;
    std::vector<uint8_t> k_blocks;
    std::vector<uint8_t> v_blocks;        // fused only
    std::vector<float>   expected_scores;
};

std::string slurp(const char * path) {
    std::ifstream f(path);
    if (!f) { std::fprintf(stderr, "[cuda_verify] cannot open %s\n", path); std::exit(2); }
    std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

bool find_key_opt(const std::string & s, const char * key, size_t & pos) {
    const std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle, 0);
    if (k == std::string::npos) return false;
    size_t colon = s.find(':', k);
    if (colon == std::string::npos) return false;
    pos = colon + 1;
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return true;
}

int parse_int(const std::string & s, size_t pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return (int)std::strtol(s.c_str() + pos, nullptr, 10);
}

std::vector<float> parse_float_array(const std::string & s, size_t pos) {
    while (pos < s.size() && s[pos] != '[') pos++;
    pos++;
    std::vector<float> out;
    while (pos < s.size() && s[pos] != ']') {
        char * end = nullptr;
        out.push_back(std::strtof(s.c_str() + pos, &end));
        pos = (size_t)(end - s.c_str());
        while (pos < s.size() && (s[pos] == ',' || std::isspace((unsigned char)s[pos]))) pos++;
    }
    return out;
}

std::vector<uint8_t> parse_byte_array(const std::string & s, size_t pos) {
    while (pos < s.size() && s[pos] != '[') pos++;
    pos++;
    std::vector<uint8_t> out;
    while (pos < s.size() && s[pos] != ']') {
        char * end = nullptr;
        out.push_back((uint8_t)std::strtol(s.c_str() + pos, &end, 10));
        pos = (size_t)(end - s.c_str());
        while (pos < s.size() && (s[pos] == ',' || std::isspace((unsigned char)s[pos]))) pos++;
    }
    return out;
}

std::string parse_string(const std::string & s, size_t pos) {
    while (pos < s.size() && s[pos] != '"') pos++;
    pos++;
    size_t start = pos;
    while (pos < s.size() && s[pos] != '"') pos++;
    return s.substr(start, pos - start);
}

// --- positional helpers for the fused fixture's `cases` array (parsed
//     in document order from a running cursor). ---
bool find_key_from(const std::string & s, const char * key, size_t & cur) {
    const std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle, cur);
    if (k == std::string::npos) return false;
    size_t colon = s.find(':', k);
    if (colon == std::string::npos) return false;
    cur = colon + 1;
    while (cur < s.size() && std::isspace((unsigned char)s[cur])) cur++;
    return true;
}
int parse_int_at(const std::string & s, size_t & cur) {
    while (cur < s.size() && std::isspace((unsigned char)s[cur])) cur++;
    char * end = nullptr;
    long v = std::strtol(s.c_str() + cur, &end, 10);
    cur = (size_t)(end - s.c_str());
    return (int)v;
}
double parse_double_at(const std::string & s, size_t & cur) {
    while (cur < s.size() && std::isspace((unsigned char)s[cur])) cur++;
    char * end = nullptr;
    double v = std::strtod(s.c_str() + cur, &end);
    cur = (size_t)(end - s.c_str());
    return v;
}
std::vector<float> parse_float_array_at(const std::string & s, size_t & cur) {
    while (cur < s.size() && s[cur] != '[') cur++;
    cur++;
    std::vector<float> out;
    while (cur < s.size() && s[cur] != ']') {
        char * end = nullptr;
        out.push_back(std::strtof(s.c_str() + cur, &end));
        cur = (size_t)(end - s.c_str());
        while (cur < s.size() && (s[cur] == ',' || std::isspace((unsigned char)s[cur]))) cur++;
    }
    if (cur < s.size()) cur++;   // past ']'
    return out;
}
std::vector<uint8_t> parse_byte_array_at(const std::string & s, size_t & cur) {
    while (cur < s.size() && s[cur] != '[') cur++;
    cur++;
    std::vector<uint8_t> out;
    while (cur < s.size() && s[cur] != ']') {
        char * end = nullptr;
        out.push_back((uint8_t)std::strtol(s.c_str() + cur, &end, 10));
        cur = (size_t)(end - s.c_str());
        while (cur < s.size() && (s[cur] == ',' || std::isspace((unsigned char)s[cur]))) cur++;
    }
    if (cur < s.size()) cur++;   // past ']'
    return out;
}

Fixture load_fixture(const char * path) {
    const std::string s = slurp(path);
    Fixture fx; size_t p = 0;
    if (find_key_opt(s, "kernel", p))          fx.kernel          = parse_string(s, p);
    if (find_key_opt(s, "head_dim", p))        fx.head_dim        = parse_int(s, p);
    if (find_key_opt(s, "n_kv", p))            fx.n_kv            = parse_int(s, p);
    if (find_key_opt(s, "block_bytes", p))     fx.block_bytes     = parse_int(s, p);
    if (find_key_opt(s, "blocks_per_kv", p))   fx.blocks_per_kv   = parse_int(s, p);
    if (find_key_opt(s, "proj_dim", p))        fx.proj_dim        = parse_int(s, p);
    if (find_key_opt(s, "n_heads", p))         fx.n_heads         = parse_int(s, p);
    if (find_key_opt(s, "n_kv_heads", p))      fx.n_kv_heads      = parse_int(s, p);
    if (find_key_opt(s, "n_tokens", p))        fx.n_tokens        = parse_int(s, p);
    if (find_key_opt(s, "n_rows", p))          fx.n_rows          = parse_int(s, p);
    if (find_key_opt(s, "use_qjl", p))         fx.use_qjl         = parse_int(s, p);
    if (find_key_opt(s, "q", p))               fx.q               = parse_float_array(s, p);
    if (find_key_opt(s, "q_sketch", p))        fx.q_sketch        = parse_float_array(s, p);
    if (find_key_opt(s, "k_blocks", p))        fx.k_blocks        = parse_byte_array(s, p);
    if (find_key_opt(s, "v_blocks", p))        fx.v_blocks        = parse_byte_array(s, p);
    if (find_key_opt(s, "expected_scores", p)) fx.expected_scores = parse_float_array(s, p);
    return fx;
}

} // namespace

// =========================== device kernels ==============================

// --- TurboQuant FWHT-128 (matches eliza_turbo_rotate_forward inverse) ------
// reference/turbo_kernels.c: K is dequantized in the *rotated* domain and Q is
// pre-rotated host-side before the dot, so neither the harness Q nor the
// shader/CUDA path applies the FWHT. The fixture's `q` is already rotated. The
// device decode here therefore mirrors eliza_dequantize_turbo*_block (no FWHT).

// turbo3: 4 x 14-byte blocks per 128-element row.
//   layout: uint16_t norm; uint8_t qs[8] (2-bit lo, 4 idx/byte); uint8_t signs[4].
struct dev_block_turbo3_0 { uint16_t norm; uint8_t qs[8]; uint8_t signs[4]; };
static_assert(sizeof(dev_block_turbo3_0) == 14, "turbo3 block 14B");

// turbo4: 4 x 18-byte blocks per 128-element row.
//   layout: uint16_t norm; uint8_t qs[16] (first 16 lo nibbles, last 16 hi).
struct dev_block_turbo4_0 { uint16_t norm; uint8_t qs[16]; };
static_assert(sizeof(dev_block_turbo4_0) == 18, "turbo4 block 18B");

// turbo3_tcq: 1 x 52-byte block per 128-element row.
struct dev_block_turbo3_tcq { uint16_t norm; uint8_t qs[49]; uint8_t pad; };
static_assert(sizeof(dev_block_turbo3_tcq) == 52, "turbo3_tcq block 52B");

// qjl: 34-byte block. qs[32] packed signs (LSB-first), then bf16 norm.
struct dev_block_qjl1_256 { uint8_t qs[32]; uint16_t norm_bf16; };
static_assert(sizeof(dev_block_qjl1_256) == 34, "qjl block 34B");

// polar: 82-byte block. fp16 d; qs[64] (2 x 4-bit/byte); qjl[16] residual sign.
#pragma pack(push, 1)
struct dev_block_q4_polar { uint16_t d; uint8_t qs[64]; uint8_t qjl[16]; };
#pragma pack(pop)
static_assert(sizeof(dev_block_q4_polar) == 82, "polar block 82B");

// One CUDA block per KV slot; 32 threads, lane 0 does the (small) decode+dot.
// Mirrors eliza_dot_q_turbo3 / eliza_dot_q_turbo4.
template <int QK>
__global__ void turbo34_score_kernel(const float * __restrict__ q,
                                     const void *  __restrict__ k_raw,
                                     int  blocks_per_kv,
                                     int  is_turbo4,
                                     int  n_kv,
                                     float * __restrict__ scores) {
    const int kv = blockIdx.x;
    if (kv >= n_kv || threadIdx.x != 0) return;

    double acc = 0.0;
    if (is_turbo4) {
        const dev_block_turbo4_0 * blocks =
            reinterpret_cast<const dev_block_turbo4_0 *>(k_raw) + kv * blocks_per_kv;
        for (int b = 0; b < blocks_per_kv; ++b) {
            const float n = fp16_to_fp32_dev(blocks[b].norm);
            for (int j = 0; j < QK; ++j) {
                const uint8_t packed = blocks[b].qs[j & 15];
                const uint8_t idx = (j < 16) ? (packed & 0x0F) : (uint8_t)(packed >> 4);
                acc += (double)q[b * QK + j] * (double)(k_turbo_centroids_4bit[idx] * n);
            }
        }
    } else {
        const dev_block_turbo3_0 * blocks =
            reinterpret_cast<const dev_block_turbo3_0 *>(k_raw) + kv * blocks_per_kv;
        for (int b = 0; b < blocks_per_kv; ++b) {
            const float n = fp16_to_fp32_dev(blocks[b].norm);
            for (int j = 0; j < QK; ++j) {
                const uint8_t low2 = (uint8_t)((blocks[b].qs[j / 4] >> ((j % 4) * 2)) & 0x3);
                const uint8_t hi1  = (uint8_t)((blocks[b].signs[j / 8] >> (j % 8)) & 0x1);
                const uint8_t idx  = (uint8_t)(low2 | (hi1 << 2));
                acc += (double)q[b * QK + j] * (double)(k_turbo_centroids_3bit[idx] * n);
            }
        }
    }
    scores[kv] = (float)acc;
}

// turbo3_tcq: codebook in __constant__ memory (the buun + Metal/Vulkan choice).
// Mirrors eliza_dequantize_turbo3_tcq_block + eliza_dot_q_turbo3_tcq.
__global__ void turbo3_tcq_score_kernel(const float * __restrict__ q,
                                        const dev_block_turbo3_tcq * __restrict__ k_blocks,
                                        int n_kv,
                                        float * __restrict__ scores) {
    const int kv = blockIdx.x;
    if (kv >= n_kv || threadIdx.x != 0) return;
    const dev_block_turbo3_tcq & blk = k_blocks[kv];
    const float n = fp16_to_fp32_dev(blk.norm);
    double acc = 0.0;
    for (int t = 0; t < 128; ++t) {
        const int bit_pos  = t * 3;
        const int byte_idx = bit_pos >> 3;
        const int bit_off  = bit_pos & 7;
        uint32_t raw = (uint32_t)blk.qs[byte_idx];
        if (byte_idx + 1 < 49) raw |= (uint32_t)blk.qs[byte_idx + 1] << 8;
        const int state = (raw >> bit_off) & 0x1FF;
        acc += (double)q[t] * (double)(k_tbq3_tcq_codebook[state] * n);
    }
    scores[kv] = (float)acc;
}

// qjl: one CUDA block per (head_q, token); 32-lane warp reduces the 256-dim
// sign-dot. Mirrors eliza_qjl_score_qk exactly (scl = sqrt(pi/2)/proj_dim).
__global__ void qjl_score_kernel(const float * __restrict__ q_sketch,
                                 const dev_block_qjl1_256 * __restrict__ packed_k,
                                 int proj_dim,
                                 int n_heads, int n_kv_heads, int n_tokens,
                                 float * __restrict__ scores) {
    const int out = blockIdx.x;            // out = hq * n_tokens + t
    if (out >= n_heads * n_tokens) return;
    const int hq = out / n_tokens;
    const int t  = out % n_tokens;
    const int gqa = n_heads / n_kv_heads;
    const int hk  = hq / gqa;
    const float * qs = q_sketch + (size_t)hq * proj_dim;
    const dev_block_qjl1_256 & blk = packed_k[(size_t)hk * n_tokens + t];

    float partial = 0.0f;
    for (int j = threadIdx.x; j < proj_dim; j += blockDim.x) {
        const int bit = (blk.qs[j >> 3] >> (j & 7)) & 1;
        partial += bit ? qs[j] : -qs[j];
    }
    // warp reduce (blockDim.x == 32).
    for (int off = 16; off > 0; off >>= 1) {
        partial += __shfl_down_sync(0xffffffffu, partial, off);
    }
    if (threadIdx.x == 0) {
        const float scl = 1.2533141373155003f / (float)proj_dim;
        const float norm_k = bf16_to_fp32_dev(blk.norm_bf16);
        scores[out] = scl * norm_k * partial;
    }
}

// polar: per-row dequantize (Hadamard butterfly in registers) then dot with q.
// Mirrors eliza_polar_dequantize_row + eliza_polar_mul_mv. xorshift32 sign
// sequence for the QJL residual matches eliza_polar_qjl_signs (seed 42).
__device__ __forceinline__ void polar_hadamard128_dev(float * x) {
    for (int h = 1; h < 128; h <<= 1) {
        for (int i = 0; i < 128; i += (h << 1)) {
            for (int j = i; j < i + h; ++j) {
                const float a = x[j];
                const float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}
__global__ void polar_score_kernel(const float * __restrict__ q,
                                   const dev_block_q4_polar * __restrict__ k_blocks,
                                   int n_rows, int use_qjl,
                                   float * __restrict__ scores) {
    const int r = blockIdx.x;
    if (r >= n_rows || threadIdx.x != 0) return;
    const dev_block_q4_polar & src = k_blocks[r];
    const float l2 = fp16_to_fp32_dev(src.d);
    float buf[128];
    for (int i = 0; i < 64; ++i) {
        const uint8_t byte = src.qs[i];
        buf[2 * i]     = k_polar_q4_centroids[byte & 0x0F];
        buf[2 * i + 1] = k_polar_q4_centroids[(byte >> 4) & 0x0F];
    }
    if (use_qjl) {
        // xorshift32 sign vector, seed = 42.
        uint32_t st = 42u;
        float signs[128];
        for (int i = 0; i < 128; ++i) {
            st ^= st << 13; st ^= st >> 17; st ^= st << 5;
            signs[i] = (st & 1u) ? 1.0f : -1.0f;
        }
        const uint8_t bit = (uint8_t)(src.qjl[0] & 1u);
        const float sign = bit ? 1.0f : -1.0f;
        const float mag  = 0.5f / sqrtf(128.0f);
        for (int i = 0; i < 128; ++i) buf[i] += sign * mag * signs[i];
    }
    polar_hadamard128_dev(buf);
    const float inv_d = 1.0f / 128.0f;
    double acc = 0.0;
    for (int i = 0; i < 128; ++i) acc += (double)(buf[i] * inv_d * l2) * (double)q[i];
    scores[r] = (float)acc;
}

// ----------------------- fused QJL-K + TBQ3-V attention --------------------
//
// Mirrors the fork's CPU GGML_OP_FUSED_ATTN_QJL_TBQ (ggml_fused_attn_qjl_tbq)
// and the reference eliza_fused_attn_qjl_tbq3:
//   out[h_q, :] = Σ_t softmax_t( sqrt(pi/2)/proj_dim * ||k_t|| * (Πq_h · sign(Πk_t)) * sm_scale )
//                 * uncond_dequant_TBQ3( V_{h_kv, t} )
// computed with online softmax (running max + running denom) + V accumulation
// in ONE kernel pass — no dequantized K/V intermediates materialized.
//
// V is `block_tbq3_0` (the fork's V-cache layout: uint16_t d (fp16 RMS) +
// 12 bytes of 32 LSB-first 3-bit codes), 4 blocks per 128-element head row.
// Decode = codebook lookup * d, then Hadamard-32, then the fixed ±1 sign flip
// (`eliza_tbq3_decode_block_uncond`) — the fused V-mix needs the *real* V
// vector, not the preconditioned one.
//
// One CUDA block per query head; head_dim=128 fits in registers. Layout
// (matches the fused-attention-reference agent's fixtures/fused_attn_qjl_tbq.json):
//   q_sketch F32       [n_heads, proj_dim]                   (already projected)
//   k_blocks QJL1_256  [n_kv_heads, n_tokens]    (token-major, 34 B/block)
//   v_blocks TBQ3_0    [n_kv_heads, n_tokens, 4] (token-major, 4 x 14 B)
//   out      F32       [n_heads, 128]
__device__ __constant__ float k_tbq3_codebook_fork[8] = {
    -2.1519457f, -1.3439093f, -0.7560053f, -0.2450942f,
     0.2450942f,  0.7560053f,  1.3439093f,  2.1519457f,
};
__device__ __constant__ int8_t k_tbq_signs_32_fork[32] = {
     1, -1,  1,  1, -1,  1, -1, -1,
     1,  1, -1,  1, -1, -1,  1, -1,
    -1,  1,  1, -1,  1, -1, -1,  1,
     1, -1,  1, -1, -1,  1, -1,  1,
};
struct dev_block_tbq3_0 { uint16_t d; uint8_t qs[12]; };
static_assert(sizeof(dev_block_tbq3_0) == 14, "tbq3_0 V block 14B");

__device__ __forceinline__ uint8_t tbq3_get_code_dev(const uint8_t * qs, int idx) {
    const int bit = idx * 3, byte = bit >> 3, shift = bit & 7;
    uint32_t bits = (uint32_t)qs[byte] >> shift;
    if (shift > 5 && byte + 1 < 12) bits |= (uint32_t)qs[byte + 1] << (8 - shift);
    return (uint8_t)(bits & 0x7u);
}
__device__ __forceinline__ void hadamard32_dev(float * x) {
    for (int len = 1; len < 32; len <<= 1) {
        for (int i = 0; i < 32; i += 2 * len) {
            for (int j = 0; j < len; ++j) {
                const float a = x[i + j], b = x[i + j + len];
                x[i + j] = a + b; x[i + j + len] = a - b;
            }
        }
    }
    const float n = 0.1767766952966369f;   // 1/sqrt(32)
    for (int i = 0; i < 32; ++i) x[i] *= n;
}
__device__ __forceinline__ void tbq3_decode_block_uncond_dev(const dev_block_tbq3_0 & blk, float * out32) {
    const float d = fp16_to_fp32_dev(blk.d);
    if (d == 0.0f) { for (int i = 0; i < 32; ++i) out32[i] = 0.0f; return; }
    for (int i = 0; i < 32; ++i) out32[i] = d * k_tbq3_codebook_fork[tbq3_get_code_dev(blk.qs, i)];
    hadamard32_dev(out32);
    for (int i = 0; i < 32; ++i) out32[i] *= (float)k_tbq_signs_32_fork[i];
}

__global__ void fused_attn_qjl_tbq3_kernel(const float * __restrict__ q_sketch,
                                           const dev_block_qjl1_256 * __restrict__ k_blocks,
                                           const dev_block_tbq3_0 * __restrict__ v_blocks,
                                           int proj_dim, int n_heads, int n_kv_heads, int n_tokens,
                                           float sm_scale, float * __restrict__ out) {
    const int hq = blockIdx.x;
    if (hq >= n_heads || threadIdx.x != 0) return;
    const int gqa = n_heads / n_kv_heads;
    const int hk  = hq / gqa;
    const float * qh = q_sketch + (size_t)hq * proj_dim;
    const dev_block_qjl1_256 * pk = k_blocks + (size_t)hk * n_tokens;
    const dev_block_tbq3_0   * pv = v_blocks + (size_t)hk * n_tokens * 4;
    float * oh = out + (size_t)hq * 128;

    const float qjl_scl = 1.2533141373155003f / (float)proj_dim;
    float acc[128];
    for (int d = 0; d < 128; ++d) acc[d] = 0.0f;
    float m = -INFINITY, l = 0.0f;
    for (int t = 0; t < n_tokens; ++t) {
        float dot = 0.0f;
        for (int j = 0; j < proj_dim; ++j) {
            const int bit = (pk[t].qs[j >> 3] >> (j & 7)) & 1;
            dot += bit ? qh[j] : -qh[j];
        }
        const float score = qjl_scl * bf16_to_fp32_dev(pk[t].norm_bf16) * dot * sm_scale;
        const float m_new = fmaxf(m, score);
        const float corr  = __expf(m - m_new);
        const float w     = __expf(score - m_new);
        l = l * corr + w;
        for (int c = 0; c < 4; ++c) {
            float dec[32];
            tbq3_decode_block_uncond_dev(pv[(size_t)t * 4 + c], dec);
            for (int i = 0; i < 32; ++i) {
                const int d = c * 32 + i;
                acc[d] = acc[d] * corr + w * dec[i];
            }
        }
        m = m_new;
    }
    const float inv_l = (l > 0.0f) ? (1.0f / l) : 0.0f;
    for (int d = 0; d < 128; ++d) oh[d] = acc[d] * inv_l;
}

// ---------------------- QJL int8-sketch DP4A path -------------------------
//
// Faster variant of the QJL score. The 256-dim q_sketch is quantized to int8
// with a per-head scale (q_scale[h] = max|q_sketch_h| / 127), packed 4 lanes
// per 32-bit word; the K side stores +/-1 bytes (the packed sign bits widened
// to signed bytes), packed the same way. The 256-element sign-dot then becomes
// 64 __dp4a (DP4A) MACs:
//   score[h,t] = (sqrt(pi/2)/proj_dim) * ||k_t|| * q_scale[h]
//              * Σ_w  __dp4a(q_i8_pack[w], k_sign_pack[w])
// which equals qjl_score_kernel up to the q int8 round-trip — for the fixture
// magnitudes (|q_sketch| ~ O(10), 256 dims) the round-trip error is << 1e-3.
// __dp4a is available on every NVIDIA part since Pascal (sm_61); the #else
// branch keeps the kernel correct on older arches. The harness quantizes the
// fp32 q_sketch from the fixture on the host before launch.
__global__ void qjl_score_dp4a_kernel(const int8_t * __restrict__ q_sketch_i8,
                                       const float * __restrict__ q_scale,
                                       const dev_block_qjl1_256 * __restrict__ packed_k,
                                       int proj_dim,
                                       int n_heads, int n_kv_heads, int n_tokens,
                                       float * __restrict__ scores) {
    const int out = blockIdx.x;
    if (out >= n_heads * n_tokens) return;
    const int hq = out / n_tokens;
    const int t  = out % n_tokens;
    const int gqa = n_heads / n_kv_heads;
    const int hk  = hq / gqa;
    const int8_t * qi8 = q_sketch_i8 + (size_t)hq * proj_dim;
    const dev_block_qjl1_256 & blk = packed_k[(size_t)hk * n_tokens + t];

    int partial = 0;
    for (int w = threadIdx.x; w < proj_dim / 4; w += blockDim.x) {
        // 4 K sign-bits for lanes [4w .. 4w+3] -> 4 signed bytes {+1,-1}.
        const int    byte_idx = w >> 1;
        const uint8_t sb = (uint8_t)(blk.qs[byte_idx] >> ((w & 1) * 4));
        int kpack = 0;
        for (int b = 0; b < 4; ++b) {
            const int8_t s = ((sb >> b) & 1) ? (int8_t)1 : (int8_t)-1;
            kpack |= ((int)(uint8_t)s) << (b * 8);
        }
        int qpack;
        memcpy(&qpack, qi8 + w * 4, 4);
#if defined(__CUDA_ARCH__) && __CUDA_ARCH__ >= 610
        partial = __dp4a(qpack, kpack, partial);
#else
        for (int b = 0; b < 4; ++b) {
            const int8_t qa = (int8_t)((qpack >> (b * 8)) & 0xff);
            const int8_t ka = (int8_t)((kpack >> (b * 8)) & 0xff);
            partial += (int)qa * (int)ka;
        }
#endif
    }
    for (int off = 16; off > 0; off >>= 1) {
        partial += __shfl_down_sync(0xffffffffu, partial, off);
    }
    if (threadIdx.x == 0) {
        const float scl = 1.2533141373155003f / (float)proj_dim;
        const float norm_k = bf16_to_fp32_dev(blk.norm_bf16);
        scores[out] = scl * norm_k * (float)partial * q_scale[hq];
    }
}

// =========================== verification ===============================

// Cross-backend GPU helpers shared by run() and run_fused().
static void cuda_init_and_describe() {
    int dev_count = 0;
    CUDA_CHECK(cudaGetDeviceCount(&dev_count));
    if (dev_count == 0) {
        std::fprintf(stderr, "[cuda_verify] no CUDA device — see CUDA_VERIFICATION.md\n");
        std::exit(1);
    }
    CUDA_CHECK(cudaSetDevice(0));
    cudaDeviceProp prop{};
    CUDA_CHECK(cudaGetDeviceProperties(&prop, 0));
    std::printf("[cuda_verify]   device: %s (sm_%d%d, %.1f GB)\n",
                prop.name, prop.major, prop.minor,
                (double)prop.totalGlobalMem / (1024.0 * 1024.0 * 1024.0));
}

// fused_attn_qjl_tbq.json — cases-array schema (owned by the fused-attention-
// reference agent). Top-level: head_dim, proj_dim, sm_scale, v_blocks_per_token.
// cases[i]: n_heads, n_kv_heads, n_kv, q_sketch[n_heads*proj_dim],
//           k_blocks (QJL1_256 byte image), v_blocks (TBQ3_0 byte image,
//           n_kv_heads*n_kv*4 blocks), expected_out[n_heads*128].
static int run_fused(const char * fx_path, const std::string & s, float tol) {
    int proj_dim = 256, head_dim = 128;
    double sm_scale = 1.0 / std::sqrt(128.0);
    { size_t c = 0; if (find_key_from(s, "proj_dim", c)) proj_dim = parse_int_at(s, c); }
    { size_t c = 0; if (find_key_from(s, "head_dim", c)) head_dim = parse_int_at(s, c); }
    { size_t c = 0; if (find_key_from(s, "sm_scale", c)) sm_scale = parse_double_at(s, c); }
    std::printf("[cuda_verify] %s  kernel=fused_attn_qjl_tbq  proj_dim=%d head_dim=%d sm_scale=%.9g\n",
                fx_path, proj_dim, head_dim, sm_scale);
    if (head_dim != 128) {
        std::fprintf(stderr, "[cuda_verify] fused kernel is specialized for head_dim=128 (got %d)\n", head_dim);
        return 2;
    }
    cuda_init_and_describe();

    // Walk the cases array.
    size_t pos = s.find("\"cases\"");
    if (pos == std::string::npos) { std::fprintf(stderr, "[cuda_verify] no \"cases\" in %s\n", fx_path); return 2; }
    pos = s.find('[', pos) + 1;
    int total = 0, fails = 0; double max_diff = 0.0; int case_idx = 0;
    while (true) {
        size_t brace = s.find('{', pos);
        if (brace == std::string::npos) break;
        size_t cend = s.find('}', brace);
        if (cend == std::string::npos) break;
        // ensure this brace is inside the cases array, not past ']'
        size_t arr_end = s.find(']', pos);
        if (arr_end != std::string::npos && brace > arr_end) break;
        size_t c = brace;
        int n_heads = 0, n_kv_heads = 0, n_kv = 0;
        if (find_key_from(s, "n_heads", c) && c < cend)    n_heads    = parse_int_at(s, c);
        if (find_key_from(s, "n_kv_heads", c) && c < cend) n_kv_heads = parse_int_at(s, c);
        if (find_key_from(s, "n_kv", c) && c < cend)       n_kv       = parse_int_at(s, c);
        std::vector<float>   q_sketch, expected_out;
        std::vector<uint8_t> k_blocks, v_blocks;
        if (find_key_from(s, "q_sketch", c) && c < cend)        q_sketch     = parse_float_array_at(s, c);
        if (find_key_from(s, "k_blocks", c) && c < cend)        k_blocks     = parse_byte_array_at(s, c);
        if (find_key_from(s, "v_blocks", c) && c < cend)        v_blocks     = parse_byte_array_at(s, c);
        { size_t e = brace; if (find_key_from(s, "expected_out", e) && e < cend) expected_out = parse_float_array_at(s, e); c = std::max(c, e); }
        pos = std::max(c, cend) + 1;   // advance past this case object
        if (n_heads <= 0 || n_kv_heads <= 0 || n_kv <= 0) break;

        const int n_out = n_heads * 128;
        if ((int)q_sketch.size() != n_heads * proj_dim ||
            (int)k_blocks.size() != n_kv_heads * n_kv * 34 ||
            (int)v_blocks.size() != n_kv_heads * n_kv * 4 * 14 ||
            (int)expected_out.size() != n_out) {
            std::fprintf(stderr, "[cuda_verify] fused case %d: size mismatch "
                "(q_sketch=%zu want %d, k=%zu want %d, v=%zu want %d, out=%zu want %d)\n",
                case_idx, q_sketch.size(), n_heads * proj_dim,
                k_blocks.size(), n_kv_heads * n_kv * 34,
                v_blocks.size(), n_kv_heads * n_kv * 4 * 14,
                expected_out.size(), n_out);
            return 2;
        }

        float * d_q = nullptr; void * d_k = nullptr; void * d_v = nullptr; float * d_out = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q, q_sketch.size() * sizeof(float)));
        CUDA_CHECK(cudaMalloc(&d_k, k_blocks.size()));
        CUDA_CHECK(cudaMalloc(&d_v, v_blocks.size()));
        CUDA_CHECK(cudaMalloc(&d_out, n_out * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q, q_sketch.data(), q_sketch.size() * sizeof(float), cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemcpy(d_k, k_blocks.data(), k_blocks.size(), cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemcpy(d_v, v_blocks.data(), v_blocks.size(), cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemset(d_out, 0, n_out * sizeof(float)));
        fused_attn_qjl_tbq3_kernel<<<n_heads, 32>>>(d_q,
            reinterpret_cast<const dev_block_qjl1_256 *>(d_k),
            reinterpret_cast<const dev_block_tbq3_0 *>(d_v),
            proj_dim, n_heads, n_kv_heads, n_kv, (float)sm_scale, d_out);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        std::vector<float> got(n_out);
        CUDA_CHECK(cudaMemcpy(got.data(), d_out, n_out * sizeof(float), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaFree(d_q)); CUDA_CHECK(cudaFree(d_k)); CUDA_CHECK(cudaFree(d_v)); CUDA_CHECK(cudaFree(d_out));

        int cf = 0; double cmax = 0.0;
        for (int i = 0; i < n_out; ++i) {
            const double diff = std::fabs((double)got[i] - (double)expected_out[i]);
            if (diff > cmax) cmax = diff;
            if (diff >= tol) cf++;
        }
        if (cmax > max_diff) max_diff = cmax;
        total += n_out; fails += cf;
        std::printf("  case %d (n_heads=%d, n_kv_heads=%d, n_kv=%d): %d/%d %s (max diff=%.3e)\n",
                    case_idx, n_heads, n_kv_heads, n_kv, n_out - cf, n_out,
                    cf == 0 ? "PASS" : "FAIL", cmax);
        case_idx++;
    }
    if (total == 0) { std::fprintf(stderr, "[cuda_verify] fused: no usable cases parsed in %s\n", fx_path); return 2; }
    std::printf("[cuda_verify] %s — %d/%d outputs passed across %d cases (tol=%.0e, max diff=%.3e)\n",
                fails == 0 ? "PASS" : "FAIL", total - fails, total, case_idx, (double)tol, max_diff);
    return fails == 0 ? 0 : 1;
}

static int run(const char * fx_path, float tol) {
    const std::string raw = slurp(fx_path);
    if (raw.find("\"kernel\"") != std::string::npos &&
        raw.find("fused_attn_qjl_tbq") != std::string::npos &&
        raw.find("\"cases\"") != std::string::npos) {
        return run_fused(fx_path, raw, tol);
    }

    Fixture fx = load_fixture(fx_path);

    const bool is_turbo3     = fx.kernel == "turbo3";
    const bool is_turbo4     = fx.kernel == "turbo4";
    const bool is_turbo3_tcq = fx.kernel == "turbo3_tcq";
    const bool is_qjl        = fx.kernel == "qjl";
    const bool is_polar      = fx.kernel == "polar";       // covers polar + polar_qjl
    if (!is_turbo3 && !is_turbo4 && !is_turbo3_tcq && !is_qjl && !is_polar) {
        std::fprintf(stderr, "[cuda_verify] unsupported kernel '%s' in %s\n",
                     fx.kernel.c_str(), fx_path);
        return 2;
    }

    int n_outputs = is_qjl   ? (fx.n_heads * fx.n_tokens)
                  : is_polar ? fx.n_rows
                  :            fx.n_kv;
    if (n_outputs <= 0 || (int)fx.expected_scores.size() != n_outputs) {
        std::fprintf(stderr, "[cuda_verify] fixture %s: outputs=%d but expected_scores=%zu\n",
                     fx_path, n_outputs, fx.expected_scores.size());
        return 2;
    }
    std::printf("[cuda_verify] %s  kernel=%s  outputs=%d\n",
                fx_path, fx.kernel.c_str(), n_outputs);
    cuda_init_and_describe();

    void * d_k = nullptr;
    CUDA_CHECK(cudaMalloc(&d_k, fx.k_blocks.size()));
    CUDA_CHECK(cudaMemcpy(d_k, fx.k_blocks.data(), fx.k_blocks.size(), cudaMemcpyHostToDevice));
    float * d_scores = nullptr;
    CUDA_CHECK(cudaMalloc(&d_scores, n_outputs * sizeof(float)));
    CUDA_CHECK(cudaMemset(d_scores, 0, n_outputs * sizeof(float)));

    if (is_turbo3 || is_turbo4) {
        float * d_q = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q, fx.q.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q, fx.q.data(), fx.q.size() * sizeof(float), cudaMemcpyHostToDevice));
        turbo34_score_kernel<32><<<fx.n_kv, 32>>>(d_q, d_k, fx.blocks_per_kv,
                                                  is_turbo4 ? 1 : 0, fx.n_kv, d_scores);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaFree(d_q));
    } else if (is_turbo3_tcq) {
        float * d_q = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q, fx.q.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q, fx.q.data(), fx.q.size() * sizeof(float), cudaMemcpyHostToDevice));
        turbo3_tcq_score_kernel<<<fx.n_kv, 32>>>(d_q,
            reinterpret_cast<const dev_block_turbo3_tcq *>(d_k), fx.n_kv, d_scores);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaFree(d_q));
    } else if (is_qjl) {
        float * d_qs = nullptr;
        CUDA_CHECK(cudaMalloc(&d_qs, fx.q_sketch.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_qs, fx.q_sketch.data(), fx.q_sketch.size() * sizeof(float), cudaMemcpyHostToDevice));
        qjl_score_kernel<<<n_outputs, 32>>>(d_qs,
            reinterpret_cast<const dev_block_qjl1_256 *>(d_k),
            fx.proj_dim, fx.n_heads, fx.n_kv_heads, fx.n_tokens, d_scores);
        CUDA_CHECK(cudaGetLastError());
        // Cross-check the int8-sketch DP4A path against the fp32 path.
        {
            const int hd = fx.proj_dim;
            std::vector<int8_t> q_i8((size_t)fx.n_heads * hd);
            std::vector<float>  q_sc(fx.n_heads);
            for (int h = 0; h < fx.n_heads; ++h) {
                float amax = 0.0f;
                for (int j = 0; j < hd; ++j) amax = std::max(amax, std::fabs(fx.q_sketch[(size_t)h * hd + j]));
                const float scale = (amax > 0.0f) ? (amax / 127.0f) : 1.0f;
                q_sc[h] = scale;
                const float inv = 1.0f / scale;
                for (int j = 0; j < hd; ++j) {
                    long v = std::lround(fx.q_sketch[(size_t)h * hd + j] * inv);
                    if (v >  127) v =  127;
                    if (v < -127) v = -127;
                    q_i8[(size_t)h * hd + j] = (int8_t)v;
                }
            }
            int8_t * d_qi8 = nullptr; float * d_qsc = nullptr; float * d_sc2 = nullptr;
            CUDA_CHECK(cudaMalloc(&d_qi8, q_i8.size()));
            CUDA_CHECK(cudaMalloc(&d_qsc, q_sc.size() * sizeof(float)));
            CUDA_CHECK(cudaMalloc(&d_sc2, n_outputs * sizeof(float)));
            CUDA_CHECK(cudaMemcpy(d_qi8, q_i8.data(), q_i8.size(), cudaMemcpyHostToDevice));
            CUDA_CHECK(cudaMemcpy(d_qsc, q_sc.data(), q_sc.size() * sizeof(float), cudaMemcpyHostToDevice));
            qjl_score_dp4a_kernel<<<n_outputs, 32>>>(d_qi8, d_qsc,
                reinterpret_cast<const dev_block_qjl1_256 *>(d_k),
                fx.proj_dim, fx.n_heads, fx.n_kv_heads, fx.n_tokens, d_sc2);
            CUDA_CHECK(cudaGetLastError());
            CUDA_CHECK(cudaDeviceSynchronize());
            std::vector<float> sc2(n_outputs), sc1(n_outputs);
            CUDA_CHECK(cudaMemcpy(sc1.data(), d_scores, n_outputs * sizeof(float), cudaMemcpyDeviceToHost));
            CUDA_CHECK(cudaMemcpy(sc2.data(), d_sc2,    n_outputs * sizeof(float), cudaMemcpyDeviceToHost));
            double mx = 0.0;
            for (int i = 0; i < n_outputs; ++i) mx = std::max(mx, (double)std::fabs(sc1[i] - sc2[i]));
            std::printf("[cuda_verify]   qjl int8-DP4A vs fp32 path: max diff=%.3e (round-trip)\n", mx);
            CUDA_CHECK(cudaFree(d_qi8)); CUDA_CHECK(cudaFree(d_qsc)); CUDA_CHECK(cudaFree(d_sc2));
        }
        CUDA_CHECK(cudaFree(d_qs));
    } else { // polar / polar_qjl
        float * d_q = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q, fx.q.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q, fx.q.data(), fx.q.size() * sizeof(float), cudaMemcpyHostToDevice));
        polar_score_kernel<<<fx.n_rows, 32>>>(d_q,
            reinterpret_cast<const dev_block_q4_polar *>(d_k),
            fx.n_rows, fx.use_qjl, d_scores);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaFree(d_q));
    }

    CUDA_CHECK(cudaDeviceSynchronize());
    std::vector<float> got(n_outputs);
    CUDA_CHECK(cudaMemcpy(got.data(), d_scores, n_outputs * sizeof(float), cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaFree(d_k));
    CUDA_CHECK(cudaFree(d_scores));

    int failures = 0;
    double max_diff = 0.0;
    for (int i = 0; i < n_outputs; ++i) {
        const float exp_v = fx.expected_scores[i];
        const float diff  = std::fabs(got[i] - exp_v);
        if (diff > max_diff) max_diff = diff;
        const char * tag = (diff < tol) ? "PASS" : "FAIL";
        std::printf("  i=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                    i, (double)exp_v, (double)got[i], (double)diff, tag);
        if (diff >= tol) failures++;
    }
    std::printf("[cuda_verify] %s — %d/%d passed (tol=%.0e, max diff=%.3e)\n",
                failures == 0 ? "PASS" : "FAIL",
                n_outputs - failures, n_outputs, (double)tol, max_diff);
    (void)fp16_to_fp32_host;  // host fp16 helper kept for future cross-checks.
    return failures == 0 ? 0 : 1;
}

int main(int argc, const char ** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <fixture.json> [tol=1e-3]\n", argv[0]);
        return 2;
    }
    const float tol = (argc >= 3) ? std::strtof(argv[2], nullptr) : 1e-3f;
    return run(argv[1], tol);
}
