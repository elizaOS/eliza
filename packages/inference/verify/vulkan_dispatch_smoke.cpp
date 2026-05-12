// Vulkan graph-dispatch smoke for the shipped Eliza-1 fused attention ops.
//
// This is intentionally not a standalone SPIR-V test. It links against the
// patched fork's libggml-vulkan and drives real GGML graphs containing the two
// fused attention ops the committed fork pin exposes in ggml.h:
//   - GGML_OP_ATTN_SCORE_QJL       (ggml_attn_score_qjl)
//   - GGML_OP_FUSED_ATTN_QJL_TBQ   (ggml_fused_attn_qjl_tbq)
//
// PASS means ggml-vulkan advertises support for the graph op, selected the
<<<<<<< HEAD
// shipped eliza Vulkan pipeline, and the numeric output matches the C
// reference. The standalone TurboQuant / PolarQuant score+softmax+V-mix
// kernels are exercised by `make vulkan-verify` against the JSON fixtures and
// by the actual fork llama-server --cache-type-{k,v} whitelist; they are not
// public ggml graph builders in the fork pin, so they are not part of this
// graph-dispatch gate.
=======
// shipped eliza Vulkan pipeline, and the numeric output matches the reference.
>>>>>>> origin/shaw/fine-tune-apollo-pipeline

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-vulkan.h"

extern "C" {
#include "../reference/turbo_kernels.h"
#include "qjl_polar_ref.h"
}

namespace {

constexpr int HEAD_DIM = 128;
constexpr int QJL_PROJ_DIM = 256;
constexpr int N_HEADS = 4;
constexpr int N_KV_HEADS = 2;
constexpr int N_TOKENS = 8;
constexpr float TOL = 1e-3f;

static std::string lower_ascii(const char * s) {
    std::string out = s ? s : "";
    for (char & c : out) {
        if (c >= 'A' && c <= 'Z') c = (char) (c - 'A' + 'a');
    }
    return out;
}

static bool software_vulkan_allowed() {
    const char * value = std::getenv("ELIZA_ALLOW_SOFTWARE_VULKAN");
    return value && std::strcmp(value, "1") == 0;
}

static bool looks_like_software_vulkan_device(const char * name) {
    const std::string device = lower_ascii(name);
    return device.find("llvmpipe") != std::string::npos ||
           device.find("lavapipe") != std::string::npos ||
           device.find("swiftshader") != std::string::npos ||
           device.find("software rasterizer") != std::string::npos;
}

struct block_qjl1_256_smoke {
    uint8_t qs[ELIZA_QJL_PACKED_BYTES];
    uint16_t norm_bf16;
};

static float bf16_to_f32(uint16_t v) {
    uint32_t u = ((uint32_t) v) << 16;
    float out;
    std::memcpy(&out, &u, sizeof(out));
    return out;
}

static void fill_k_rows(std::vector<float> & k_rows) {
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        for (int i = 0; i < HEAD_DIM; ++i) {
            k_rows[row * HEAD_DIM + i] =
                0.6f * std::sin(0.017f * (float) (row * HEAD_DIM + i)) +
                0.2f * std::cos(0.071f * (float) (i + 3 * row));
        }
    }
}

static void fill_qjl_sketch(std::vector<float> & q_sketch) {
    for (int h = 0; h < N_HEADS; ++h) {
        for (int j = 0; j < QJL_PROJ_DIM; ++j) {
            q_sketch[h * QJL_PROJ_DIM + j] =
                std::cos(0.031f * (float) (h * QJL_PROJ_DIM + j)) -
                0.3f * std::sin(0.047f * (float) j);
        }
    }
}

static float qjl_ref_score(
        const float * q_sketch,
        const block_qjl1_256_smoke * blocks,
        int h_q,
        int token) {
    const int gqa = N_HEADS / N_KV_HEADS;
    const int h_k = h_q / gqa;
    const block_qjl1_256_smoke * blk = blocks + h_k * N_TOKENS + token;
    const float * q = q_sketch + h_q * QJL_PROJ_DIM;

    float acc = 0.0f;
    for (int j = 0; j < QJL_PROJ_DIM; ++j) {
        const uint8_t bits = blk->qs[j >> 3];
        const bool sign = ((bits >> (j & 7)) & 1u) != 0;
        acc += sign ? q[j] : -q[j];
    }
    constexpr float scale = 1.2533141373155003f / (float) QJL_PROJ_DIM;
    return scale * bf16_to_f32(blk->norm_bf16) * acc;
}

