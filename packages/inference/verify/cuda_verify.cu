// DRAFT: COMPILE-VERIFIED ON M4 MAX (preprocessor only — no nvcc on macOS).
// HARDWARE VALIDATION: NEEDS-HARDWARE — see CUDA_VERIFICATION.md for the
// exact remote-host invocation.
//
// Host-side CUDA verification harness for the turbo3 / turbo4 / turbo3_tcq /
// qjl / polar kernels. Sibling of metal_verify.mm and vulkan_verify.cpp.
//
// The harness loads the canonical fixtures from verify/fixtures/<kernel>.json,
// dispatches the in-fork CUDA kernels against the same input bytes, and diffs
// the output against the reference (tolerance: 1e-3 absolute).
//
// API SURFACE NOTES (important):
//
//   The CUDA fork at v0.4.0-milady exposes three kernel families through a
//   stable extern "C" surface in ggml-cuda/{qjl,polarquant,turbo-tcq}.cuh:
//
//     * qjl:        attn_score_qjl_cuda(...)         <- direct fixture match
//     * polar:      dequantize_row_q4_polar_cuda(...) + host-side dot
//     * turbo3_tcq: dequantize_row_tbq3_tcq_cuda(...) + host-side dot
//
//   For turbo3 / turbo4 the fork ships ONLY device-side decode helpers in
//   ggml-cuda/turboquant.cuh (tbq_decode_block_cuda). The shipped CUDA
//   path consumes those from inside fattn / mul_mat_q. To verify the same
//   per-block dot the Metal/Vulkan harnesses verify, this harness includes
//   `turboquant.cuh` and instantiates a thin __global__ wrapper that calls
//   `tbq_decode_block_cuda` exactly as the shipped code does, then runs the
//   reference dot on-device. This is NOT a JIT recompile of an alternate
//   kernel — it links against the same device functions ggml-cuda actually
//   calls in production. The wrapper is the smallest possible adapter from
//   the per-block-score fixture to the in-fork decode path.
//
//   For qjl / polar / turbo3_tcq the harness links against the shipped
//   libggml-cuda.so, so those three are 100% production-path verification.
//
// Build:
//     CUDA_HOME=/usr/local/cuda \
//     ELIZA_DFLASH_LLAMA_DIR=$HOME/.cache/eliza-dflash/milady-llama-cpp \
//     ELIZA_DFLASH_LIBGGML_CUDA=/path/to/libggml-cuda.so \
//     make cuda
//
// Run:
//     ./cuda_verify fixtures/turbo3.json
//     ./cuda_verify fixtures/turbo4.json
//     ./cuda_verify fixtures/turbo3_tcq.json
//     ./cuda_verify fixtures/qjl.json
//     ./cuda_verify fixtures/polar.json

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// CUDA runtime + the in-fork ggml-cuda headers. The Makefile sets
// -I$(CUDA_HOME)/include and -I$(LLAMA_DIR)/ggml/{include,src,src/ggml-cuda}.
#include <cuda_runtime.h>

// Pull in the in-fork block-layout definitions and the device-side helpers.
// turboquant.cuh provides tbq_decode_block_cuda; common.cuh provides the
// block_tbq3_0 / block_tbq4_0 / etc structs through ggml-common.h.
#define GGML_CUDA_TBQ3_TCQ
#define GGML_CUDA_QJL
#define GGML_CUDA_POLARQUANT

#include "ggml-cuda/common.cuh"
#include "ggml-cuda/turboquant.cuh"
#include "ggml-cuda/turbo-tcq.cuh"
#include "ggml-cuda/qjl.cuh"
#include "ggml-cuda/polarquant.cuh"

// Reference for host-side dot-product after CUDA dequantize (qjl_polar_ref
// owns the canonical CPU dot used by gen_fixture).
#include "qjl_polar_ref.h"

// ---------- CUDA error check ----------

#define CUDA_CHECK(expr) do {                                                 \
    cudaError_t _e = (expr);                                                  \
    if (_e != cudaSuccess) {                                                  \
        std::fprintf(stderr, "%s failed: %s\n", #expr, cudaGetErrorString(_e));\
        std::exit(1);                                                         \
    }                                                                         \
} while (0)

