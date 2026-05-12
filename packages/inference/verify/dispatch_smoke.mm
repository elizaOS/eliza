// Metal graph-dispatch smoke for the shipped Eliza-1 attention-score ops.
//
// This is intentionally not a standalone shader test. It links against the
// patched fork's libggml-metal.dylib and drives real GGML graphs containing:
//   - GGML_OP_ATTN_SCORE_QJL
//   - GGML_OP_ATTN_SCORE_TBQ   (TBQ3, TBQ4, TBQ3_TCQ)
//   - GGML_OP_ATTN_SCORE_POLAR (use_qjl=0 and use_qjl=1)
//   - GGML_OP_FUSED_ATTN_QJL_TBQ
//
// PASS means graph execution selected the shipped Metal kernels and the output
// numerically matches the reference implementations.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-metal.h"

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

static void fill_q_heads(std::vector<float> & q_heads) {
    for (int h = 0; h < N_HEADS; ++h) {
        for (int i = 0; i < HEAD_DIM; ++i) {
            q_heads[h * HEAD_DIM + i] =
                std::cos(0.031f * (float) (h * HEAD_DIM + i)) -
                0.3f * std::sin(0.047f * (float) i);
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

static bool check_scores(
        const char * label,
        const std::vector<float> & got,
        const std::vector<float> & expected,
        float * max_err_out) {
    float max_err = 0.0f;
    for (int h = 0; h < N_HEADS; ++h) {
        for (int t = 0; t < N_TOKENS; ++t) {
            const int idx = h * N_TOKENS + t;
            const float err = std::fabs(expected[idx] - got[idx]);
            if (!std::isfinite(got[idx]) || err > TOL) {
                std::fprintf(stderr,
                    "[dispatch_smoke] %s FAIL h=%d t=%d expected=%+.6f got=%+.6f diff=%.3e\n",
                    label, h, t, expected[idx], got[idx], err);
                return false;
            }
            if (err > max_err) max_err = err;
        }
    }
    *max_err_out = max_err;
    return true;
}

static bool compute_graph(
        ggml_context * ctx,
        ggml_cgraph * gf,
        ggml_tensor * q,
        const void * q_data,
        size_t q_bytes,
        ggml_tensor * pk,
        const void * pk_data,
        size_t pk_bytes,
        ggml_tensor * scores,
        std::vector<float> & got) {
    ggml_backend_t backend = ggml_backend_metal_init();
    if (!backend) {
        std::fprintf(stderr, "[dispatch_smoke] ggml_backend_metal_init failed\n");
        return false;
    }

    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
    if (!buf) {
        std::fprintf(stderr, "[dispatch_smoke] alloc_ctx_tensors failed\n");
        ggml_backend_free(backend);
        return false;
    }

    ggml_backend_tensor_set(q, q_data, 0, q_bytes);
    ggml_backend_tensor_set(pk, pk_data, 0, pk_bytes);

    const ggml_status status = ggml_backend_graph_compute(backend, gf);
    if (status != GGML_STATUS_SUCCESS) {
        std::fprintf(stderr,
            "[dispatch_smoke] graph_compute returned status=%d\n",
            (int) status);
        ggml_backend_buffer_free(buf);
        ggml_backend_free(backend);
        return false;
    }

    got.assign(N_HEADS * N_TOKENS, 0.0f);
    ggml_backend_tensor_get(scores, got.data(), 0, got.size() * sizeof(float));

    ggml_backend_buffer_free(buf);
    ggml_backend_free(backend);
    return true;
}

static bool compute_graph3(
        ggml_context * ctx,
        ggml_cgraph * gf,
        ggml_tensor * src0,
        const void * src0_data,
        size_t src0_bytes,
        ggml_tensor * src1,
        const void * src1_data,
        size_t src1_bytes,
        ggml_tensor * src2,
        const void * src2_data,
        size_t src2_bytes,
        ggml_tensor * dst,
        std::vector<float> & got) {
    ggml_backend_t backend = ggml_backend_metal_init();
    if (!backend) {
        std::fprintf(stderr, "[dispatch_smoke] ggml_backend_metal_init failed\n");
        return false;
    }

    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
    if (!buf) {
        std::fprintf(stderr, "[dispatch_smoke] alloc_ctx_tensors failed\n");
        ggml_backend_free(backend);
        return false;
    }

    ggml_backend_tensor_set(src0, src0_data, 0, src0_bytes);
    ggml_backend_tensor_set(src1, src1_data, 0, src1_bytes);
    ggml_backend_tensor_set(src2, src2_data, 0, src2_bytes);

    const ggml_status status = ggml_backend_graph_compute(backend, gf);
    if (status != GGML_STATUS_SUCCESS) {
        std::fprintf(stderr,
            "[dispatch_smoke] graph_compute returned status=%d\n",
            (int) status);
        ggml_backend_buffer_free(buf);
        ggml_backend_free(backend);
        return false;
    }

    got.assign(HEAD_DIM * N_HEADS, 0.0f);
    ggml_backend_tensor_get(dst, got.data(), 0, got.size() * sizeof(float));

    ggml_backend_buffer_free(buf);
    ggml_backend_free(backend);
    return true;
}

static bool run_qjl_smoke(float * max_err_out) {
    const size_t row_size = ggml_row_size(GGML_TYPE_QJL1_256, HEAD_DIM);
    if (row_size != sizeof(block_qjl1_256_smoke)) {
        std::fprintf(stderr,
            "[dispatch_smoke] QJL row size mismatch: ggml=%zu local=%zu\n",
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
            "[dispatch_smoke] ggml_quantize_chunk(QJL) wrote %zu bytes, expected %zu\n",
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

    std::vector<float> got;
    const bool ok = compute_graph(ctx, gf, q, q_sketch.data(), q_sketch.size() * sizeof(float),
                                  pk, packed.data(), packed.size(), scores, got) &&
                    check_scores("QJL", got, expected, max_err_out);
    ggml_free(ctx);
    return ok;
}

template <typename Block>
static bool run_tbq_smoke(
        const char * label,
        ggml_type type,
        void (*quantize)(const float *, Block *),
        float (*dot)(const float *, const Block *),
        int blocks_per_row,
        float * max_err_out) {
    const size_t row_size = ggml_row_size(type, HEAD_DIM);
    if (row_size != sizeof(Block) * (size_t) blocks_per_row) {
        std::fprintf(stderr,
            "[dispatch_smoke] %s row size mismatch: ggml=%zu local=%zu\n",
            label, row_size, sizeof(Block) * (size_t) blocks_per_row);
        return false;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> q_heads(N_HEADS * HEAD_DIM);
    fill_k_rows(k_rows);
    fill_q_heads(q_heads);

    std::vector<Block> blocks(N_TOKENS * N_KV_HEADS * blocks_per_row);
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        quantize(k_rows.data() + row * HEAD_DIM, blocks.data() + row * blocks_per_row);
    }

    std::vector<float> expected(N_HEADS * N_TOKENS);
    const int gqa = N_HEADS / N_KV_HEADS;
    for (int h = 0; h < N_HEADS; ++h) {
        const int h_k = h / gqa;
        for (int t = 0; t < N_TOKENS; ++t) {
            expected[h * N_TOKENS + t] =
                dot(q_heads.data() + h * HEAD_DIM,
                    blocks.data() + (h_k * N_TOKENS + t) * blocks_per_row);
        }
    }

    ggml_context * ctx = ggml_init({ 16 * 1024 * 1024, nullptr, true });
    if (!ctx) return false;
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, HEAD_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(ctx, type, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * scores = ggml_attn_score_tbq(ctx, q, pk, N_KV_HEADS);
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, scores);

    std::vector<float> got;
    const bool ok = compute_graph(ctx, gf, q, q_heads.data(), q_heads.size() * sizeof(float),
                                  pk, blocks.data(), blocks.size() * sizeof(Block), scores, got) &&
                    check_scores(label, got, expected, max_err_out);
    ggml_free(ctx);
    return ok;
}

static void quantize_turbo3_adapter(const float * src, eliza_block_turbo3_0 * dst) {
    eliza_quantize_turbo3_group(src, dst);
}

static float dot_turbo3_adapter(const float * q, const eliza_block_turbo3_0 * k) {
    return eliza_dot_q_turbo3(q, k);
}

static void quantize_turbo4_adapter(const float * src, eliza_block_turbo4_0 * dst) {
    eliza_quantize_turbo4_block(src, dst);
}

static float dot_turbo4_adapter(const float * q, const eliza_block_turbo4_0 * k) {
    return eliza_dot_q_turbo4(q, k);
}

static void quantize_turbo3_tcq_adapter(const float * src, eliza_block_turbo3_tcq * dst) {
    eliza_quantize_turbo3_tcq_block(src, dst);
}

static float dot_turbo3_tcq_adapter(const float * q, const eliza_block_turbo3_tcq * k) {
    return eliza_dot_q_turbo3_tcq(q, k);
}

static bool run_polar_smoke(bool use_qjl, bool preht, float * max_err_out) {
    const char * label = preht
        ? (use_qjl ? "PolarQuantPreHT(use_qjl=1)" : "PolarQuantPreHT(use_qjl=0)")
        : (use_qjl ? "PolarQuant(use_qjl=1)" : "PolarQuant(use_qjl=0)");
    const size_t row_size = ggml_row_size(GGML_TYPE_Q4_POLAR, HEAD_DIM);
    if (row_size != sizeof(eliza_block_q4_polar)) {
        std::fprintf(stderr,
            "[dispatch_smoke] %s row size mismatch: ggml=%zu local=%zu\n",
            label, row_size, sizeof(eliza_block_q4_polar));
        return false;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> q_heads(N_HEADS * HEAD_DIM);
    fill_k_rows(k_rows);
    fill_q_heads(q_heads);
    std::vector<float> q_input = q_heads;
    if (preht) {
        for (int h = 0; h < N_HEADS; ++h) {
            eliza_polar_hadamard_inplace(q_input.data() + h * HEAD_DIM);
        }
    }

    std::vector<eliza_block_q4_polar> blocks(N_TOKENS * N_KV_HEADS);
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        eliza_polar_quantize_row(
            k_rows.data() + row * HEAD_DIM,
            blocks.data() + row,
            HEAD_DIM,
            use_qjl ? 1 : 0);
    }

    std::vector<float> expected(N_HEADS * N_TOKENS);
    const int gqa = N_HEADS / N_KV_HEADS;
    for (int h = 0; h < N_HEADS; ++h) {
        const int h_k = h / gqa;
        for (int t = 0; t < N_TOKENS; ++t) {
            eliza_polar_mul_mv(
                blocks.data() + h_k * N_TOKENS + t,
                q_heads.data() + h * HEAD_DIM,
                1,
                use_qjl ? 1 : 0,
                expected.data() + h * N_TOKENS + t);
        }
    }

    ggml_context * ctx = ggml_init({ 16 * 1024 * 1024, nullptr, true });
    if (!ctx) return false;
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, HEAD_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(ctx, GGML_TYPE_Q4_POLAR, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * scores = preht
        ? ggml_attn_score_polar_preht(ctx, q, pk, N_KV_HEADS, use_qjl)
        : ggml_attn_score_polar(ctx, q, pk, N_KV_HEADS, use_qjl);
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, scores);

    std::vector<float> got;
    const bool ok = compute_graph(ctx, gf, q, q_input.data(), q_input.size() * sizeof(float),
                                  pk, blocks.data(), blocks.size() * sizeof(eliza_block_q4_polar), scores, got) &&
                    check_scores(label, got, expected, max_err_out);
    ggml_free(ctx);
    return ok;
}

static bool run_fused_qjl_tbq_smoke(float * max_err_out) {
    const size_t k_row_size = ggml_row_size(GGML_TYPE_QJL1_256, HEAD_DIM);
    const size_t v_row_size = ggml_row_size(GGML_TYPE_TBQ3_0, HEAD_DIM);
    if (k_row_size != sizeof(eliza_block_qjl1_256)) {
        std::fprintf(stderr,
            "[dispatch_smoke] fused QJL row size mismatch: ggml=%zu local=%zu\n",
            k_row_size, sizeof(eliza_block_qjl1_256));
        return false;
    }
    if (v_row_size != sizeof(eliza_block_tbq3_0) * ELIZA_FUSED_TBQ_PER_TOKEN) {
        std::fprintf(stderr,
            "[dispatch_smoke] fused TBQ3 row size mismatch: ggml=%zu local=%zu\n",
            v_row_size, sizeof(eliza_block_tbq3_0) * (size_t) ELIZA_FUSED_TBQ_PER_TOKEN);
        return false;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> v_rows(N_TOKENS * N_KV_HEADS * HEAD_DIM);
    std::vector<float> q_sketch(N_HEADS * QJL_PROJ_DIM);
    fill_k_rows(k_rows);
    fill_k_rows(v_rows);
    fill_qjl_sketch(q_sketch);

    std::vector<uint8_t> packed_k(k_row_size * N_TOKENS * N_KV_HEADS);
    const size_t written = ggml_quantize_chunk(
        GGML_TYPE_QJL1_256,
        k_rows.data(),
        packed_k.data(),
        /*start=*/0,
        /*nrows=*/N_TOKENS * N_KV_HEADS,
        /*n_per_row=*/HEAD_DIM,
        /*imatrix=*/nullptr);
    if (written != packed_k.size()) {
        std::fprintf(stderr,
            "[dispatch_smoke] ggml_quantize_chunk(QJL fused K) wrote %zu bytes, expected %zu\n",
            written, packed_k.size());
        return false;
    }

    std::vector<eliza_block_tbq3_0> packed_v(
        N_TOKENS * N_KV_HEADS * ELIZA_FUSED_TBQ_PER_TOKEN);
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        for (int c = 0; c < ELIZA_FUSED_TBQ_PER_TOKEN; ++c) {
            eliza_quantize_tbq3_block(
                v_rows.data() + row * HEAD_DIM + c * ELIZA_FUSED_TBQ_BLOCK,
                packed_v.data() + row * ELIZA_FUSED_TBQ_PER_TOKEN + c);
        }
    }

    std::vector<float> expected(HEAD_DIM * N_HEADS, 0.0f);
    const float sm_scale = 1.0f / std::sqrt((float) HEAD_DIM);
    eliza_fused_attn_qjl_tbq3(
        q_sketch.data(),
        reinterpret_cast<const eliza_block_qjl1_256 *>(packed_k.data()),
        packed_v.data(),
        N_HEADS,
        N_KV_HEADS,
        N_TOKENS,
        sm_scale,
        expected.data());

    ggml_context * ctx = ggml_init({ 16 * 1024 * 1024, nullptr, true });
    if (!ctx) return false;
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, QJL_PROJ_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(ctx, GGML_TYPE_QJL1_256, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * pv = ggml_new_tensor_4d(ctx, GGML_TYPE_TBQ3_0, HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_tensor * out = ggml_fused_attn_qjl_tbq(ctx, q, pk, pv, N_KV_HEADS, sm_scale);
    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, out);

    std::vector<float> got;
    const bool ok = compute_graph3(ctx, gf,
                                   q, q_sketch.data(), q_sketch.size() * sizeof(float),
                                   pk, packed_k.data(), packed_k.size(),
                                   pv, packed_v.data(), packed_v.size() * sizeof(eliza_block_tbq3_0),
                                   out, got);
    if (ok) {
        float max_err = 0.0f;
        for (int i = 0; i < HEAD_DIM * N_HEADS; ++i) {
            const float err = std::fabs(expected[i] - got[i]);
            if (!std::isfinite(got[i]) || err > TOL) {
                std::fprintf(stderr,
                    "[dispatch_smoke] FusedQjlTbq FAIL i=%d expected=%+.6f got=%+.6f diff=%.3e\n",
                    i, expected[i], got[i], err);
                ggml_free(ctx);
                return false;
            }
            if (err > max_err) max_err = err;
        }
        *max_err_out = max_err;
    }
    ggml_free(ctx);
    return ok;
}

} // namespace

int main() {
    struct Case {
        const char * label;
        bool (*run)(float *);
    };

    const Case cases[] = {
        { "GGML_OP_ATTN_SCORE_QJL", run_qjl_smoke },
        { "GGML_OP_ATTN_SCORE_TBQ/turbo3", [](float * e) {
            return run_tbq_smoke<eliza_block_turbo3_0>(
                "TurboQuant3", GGML_TYPE_TBQ3_0,
                quantize_turbo3_adapter, dot_turbo3_adapter, 4, e);
        }},
        { "GGML_OP_ATTN_SCORE_TBQ/turbo4", [](float * e) {
            return run_tbq_smoke<eliza_block_turbo4_0>(
                "TurboQuant4", GGML_TYPE_TBQ4_0,
                quantize_turbo4_adapter, dot_turbo4_adapter, 4, e);
        }},
        { "GGML_OP_ATTN_SCORE_TBQ/turbo3_tcq", [](float * e) {
            return run_tbq_smoke<eliza_block_turbo3_tcq>(
                "TurboQuant3_TCQ", GGML_TYPE_TBQ3_TCQ,
                quantize_turbo3_tcq_adapter, dot_turbo3_tcq_adapter, 1, e);
        }},
        { "GGML_OP_ATTN_SCORE_POLAR/use_qjl=0", [](float * e) {
            return run_polar_smoke(false, false, e);
        }},
        { "GGML_OP_ATTN_SCORE_POLAR/use_qjl=1", [](float * e) {
            return run_polar_smoke(true, false, e);
        }},
        { "GGML_OP_ATTN_SCORE_POLAR_PREHT/use_qjl=0", [](float * e) {
            return run_polar_smoke(false, true, e);
        }},
        { "GGML_OP_ATTN_SCORE_POLAR_PREHT/use_qjl=1", [](float * e) {
            return run_polar_smoke(true, true, e);
        }},
        { "GGML_OP_FUSED_ATTN_QJL_TBQ", run_fused_qjl_tbq_smoke },
    };

    int failures = 0;
    for (const Case & c : cases) {
        float max_err = 0.0f;
        if (!c.run(&max_err)) {
            std::fprintf(stderr, "[dispatch_smoke] FAIL %s\n", c.label);
            ++failures;
            continue;
        }
        std::printf("[dispatch_smoke] PASS %s: %d scores, max diff %.3e\n",
                    c.label, N_HEADS * N_TOKENS, max_err);
    }

    if (failures != 0) {
        std::fprintf(stderr,
            "[dispatch_smoke] FAIL Metal dispatch suite: %d graph route(s) failed\n",
            failures);
        return 1;
    }

    std::printf("[dispatch_smoke] PASS Metal dispatch suite: %zu graph routes\n",
                sizeof(cases) / sizeof(cases[0]));
    return 0;
}
