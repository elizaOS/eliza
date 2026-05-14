#include "models.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <vector>

static constexpr int64_t LLAMA_DFLASH_PER_SLOT_CTX_LOCAL = 512;

static int64_t dflash_max_cross_ctx() {
    static const int64_t val = [] {
        const char * e = getenv("GGML_DFLASH_MAX_CTX");
        return e ? (int64_t) atoi(e) : (int64_t) 4096;
    }();
    return val;
}

void llama_model_dflash_draft::load_arch_hparams(llama_model_loader & ml) {
    ml.get_key(LLM_KV_ATTENTION_LAYERNORM_RMS_EPS, hparams.f_norm_rms_eps);
    ml.get_key(LLM_KV_ATTENTION_CAUSAL,            hparams.causal_attn, false);
    ml.get_key(LLM_KV_DFLASH_BLOCK_SIZE,           hparams.dflash_block_size, false);
    ml.get_key(LLM_KV_DFLASH_MASK_TOKEN_ID,        hparams.dflash_mask_token_id, false);
    ml.get_key(LLM_KV_DFLASH_N_TARGET_FEATURES,    hparams.dflash_n_target_features, false);

    const std::string key = ml.llm_kv(LLM_KV_DFLASH_TARGET_LAYER_IDS);
    const int kid = gguf_find_key(ml.metadata, key.c_str());
    if (kid >= 0 && gguf_get_kv_type(ml.metadata, kid) == GGUF_TYPE_ARRAY) {
        const enum gguf_type arr_type = gguf_get_arr_type(ml.metadata, kid);
        const size_t n = gguf_get_arr_n(ml.metadata, kid);
        hparams.dflash_n_target_layers = std::min((uint32_t) n, (uint32_t) 8);
        const void * data = gguf_get_arr_data(ml.metadata, kid);
        for (uint32_t i = 0; i < hparams.dflash_n_target_layers; ++i) {
            if (arr_type == GGUF_TYPE_UINT32) {
                hparams.dflash_target_layer_ids[i] = ((const uint32_t *) data)[i];
            } else if (arr_type == GGUF_TYPE_INT32) {
                hparams.dflash_target_layer_ids[i] = (uint32_t) ((const int32_t *) data)[i];
            }
        }
    }

    switch (hparams.n_layer) {
        case 5: type = LLM_TYPE_0_6B; break;
        default: type = LLM_TYPE_UNKNOWN;
    }
}

void llama_model_dflash_draft::load_arch_tensors(llama_model_loader &) {
    LLAMA_LOAD_LOCALS;

    // Shared from the target model at runtime. The DFlash GGUF does not carry
    // standalone token or output embeddings.
    tok_embd = create_tensor(tn(LLM_TENSOR_TOKEN_EMBD, "weight"), {n_embd, n_vocab}, TENSOR_NOT_REQUIRED);
    output   = create_tensor(tn(LLM_TENSOR_OUTPUT,     "weight"), {n_embd, n_vocab}, TENSOR_NOT_REQUIRED);

    output_norm = create_tensor(tn(LLM_TENSOR_OUTPUT_NORM, "weight"), {n_embd}, 0);

    dflash_fc          = create_tensor(tn(LLM_TENSOR_DFLASH_FC,          "weight"), {(int64_t) hparams.dflash_n_target_features, n_embd}, 0);
    dflash_hidden_norm = create_tensor(tn(LLM_TENSOR_DFLASH_HIDDEN_NORM, "weight"), {n_embd}, 0);

    for (int i = 0; i < n_layer; ++i) {
        auto & layer = layers[i];

        layer.attn_norm      = create_tensor(tn(LLM_TENSOR_ATTN_NORM,      "weight", i), {n_embd}, 0);
        layer.attn_post_norm = create_tensor(tn(LLM_TENSOR_ATTN_POST_NORM, "weight", i), {n_embd}, 0);

        layer.wq = create_tensor(tn(LLM_TENSOR_ATTN_Q,   "weight", i), {n_embd, n_embd_head_k * n_head}, 0);
        layer.wk = create_tensor(tn(LLM_TENSOR_ATTN_K,   "weight", i), {n_embd, n_embd_gqa}, 0);
        layer.wv = create_tensor(tn(LLM_TENSOR_ATTN_V,   "weight", i), {n_embd, n_embd_v_gqa}, 0);
        layer.wo = create_tensor(tn(LLM_TENSOR_ATTN_OUT, "weight", i), {n_embd_head_k * n_head, n_embd}, 0);

        layer.attn_q_norm = create_tensor(tn(LLM_TENSOR_ATTN_Q_NORM, "weight", i), {n_embd_head_k}, 0);
        layer.attn_k_norm = create_tensor(tn(LLM_TENSOR_ATTN_K_NORM, "weight", i), {n_embd_head_k}, 0);

        layer.ffn_gate = create_tensor(tn(LLM_TENSOR_FFN_GATE, "weight", i), {n_embd,   n_ff}, 0);
        layer.ffn_down = create_tensor(tn(LLM_TENSOR_FFN_DOWN, "weight", i), {  n_ff, n_embd}, 0);
        layer.ffn_up   = create_tensor(tn(LLM_TENSOR_FFN_UP,   "weight", i), {n_embd,   n_ff}, 0);
    }
}