// ---------- Fixture loader (parallel to metal_verify.mm) ----------

namespace {

struct Fixture {
    std::string kernel;
    int head_dim     = 0;
    int n_kv         = 0;
    int block_bytes  = 0;
    int blocks_per_kv = 0;
    int proj_dim     = 0;
    int n_heads      = 0;
    int n_kv_heads   = 0;
    int n_tokens     = 0;
    int n_rows       = 0;
    int use_qjl      = 0;
    std::vector<float>   q;
    std::vector<float>   q_sketch;
    std::vector<uint8_t> k_blocks;
    std::vector<float>   expected_scores;
};

static std::string slurp(const char * path) {
    std::ifstream f(path);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(1); }
    std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

static const char * find_key(const std::string & s, const char * key, size_t & pos) {
    std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle, pos);
    if (k == std::string::npos) return nullptr;
    size_t colon = s.find(':', k);
    pos = colon + 1;
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return s.c_str() + pos;
}

static bool find_key_opt(const std::string & s, const char * key, size_t & pos) {
    size_t scan = 0;
    if (find_key(s, key, scan) == nullptr) return false;
    pos = scan;
    return true;
}

static int parse_int(const std::string & s, size_t & pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    char * end = nullptr;
    long v = std::strtol(s.c_str() + pos, &end, 10);
    pos = (size_t)(end - s.c_str());
    return (int)v;
}

static std::vector<float> parse_float_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++; pos++;
    std::vector<float> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        out.push_back(std::strtof(s.c_str() + pos, &end));
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}

static std::vector<uint8_t> parse_byte_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++; pos++;
    std::vector<uint8_t> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        out.push_back((uint8_t)std::strtol(s.c_str() + pos, &end, 10));
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}

static std::string parse_string(const std::string & s, size_t & pos) {
    while (s[pos] != '"') pos++; pos++;
    size_t start = pos;
    while (s[pos] != '"') pos++;
    std::string out = s.substr(start, pos - start);
    pos++;
    return out;
}

static Fixture load_fixture(const char * path) {
    std::string s = slurp(path);
    Fixture fx;
    size_t pos = 0;
    if (find_key_opt(s, "kernel", pos))         fx.kernel = parse_string(s, pos);
    if (find_key_opt(s, "head_dim", pos))       fx.head_dim = parse_int(s, pos);
    if (find_key_opt(s, "n_kv", pos))           fx.n_kv = parse_int(s, pos);
    if (find_key_opt(s, "block_bytes", pos))    fx.block_bytes = parse_int(s, pos);
    if (find_key_opt(s, "blocks_per_kv", pos))  fx.blocks_per_kv = parse_int(s, pos);
    if (find_key_opt(s, "proj_dim", pos))       fx.proj_dim = parse_int(s, pos);
    if (find_key_opt(s, "n_heads", pos))        fx.n_heads = parse_int(s, pos);
    if (find_key_opt(s, "n_kv_heads", pos))     fx.n_kv_heads = parse_int(s, pos);
    if (find_key_opt(s, "n_tokens", pos))       fx.n_tokens = parse_int(s, pos);
    if (find_key_opt(s, "n_rows", pos))         fx.n_rows = parse_int(s, pos);
    if (find_key_opt(s, "use_qjl", pos))        fx.use_qjl = parse_int(s, pos);
    if (find_key_opt(s, "q", pos))              fx.q = parse_float_array(s, pos);
    if (find_key_opt(s, "q_sketch", pos))       fx.q_sketch = parse_float_array(s, pos);
    if (find_key_opt(s, "k_blocks", pos))       fx.k_blocks = parse_byte_array(s, pos);
    if (find_key_opt(s, "expected_scores", pos)) fx.expected_scores = parse_float_array(s, pos);
    return fx;
}

} // namespace

// ---------- TurboQuant 3/4 dispatch wrapper ----------
//
// The CUDA fork ships only device-side decode helpers (no exported
// turbo3_score / turbo4_score). This thin wrapper mirrors the per-block
// dot fixture exactly: one threadblock per KV slot, decode the block via
// `tbq_decode_block_cuda` (the SAME function the shipped fattn / mul_mat
// paths call), then dot against the per-head Q chunk.