// GGML_OP_ATTN_SCORE_QJL — QJL 1-bit packed-K cosine-similarity score.
// Numeric comparison against qjl_ref_score (= the QJL paper's unbiased
// estimator, which the fork's CPU op also implements bit-for-bit).
static bool run_qjl_score_smoke(int * outputs, float * max_err_out) {
    const size_t row_size = ggml_row_size(GGML_TYPE_QJL1_256, HEAD_DIM);
    if (row_size != sizeof(block_qjl1_256_smoke)) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] QJL row size mismatch: ggml=%zu local=%zu\n",
            row_size, sizeof(block_qjl1_256_smoke));
        return false;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> q_sketch(N_HEADS * QJL_PROJ_DIM);
    fill_k_rows(k_rows);
    fill_qjl_sketch(q_sketch);

    std::vector<uint8_t> packed(row_size * N_TOKENS * N_KV_HEADS);
    const size_t written = ggml_quantize_chunk(
        GGML_TYPE_QJL1_256,
        k_rows.data(),
        packed.data(),
        /*start=*/0,
        /*nrows=*/N_TOKENS * N_KV_HEADS,
        /*n_per_row=*/HEAD_DIM,
        /*imatrix=*/nullptr);
    if (written != packed.size()) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] ggml_quantize_chunk(QJL) wrote %zu bytes, expected %zu\n",
            written, packed.size());
        return false;
    }

    std::vector<float> expected(N_HEADS * N_TOKENS);
    const auto * blocks = reinterpret_cast<const block_qjl1_256_smoke *>(packed.data());
    for (int h = 0; h < N_HEADS; ++h) {
        for (int t = 0; t < N_TOKENS; ++t) {
            expected[h * N_TOKENS + t] = qjl_ref_score(q_sketch.data(), blocks, h, t);
        }
    }

    ggml_context * ctx = ggml_init({ 16 * 1024 * 1024, nullptr, true });
    if (!ctx) return false;
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, QJL_PROJ_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(ctx, GGML_TYPE_QJL1_256, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * scores = ggml_attn_score_qjl(ctx, q, pk, N_KV_HEADS);
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, scores);

    ggml_backend_t backend = ggml_backend_vk_init(0);
    if (!backend) {
        std::fprintf(stderr, "[vulkan_dispatch_smoke] ggml_backend_vk_init failed\n");
        ggml_free(ctx);
        return false;
    }
    if (!ggml_backend_supports_op(backend, scores)) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] ggml-vulkan does not advertise support for GGML_OP_ATTN_SCORE_QJL\n");
        ggml_backend_free(backend);
        ggml_free(ctx);
        return false;
    }
    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
    if (!buf) { ggml_backend_free(backend); ggml_free(ctx); return false; }
    ggml_backend_tensor_set(q, q_sketch.data(), 0, q_sketch.size() * sizeof(float));
    ggml_backend_tensor_set(pk, packed.data(), 0, packed.size());
    const ggml_status st = ggml_backend_graph_compute(backend, gf);
    bool ok = st == GGML_STATUS_SUCCESS;
    if (!ok) std::fprintf(stderr, "[vulkan_dispatch_smoke] QJL graph_compute status=%d\n", (int) st);
    std::vector<float> got(N_HEADS * N_TOKENS, 0.0f);
    if (ok) ggml_backend_tensor_get(scores, got.data(), 0, got.size() * sizeof(float));
    ggml_backend_buffer_free(buf);
    ggml_backend_free(backend);
    ggml_free(ctx);
    if (!ok) return false;

    float max_err = 0.0f;
    for (int h = 0; h < N_HEADS; ++h) {
        for (int t = 0; t < N_TOKENS; ++t) {
            const int idx = h * N_TOKENS + t;
            const float err = std::fabs(expected[idx] - got[idx]);
            if (!std::isfinite(got[idx]) || err > TOL) {
                std::fprintf(stderr,
                    "[vulkan_dispatch_smoke] QJL FAIL h=%d t=%d expected=%+.6f got=%+.6f diff=%.3e\n",
                    h, t, expected[idx], got[idx], err);
                return false;
            }
            if (err > max_err) max_err = err;
        }
    }
    *outputs = N_HEADS * N_TOKENS;
    *max_err_out = max_err;
    return true;
}