std::unique_ptr<llm_graph_context> llama_model_dflash_draft::build_arch_graph(const llm_graph_params & params) const {
    return std::make_unique<llm_build_dflash_draft>(*this, params);
}

class llm_graph_input_dflash : public llm_graph_input_i {
public:
    llm_graph_input_dflash(const llama_cross * cross, int64_t ctx_len, int64_t n_block, uint32_t n_swa)
        : cross(cross), ctx_len(ctx_len), n_block(n_block), n_swa(n_swa) {}

    void set_input(const llama_ubatch * ubatch) override;

    ggml_tensor * target_hidden   = nullptr;
    ggml_tensor * pos_ctx         = nullptr;
    ggml_tensor * kq_mask         = nullptr;
    ggml_tensor * kq_mask_cnv     = nullptr;
    ggml_tensor * kq_mask_swa     = nullptr;
    ggml_tensor * kq_mask_swa_cnv = nullptr;

    const llama_cross * cross;
    int64_t ctx_len;
    int64_t n_block;
    uint32_t n_swa;
};

void llm_graph_input_dflash::set_input(const llama_ubatch * ubatch) {
    const int64_t src_real = cross ? cross->n_enc : 0;
    const int64_t n_copy   = std::min(src_real, ctx_len);
    const int64_t win_off  = src_real > ctx_len ? src_real - ctx_len : 0;

    if (target_hidden) {
        ggml_backend_tensor_memset(target_hidden, 0, 0, ggml_nbytes(target_hidden));
        if (cross && !cross->v_embd.empty() && n_copy > 0) {
            const int64_t n_feat = cross->n_embd;
            const float * src = cross->v_embd.data() + win_off * n_feat;
            const size_t copy_bytes = (size_t) n_feat * (size_t) n_copy * sizeof(float);
            ggml_backend_tensor_set(target_hidden, src, 0, std::min(copy_bytes, (size_t) ggml_nbytes(target_hidden)));
        }
    }

    if (pos_ctx && pos_ctx->buffer) {
        GGML_ASSERT(ggml_backend_buffer_is_host(pos_ctx->buffer));
        int32_t * data = (int32_t *) pos_ctx->data;
        for (int64_t i = 0; i < ctx_len; ++i) {
            data[i] = i < n_copy ? (int32_t) (win_off + i) : 0;
        }
    }

    if (kq_mask && kq_mask->buffer) {
        GGML_ASSERT(ggml_backend_buffer_is_host(kq_mask->buffer));
        float * data = (float *) kq_mask->data;
        const int64_t n_kv = ctx_len + n_block;
        for (int64_t q = 0; q < n_block; ++q) {
            for (int64_t k = 0; k < n_kv; ++k) {
                data[q * n_kv + k] = (k >= n_copy && k < ctx_len) ? -INFINITY : 0.0f;
            }
        }
    }

    if (kq_mask_swa && kq_mask_swa->buffer && n_swa > 0) {
        GGML_ASSERT(ggml_backend_buffer_is_host(kq_mask_swa->buffer));
        float * data = (float *) kq_mask_swa->data;
        const int64_t n_kv = ctx_len + n_block;
        const int32_t window = (int32_t) n_swa;
        const bool have_pos = ubatch && ubatch->pos && (int64_t) ubatch->n_tokens >= n_block;
        for (int64_t q = 0; q < n_block; ++q) {
            const int32_t q_pos = have_pos ? ubatch->pos[q] : (int32_t) (n_copy + q);
            for (int64_t k = 0; k < n_kv; ++k) {
                float v = 0.0f;
                if (k < n_copy) {
                    if (q_pos - (int32_t) k > window) {
                        v = -INFINITY;
                    }
                } else if (k < ctx_len) {
                    v = -INFINITY;
                } else if (k - ctx_len > q) {
                    v = -INFINITY;
                }
                data[q * n_kv + k] = v;
            }
        }
    }
}

