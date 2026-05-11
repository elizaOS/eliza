// Metal graph-dispatch smoke for the shipped Eliza-1 QJL attention op.
//
// This is intentionally not a standalone shader test. It links against the
// patched fork's libggml-metal.dylib and drives a real GGML graph containing
// GGML_OP_ATTN_SCORE_QJL. PASS means the build patch wired the graph op to
// kernel_attn_score_qjl1_256 and the numeric output matches the QJL score
// formula on the packed bytes.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-metal.h"

namespace {

constexpr int QJL_HEAD_DIM = 128;
constexpr int QJL_PROJ_DIM = 256;
constexpr int QJL_PACKED_BYTES = 32;
constexpr int N_HEADS = 4;
constexpr int N_KV_HEADS = 2;
constexpr int N_TOKENS = 8;
constexpr float TOL = 1e-3f;

struct block_qjl1_256_smoke {
    uint8_t qs[QJL_PACKED_BYTES];
    uint16_t norm_bf16;
};

static float bf16_to_f32(uint16_t v) {
    uint32_t u = ((uint32_t) v) << 16;
    float out;
    std::memcpy(&out, &u, sizeof(out));
    return out;
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

static void fill_inputs(std::vector<float> & k_rows, std::vector<float> & q_sketch) {
    for (int row = 0; row < N_TOKENS * N_KV_HEADS; ++row) {
        for (int i = 0; i < QJL_HEAD_DIM; ++i) {
            k_rows[row * QJL_HEAD_DIM + i] =
                0.6f * std::sin(0.017f * (float) (row * QJL_HEAD_DIM + i)) +
                0.2f * std::cos(0.071f * (float) (i + 3 * row));
        }
    }
    for (int h = 0; h < N_HEADS; ++h) {
        for (int j = 0; j < QJL_PROJ_DIM; ++j) {
            q_sketch[h * QJL_PROJ_DIM + j] =
                std::cos(0.031f * (float) (h * QJL_PROJ_DIM + j)) -
                0.3f * std::sin(0.047f * (float) j);
        }
    }
}

} // namespace

int main() {
    const size_t row_size = ggml_row_size(GGML_TYPE_QJL1_256, QJL_HEAD_DIM);
    if (row_size != sizeof(block_qjl1_256_smoke)) {
        std::fprintf(stderr,
            "[dispatch_smoke] QJL row size mismatch: ggml=%zu local=%zu\n",
            row_size, sizeof(block_qjl1_256_smoke));
        return 1;
    }

    std::vector<float> k_rows(N_TOKENS * N_KV_HEADS * QJL_HEAD_DIM);
    std::vector<float> q_sketch(N_HEADS * QJL_PROJ_DIM);
    fill_inputs(k_rows, q_sketch);

    std::vector<uint8_t> packed(row_size * N_TOKENS * N_KV_HEADS);
    const size_t written = ggml_quantize_chunk(
        GGML_TYPE_QJL1_256,
        k_rows.data(),
        packed.data(),
        /*start=*/0,
        /*nrows=*/N_TOKENS * N_KV_HEADS,
        /*n_per_row=*/QJL_HEAD_DIM,
        /*imatrix=*/nullptr);
    if (written != packed.size()) {
        std::fprintf(stderr,
            "[dispatch_smoke] ggml_quantize_chunk wrote %zu bytes, expected %zu\n",
            written, packed.size());
        return 1;
    }

    ggml_init_params params = {
        /*.mem_size   =*/ 16 * 1024 * 1024,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    ggml_context * ctx = ggml_init(params);
    if (!ctx) {
        std::fprintf(stderr, "[dispatch_smoke] ggml_init failed\n");
        return 1;
    }

    ggml_tensor * q = ggml_new_tensor_4d(
        ctx, GGML_TYPE_F32, QJL_PROJ_DIM, N_HEADS, 1, 1);
    ggml_tensor * pk = ggml_new_tensor_4d(
        ctx, GGML_TYPE_QJL1_256, QJL_HEAD_DIM, N_TOKENS, N_KV_HEADS, 1);
    ggml_set_name(q, "q_sketch");
    ggml_set_name(pk, "packed_k_qjl");

    ggml_tensor * scores = ggml_attn_score_qjl(ctx, q, pk, N_KV_HEADS);
    ggml_set_name(scores, "scores_qjl");

    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, scores);

    ggml_backend_t backend = ggml_backend_metal_init();
    if (!backend) {
        std::fprintf(stderr, "[dispatch_smoke] ggml_backend_metal_init failed\n");
        ggml_free(ctx);
        return 1;
    }

    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
    if (!buf) {
        std::fprintf(stderr, "[dispatch_smoke] alloc_ctx_tensors failed\n");
        ggml_backend_free(backend);
        ggml_free(ctx);
        return 1;
    }

    ggml_backend_tensor_set(q, q_sketch.data(), 0, q_sketch.size() * sizeof(float));
    ggml_backend_tensor_set(pk, packed.data(), 0, packed.size());

    const ggml_status status = ggml_backend_graph_compute(backend, gf);
    if (status != GGML_STATUS_SUCCESS) {
        std::fprintf(stderr,
            "[dispatch_smoke] graph_compute returned status=%d\n",
            (int) status);
        ggml_backend_buffer_free(buf);
        ggml_backend_free(backend);
        ggml_free(ctx);
        return 1;
    }

    std::vector<float> got(N_HEADS * N_TOKENS, 0.0f);
    ggml_backend_tensor_get(scores, got.data(), 0, got.size() * sizeof(float));

    const auto * blocks =
        reinterpret_cast<const block_qjl1_256_smoke *>(packed.data());
    float max_err = 0.0f;
    for (int h = 0; h < N_HEADS; ++h) {
        for (int t = 0; t < N_TOKENS; ++t) {
            const float expected = qjl_ref_score(q_sketch.data(), blocks, h, t);
            const float actual = got[h * N_TOKENS + t];
            const float err = std::fabs(expected - actual);
            if (!std::isfinite(actual) || err > TOL) {
                std::fprintf(stderr,
                    "[dispatch_smoke] FAIL h=%d t=%d expected=%+.6f got=%+.6f diff=%.3e\n",
                    h, t, expected, actual, err);
                ggml_backend_buffer_free(buf);
                ggml_backend_free(backend);
                ggml_free(ctx);
                return 1;
            }
            if (err > max_err) max_err = err;
        }
    }

    std::printf(
        "[dispatch_smoke] PASS GGML_OP_ATTN_SCORE_QJL Metal dispatch: %d scores, max diff %.3e\n",
        N_HEADS * N_TOKENS, max_err);

    ggml_backend_buffer_free(buf);
    ggml_backend_free(backend);
    ggml_free(ctx);
    return 0;
}