// GGML_OP_FUSED_ATTN_QJL_TBQ — fused QJL-K score + online softmax + TBQ3-V mix.
// Numeric comparison against eliza_fused_attn_qjl_tbq3() (the backend-neutral C
// reference; bit-exact to the fork's CPU op). Output is [head_dim=128, n_heads]
// fp32 for q_pos = 0.
static bool run_fused_attn_smoke(int * outputs, float * max_err_out) {
    constexpr int PROJ_DIM = ELIZA_QJL_PROJECTION_DIM;  // 256
    static_assert(PROJ_DIM == QJL_PROJ_DIM, "QJL sketch dim mismatch");
    const float sm_scale = 1.0f / std::sqrt((float) HEAD_DIM);

    const size_t k_row_size = ggml_row_size(GGML_TYPE_QJL1_256, HEAD_DIM);
    const size_t v_row_size = ggml_row_size(GGML_TYPE_TBQ3_0, HEAD_DIM);
    if (k_row_size != sizeof(eliza_block_qjl1_256) ||
        v_row_size != sizeof(eliza_block_tbq3_0) * ELIZA_FUSED_TBQ_PER_TOKEN) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] FusedAttn row-size mismatch: k ggml=%zu local=%zu, v ggml=%zu local=%zu*%d\n",
            k_row_size, sizeof(eliza_block_qjl1_256), v_row_size,
            sizeof(eliza_block_tbq3_0), ELIZA_FUSED_TBQ_PER_TOKEN);
        return false;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> v_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> q_sketch(N_HEADS * PROJ_DIM);
    fill_k_rows(k_rows);
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        for (int i = 0; i < HEAD_DIM; ++i) {
            v_rows[row * HEAD_DIM + i] =
                0.45f * std::cos(0.013f * (float) (row * HEAD_DIM + i)) -
                0.25f * std::sin(0.059f * (float) (i + 5 * row));
        }
    }
    for (int h = 0; h < N_HEADS; ++h) {
        for (int j = 0; j < PROJ_DIM; ++j) {
            q_sketch[h * PROJ_DIM + j] =
                std::cos(0.021f * (float) (h * PROJ_DIM + j)) -
                0.27f * std::sin(0.043f * (float) j);
        }
    }

    std::vector<uint8_t> packed_k(k_row_size * N_TOKENS * N_KV_HEADS);
    std::vector<uint8_t> packed_v(v_row_size * N_TOKENS * N_KV_HEADS);
    const size_t wk = ggml_quantize_chunk(GGML_TYPE_QJL1_256, k_rows.data(), packed_k.data(),
                                          0, N_TOKENS * N_KV_HEADS, HEAD_DIM, nullptr);
    const size_t wv = ggml_quantize_chunk(GGML_TYPE_TBQ3_0, v_rows.data(), packed_v.data(),
                                          0, N_TOKENS * N_KV_HEADS, HEAD_DIM, nullptr);
    if (wk != packed_k.size() || wv != packed_v.size()) {
        std::fprintf(stderr, "[vulkan_dispatch_smoke] FusedAttn quantize wrote k=%zu/%zu v=%zu/%zu\n",
                     wk, packed_k.size(), wv, packed_v.size());
        return false;
    }

    std::vector<float> expected(N_HEADS * HEAD_DIM);
    eliza_fused_attn_qjl_tbq3(
        q_sketch.data(),
        reinterpret_cast<const eliza_block_qjl1_256 *>(packed_k.data()),
        reinterpret_cast<const eliza_block_tbq3_0 *>(packed_v.data()),
        N_HEADS, N_KV_HEADS, N_TOKENS, sm_scale, expected.data());

    ggml_context * ctx = ggml_init({ 16 * 1024 * 1024, nullptr, true });
    if (!ctx) return false;
    ggml_tensor * q  = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, PROJ_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(ctx, GGML_TYPE_QJL1_256, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * pv = ggml_new_tensor_4d(ctx, GGML_TYPE_TBQ3_0, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * out = ggml_fused_attn_qjl_tbq(ctx, q, pk, pv, N_KV_HEADS, sm_scale);
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, out);

    ggml_backend_t backend = ggml_backend_vk_init(0);
    if (!backend) { ggml_free(ctx); return false; }
    if (!ggml_backend_supports_op(backend, out)) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] ggml-vulkan does not advertise support for GGML_OP_FUSED_ATTN_QJL_TBQ\n");
        ggml_backend_free(backend);
        ggml_free(ctx);
        return false;
    }
    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
    if (!buf) { ggml_backend_free(backend); ggml_free(ctx); return false; }
    ggml_backend_tensor_set(q, q_sketch.data(), 0, q_sketch.size() * sizeof(float));
    ggml_backend_tensor_set(pk, packed_k.data(), 0, packed_k.size());
    ggml_backend_tensor_set(pv, packed_v.data(), 0, packed_v.size());
    const ggml_status st = ggml_backend_graph_compute(backend, gf);
    bool ok = st == GGML_STATUS_SUCCESS;
    if (!ok) {
        std::fprintf(stderr, "[vulkan_dispatch_smoke] FusedAttn graph_compute status=%d\n", (int) st);
    }
    std::vector<float> got(N_HEADS * HEAD_DIM, 0.0f);
    if (ok) ggml_backend_tensor_get(out, got.data(), 0, got.size() * sizeof(float));
    ggml_backend_buffer_free(buf);
    ggml_backend_free(backend);
    ggml_free(ctx);
    if (!ok) return false;

    float max_err = 0.0f;
    for (int h = 0; h < N_HEADS; ++h) {
        for (int d = 0; d < HEAD_DIM; ++d) {
            const int idx = h * HEAD_DIM + d;
            const float err = std::fabs(expected[idx] - got[idx]);
            if (!std::isfinite(got[idx]) || err > TOL) {
                std::fprintf(stderr,
                    "[vulkan_dispatch_smoke] FusedAttn FAIL h=%d d=%d expected=%+.6f got=%+.6f diff=%.3e\n",
                    h, d, expected[idx], got[idx], err);
                return false;
            }
            if (err > max_err) max_err = err;
        }
    }
    *outputs = N_HEADS * HEAD_DIM;
    *max_err_out = max_err;
    return true;
}

} // namespace