template <typename TBlock>
__global__ void tbq_score_kernel(
    const float *  __restrict__ q,           // [head_dim] (per-head Q chunk)
    const TBlock * __restrict__ k_blocks,    // [n_kv * blocks_per_kv]
    int head_dim,
    int n_kv,
    int blocks_per_kv,
    float * __restrict__ scores)             // [n_kv]
{
    const int kv = blockIdx.x;
    if (kv >= n_kv) return;

    // Decode the entire row (head_dim floats) by walking blocks_per_kv
    // QK_TBQ-sized blocks. Single thread per KV — head_dim is small (128)
    // and parity matters more than throughput in the verify harness.
    if (threadIdx.x != 0) return;

    float decoded[128];          // QK_TBQ=32, head_dim<=128
    float acc = 0.0f;
    for (int b = 0; b < blocks_per_kv; ++b) {
        float block_dec[QK_TBQ];
        tbq_decode_block_cuda(k_blocks[kv * blocks_per_kv + b], block_dec);
        for (int j = 0; j < QK_TBQ; ++j) {
            decoded[b * QK_TBQ + j] = block_dec[j];
        }
    }
    for (int i = 0; i < head_dim; ++i) {
        acc += q[i] * decoded[i];
    }
    scores[kv] = acc;
}

// ---------- main ----------