llm_build_dflash_draft::llm_build_dflash_draft(
        const llama_model & model,
        const llm_graph_params & params) :
    llm_graph_context(params) {
    const int64_t n_embd_head = hparams.n_embd_head_v();
    GGML_ASSERT(n_embd_head == hparams.n_embd_head_k());

    int64_t ctx_len = cross && cross->n_enc > 0 ? cross->n_enc : LLAMA_DFLASH_PER_SLOT_CTX_LOCAL;
    const int64_t max_ctx = dflash_max_cross_ctx();
    if (max_ctx > 0 && ctx_len > max_ctx) {
        ctx_len = max_ctx;
    }

    const int64_t n_target_features = hparams.dflash_n_target_features;
    const int64_t n_kv_total = ctx_len + n_tokens;

    const bool have_swa = hparams.is_swa_any();
    auto inp_dflash = std::make_unique<llm_graph_input_dflash>(cross, ctx_len, n_tokens, hparams.n_swa);

    inp_dflash->target_hidden = ggml_new_tensor_2d(ctx0, GGML_TYPE_F32, n_target_features, ctx_len);
    ggml_set_input(inp_dflash->target_hidden);
    cb(inp_dflash->target_hidden, "dflash_target_hidden", -1);

    inp_dflash->pos_ctx = ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, ctx_len);
    ggml_set_input(inp_dflash->pos_ctx);
    cb(inp_dflash->pos_ctx, "dflash_pos_ctx", -1);

    inp_dflash->kq_mask = ggml_new_tensor_4d(ctx0, GGML_TYPE_F32, n_kv_total, n_tokens, 1, 1);
    ggml_set_input(inp_dflash->kq_mask);
    inp_dflash->kq_mask_cnv = cparams.flash_attn
        ? ggml_cast(ctx0, inp_dflash->kq_mask, GGML_TYPE_F16)
        : inp_dflash->kq_mask;

    if (have_swa) {
        inp_dflash->kq_mask_swa = ggml_new_tensor_4d(ctx0, GGML_TYPE_F32, n_kv_total, n_tokens, 1, 1);
        ggml_set_input(inp_dflash->kq_mask_swa);
        cb(inp_dflash->kq_mask_swa, "dflash_kq_mask_swa", -1);
        inp_dflash->kq_mask_swa_cnv = cparams.flash_attn
            ? ggml_cast(ctx0, inp_dflash->kq_mask_swa, GGML_TYPE_F16)
            : inp_dflash->kq_mask_swa;
    }

    ggml_tensor * kq_mask_full  = inp_dflash->kq_mask_cnv;
    ggml_tensor * kq_mask_swa   = inp_dflash->kq_mask_swa_cnv;
    ggml_tensor * pos_ctx       = inp_dflash->pos_ctx;
    ggml_tensor * target_hidden = inp_dflash->target_hidden;

    res->add_input(std::move(inp_dflash));

    ggml_tensor * tok_embd_use = model.tok_embd;
    if (!tok_embd_use) {
        tok_embd_use = ggml_new_tensor_2d(ctx0, GGML_TYPE_Q4_0, n_embd, model.vocab.n_tokens());
    }
    ggml_tensor * inpL = build_inp_embd(tok_embd_use);
    ggml_tensor * inp_pos = build_inp_pos();

    ggml_tensor * fused_target = build_lora_mm(model.dflash_fc, target_hidden);
    fused_target = build_norm(fused_target, model.dflash_hidden_norm, nullptr, LLM_NORM_RMS, -1);
    cb(fused_target, "fused_target", -1);

    for (int il = 0; il < n_layer; ++il) {
        ggml_tensor * inpSA = inpL;
        ggml_tensor * kq_mask = (hparams.is_swa(il) && kq_mask_swa) ? kq_mask_swa : kq_mask_full;

        ggml_tensor * cur = build_norm(inpL, model.layers[il].attn_norm, nullptr, LLM_NORM_RMS, il);
        cb(cur, "attn_norm", il);

        ggml_tensor * Qcur = build_lora_mm(model.layers[il].wq, cur);
        Qcur = ggml_reshape_3d(ctx0, Qcur, n_embd_head, n_head, n_tokens);
        Qcur = build_norm(Qcur, model.layers[il].attn_q_norm, nullptr, LLM_NORM_RMS, il);
        Qcur = ggml_rope_ext(ctx0, Qcur, inp_pos, nullptr,
                             n_rot, rope_type, n_ctx_orig, freq_base, freq_scale,
                             ext_factor, attn_factor, beta_fast, beta_slow);
        cb(Qcur, "Qcur", il);

        ggml_tensor * Kcur_noise = build_lora_mm(model.layers[il].wk, cur);
        Kcur_noise = ggml_reshape_3d(ctx0, Kcur_noise, n_embd_head, n_head_kv, n_tokens);
        Kcur_noise = build_norm(Kcur_noise, model.layers[il].attn_k_norm, nullptr, LLM_NORM_RMS, il);
        Kcur_noise = ggml_rope_ext(ctx0, Kcur_noise, inp_pos, nullptr,
                                   n_rot, rope_type, n_ctx_orig, freq_base, freq_scale,
                                   ext_factor, attn_factor, beta_fast, beta_slow);
        cb(Kcur_noise, "Kcur_noise", il);

        ggml_tensor * Kcur_ctx = build_lora_mm(model.layers[il].wk, fused_target);
        Kcur_ctx = ggml_reshape_3d(ctx0, Kcur_ctx, n_embd_head, n_head_kv, ctx_len);
        Kcur_ctx = build_norm(Kcur_ctx, model.layers[il].attn_k_norm, nullptr, LLM_NORM_RMS, il);
        Kcur_ctx = ggml_rope_ext(ctx0, Kcur_ctx, pos_ctx, nullptr,
                                 n_rot, rope_type, n_ctx_orig, freq_base, freq_scale,
                                 ext_factor, attn_factor, beta_fast, beta_slow);
        cb(Kcur_ctx, "Kcur_ctx", il);

        ggml_tensor * Vcur_noise = build_lora_mm(model.layers[il].wv, cur);
        Vcur_noise = ggml_reshape_3d(ctx0, Vcur_noise, n_embd_head, n_head_kv, n_tokens);
        cb(Vcur_noise, "Vcur_noise", il);

        ggml_tensor * Vcur_ctx = build_lora_mm(model.layers[il].wv, fused_target);
        Vcur_ctx = ggml_reshape_3d(ctx0, Vcur_ctx, n_embd_head, n_head_kv, ctx_len);
        cb(Vcur_ctx, "Vcur_ctx", il);

        ggml_tensor * Kcur = ggml_concat(ctx0, Kcur_ctx, Kcur_noise, 2);
        cb(Kcur, "Kcur", il);
        ggml_tensor * Vcur = ggml_concat(ctx0, Vcur_ctx, Vcur_noise, 2);
        cb(Vcur, "Vcur", il);

        ggml_build_forward_expand(gf, Qcur);
        ggml_build_forward_expand(gf, Kcur);
        ggml_build_forward_expand(gf, Vcur);

        cur = build_attn_mha(Qcur, Kcur, Vcur, nullptr, kq_mask, nullptr, nullptr,
                             1.0f / sqrtf(float(n_embd_head)), il);
        cb(cur, "kqv_out", il);

        cur = build_lora_mm(model.layers[il].wo, cur);
        cur = ggml_add(ctx0, cur, inpSA);
        cb(cur, "attn_residual", il);

        ggml_tensor * ffn_residual = cur;
        cur = build_norm(cur, model.layers[il].attn_post_norm, nullptr, LLM_NORM_RMS, il);
        cb(cur, "attn_post_norm", il);

        cur = build_ffn(cur,
            model.layers[il].ffn_up,   nullptr, nullptr,
            model.layers[il].ffn_gate, nullptr, nullptr,
            model.layers[il].ffn_down, nullptr, nullptr,
            nullptr, LLM_FFN_SILU, LLM_FFN_PAR, il);
        cb(cur, "ffn_out", il);

        cur = ggml_add(ctx0, cur, ffn_residual);
        cb(cur, "l_out", il);

        inpL = cur;
    }

    ggml_tensor * cur = build_norm(inpL, model.output_norm, nullptr, LLM_NORM_RMS, -1);
    cb(cur, "result_norm", -1);
    res->t_embd = cur;

    ggml_tensor * output_use = model.output;
    if (!output_use) {
        output_use = ggml_new_tensor_2d(ctx0, GGML_TYPE_Q4_0, n_embd, model.vocab.n_tokens());
    }
    cur = build_lora_mm(output_use, cur);
    cb(cur, "result_output", -1);
    res->t_logits = cur;

    ggml_build_forward_expand(gf, cur);
}