int main() {
    const int device_count = ggml_backend_vk_get_device_count();
    if (device_count <= 0) {
        std::fprintf(stderr, "[vulkan_dispatch_smoke] no Vulkan devices visible to ggml-vulkan\n");
        return 1;
    }
    char desc[256] = {};
    ggml_backend_vk_get_device_description(0, desc, sizeof(desc));
    std::printf("[vulkan_dispatch_smoke] device=%s\n", desc);
    if (!software_vulkan_allowed() && looks_like_software_vulkan_device(desc)) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] refusing software Vulkan device '%s'. "
            "Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 for diagnostics only.\n",
            desc);
        return 2;
    }

    struct Case {
        const char * label;
        bool (*run)(int *, float *);
    };

    const Case cases[] = {
        { "GGML_OP_ATTN_SCORE_QJL", run_qjl_score_smoke },
        { "GGML_OP_FUSED_ATTN_QJL_TBQ", run_fused_attn_smoke },
    };

    int failures = 0;
    for (const Case & c : cases) {
        int outputs = 0;
        float max_err = 0.0f;
        if (!c.run(&outputs, &max_err)) {
            std::fprintf(stderr, "[vulkan_dispatch_smoke] FAIL %s\n", c.label);
            ++failures;
            continue;
        }
        std::printf("[vulkan_dispatch_smoke] PASS %s: %d outputs, max diff %.3e\n",
                    c.label, outputs, max_err);
    }

    if (failures != 0) {
        std::fprintf(stderr,
            "[vulkan_dispatch_smoke] FAIL Vulkan dispatch suite: %d graph route(s) failed\n",
            failures);
        return 1;
    }

    std::printf("[vulkan_dispatch_smoke] PASS Vulkan dispatch suite: %zu graph routes (QJL score + fused QJL-K/TBQ-V attention)\n",
                sizeof(cases) / sizeof(cases[0]));
    return 0;
}