int main(int argc, const char ** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <fixture.json> [tol=1e-3]\n", argv[0]);
        return 2;
    }
    const char * fx_path = argv[1];
    const float  tol     = argc >= 3 ? std::strtof(argv[2], nullptr) : 1e-3f;

    Fixture fx = load_fixture(fx_path);
    const bool is_turbo3     = (fx.kernel == "turbo3");
    const bool is_turbo4     = (fx.kernel == "turbo4");
    const bool is_turbo3_tcq = (fx.kernel == "turbo3_tcq");
    const bool is_qjl        = (fx.kernel == "qjl");
    const bool is_polar      = (fx.kernel == "polar");

    if (!is_turbo3 && !is_turbo4 && !is_turbo3_tcq && !is_qjl && !is_polar) {
        std::fprintf(stderr, "[cuda_verify] unknown kernel '%s'\n", fx.kernel.c_str());
        return 2;
    }

    int n_outputs = is_qjl   ? (fx.n_heads * fx.n_tokens)
                  : is_polar ? fx.n_rows
                  :            fx.n_kv;
    std::printf("[cuda_verify] kernel=%s outputs=%d\n", fx.kernel.c_str(), n_outputs);

    int dev_count = 0;
    CUDA_CHECK(cudaGetDeviceCount(&dev_count));
    if (dev_count == 0) {
        std::fprintf(stderr, "[cuda_verify] no CUDA device — see CUDA_VERIFICATION.md\n");
        return 1;
    }
    CUDA_CHECK(cudaSetDevice(0));

    // Common: K blocks on device.
    void * d_k = nullptr;
    CUDA_CHECK(cudaMalloc(&d_k, fx.k_blocks.size()));
    CUDA_CHECK(cudaMemcpy(d_k, fx.k_blocks.data(), fx.k_blocks.size(), cudaMemcpyHostToDevice));

    // Output scores buffer.
    float * d_scores = nullptr;
    CUDA_CHECK(cudaMalloc(&d_scores, n_outputs * sizeof(float)));
    CUDA_CHECK(cudaMemset(d_scores, 0, n_outputs * sizeof(float)));

    std::vector<float> host_scores(n_outputs, 0.0f);

    cudaStream_t stream = 0;

    if (is_turbo3 || is_turbo4) {
        // Per-head Q chunk on device.
        float * d_q = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q, fx.q.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q, fx.q.data(), fx.q.size() * sizeof(float), cudaMemcpyHostToDevice));

        if (is_turbo3) {
            tbq_score_kernel<block_tbq3_0><<<fx.n_kv, 32, 0, stream>>>(
                d_q, (const block_tbq3_0 *) d_k,
                fx.head_dim, fx.n_kv, fx.blocks_per_kv, d_scores);
        } else {
            tbq_score_kernel<block_tbq4_0><<<fx.n_kv, 32, 0, stream>>>(
                d_q, (const block_tbq4_0 *) d_k,
                fx.head_dim, fx.n_kv, fx.blocks_per_kv, d_scores);
        }
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        CUDA_CHECK(cudaMemcpy(host_scores.data(), d_scores,
                              n_outputs * sizeof(float), cudaMemcpyDeviceToHost));
        cudaFree(d_q);

    } else if (is_turbo3_tcq) {
        // SHIPPED PATH: dequantize_row_tbq3_tcq_cuda from libggml-cuda.so.
        // Then host-side dot vs the reference q.
        const int rows = fx.n_kv;
        float * d_dec = nullptr;
        CUDA_CHECK(cudaMalloc(&d_dec, rows * QK_TBQ3_TCQ * sizeof(float)));
        dequantize_row_tbq3_tcq_cuda(d_k, d_dec, rows, stream);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());

        std::vector<float> dec(rows * QK_TBQ3_TCQ);
        CUDA_CHECK(cudaMemcpy(dec.data(), d_dec,
                              dec.size() * sizeof(float), cudaMemcpyDeviceToHost));
        for (int kv = 0; kv < rows; ++kv) {
            float acc = 0.0f;
            for (int i = 0; i < fx.head_dim; ++i) {
                acc += fx.q[i] * dec[kv * QK_TBQ3_TCQ + i];
            }
            host_scores[kv] = acc;
        }
        cudaFree(d_dec);

    } else if (is_qjl) {
        // SHIPPED PATH: attn_score_qjl_cuda. The fixture's q_sketch + k_blocks
        // map 1:1 to (q_sketch_d, packed_k_d) and the kernel writes scores
        // directly. Zero host-side post-processing.
        float * d_q_sketch = nullptr;
        CUDA_CHECK(cudaMalloc(&d_q_sketch, fx.q_sketch.size() * sizeof(float)));
        CUDA_CHECK(cudaMemcpy(d_q_sketch, fx.q_sketch.data(),
                              fx.q_sketch.size() * sizeof(float), cudaMemcpyHostToDevice));

        attn_score_qjl_cuda(d_q_sketch, d_k,
                            fx.n_heads, fx.n_kv_heads, fx.n_tokens,
                            d_scores, stream);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        CUDA_CHECK(cudaMemcpy(host_scores.data(), d_scores,
                              n_outputs * sizeof(float), cudaMemcpyDeviceToHost));
        cudaFree(d_q_sketch);

    } else if (is_polar) {
        // SHIPPED PATH: dequantize_row_q4_polar_cuda + host-side dot.
        const int rows = fx.n_rows;
        float * d_dec = nullptr;
        CUDA_CHECK(cudaMalloc(&d_dec, rows * QK_POLAR * sizeof(float)));
        dequantize_row_q4_polar_cuda(d_k, d_dec, rows, fx.use_qjl, stream);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());

        std::vector<float> dec(rows * QK_POLAR);
        CUDA_CHECK(cudaMemcpy(dec.data(), d_dec,
                              dec.size() * sizeof(float), cudaMemcpyDeviceToHost));
        for (int r = 0; r < rows; ++r) {
            float acc = 0.0f;
            for (int i = 0; i < fx.head_dim; ++i) {
                acc += fx.q[i] * dec[r * QK_POLAR + i];
            }
            host_scores[r] = acc;
        }
        cudaFree(d_dec);
    }

    // Diff against reference.
    int failures = 0;
    for (int i = 0; i < n_outputs; ++i) {
        const float exp_v = (i < (int)fx.expected_scores.size()) ? fx.expected_scores[i] : 0.0f;
        const float got   = host_scores[i];
        const float diff  = std::fabs(got - exp_v);
        const char * tag  = (diff < tol) ? "PASS" : "FAIL";
        std::printf("  i=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                    i, (double)exp_v, (double)got, (double)diff, tag);
        if (diff >= tol) failures++;
    }

    cudaFree(d_k);
    cudaFree(d_scores);

    std::printf("[cuda_verify] %s — %d/%d passed (tol=%.0e)\n",
                failures == 0 ? "PASS" : "FAIL",
                n_outputs - failures, n_outputs, (double)tol);
    return failures == 0 ? 0 : 1;
}
