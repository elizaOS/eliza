// eliza_mtp_driver.cpp — native same-file MTP (NextN) speculative-decode engine.
//
// Why this exists:
//   The per-token shim ABI (`eliza_llama_decode` / `eliza_llama_decode_unified`)
//   samples ONE token in JS, then asks native to decode it. That shape cannot
//   express speculative decoding, where native must draft k tokens, verify a
//   k+1 batch against the target model, and hand back a multi-token accepted
//   prefix. This engine owns the full draft -> verify -> accept loop natively
//   (wrapping llama.cpp/common's `common_speculative_*` draft-mtp implementation)
//   and exposes a multi-token-return ABI the adapter drives one step at a time.
//
//   "Same-file" MTP: the NextN head lives in the SAME GGUF as the text weights
//   (qwen35.nextn_predict_layers > 0). The engine creates a second context over
//   the SAME model with `ctx_type = LLAMA_CONTEXT_TYPE_MTP`; no separate drafter
//   model is loaded. This mirrors the server's same-file MTP setup in
//   tools/server/server-context.cpp (the `creating MTP draft context against the
//   target model` branch).
//
//   The engine is single-sequence (seq_id 0). It supports every memory type the
//   server supports: contexts that allow partial suffix removal
//   (COMMON_CONTEXT_SEQ_RM_TYPE_PART, dense bodies) trim the rejected-draft KV
//   tail directly; contexts that only support full-sequence removal
//   (_TYPE_FULL / _TYPE_RS — recurrent / hybrid delta-net bodies like Qwen3.5)
//   roll back via state checkpoints (llama_state_seq_get/set_data_ext), exactly
//   as `server-context.cpp` does. Only _TYPE_NO (no rollback at all) is refused,
//   so the adapter cleanly falls back to plain decode.
//
// Build: compiled as a separate C++17 TU and linked into libeliza-llama-shim
// alongside the C11 shim, against libllama + libllama-common.
// See packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs.

#include "llama.h"
#include "common.h"
#include "speculative.h"
#include "sampling.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

#include "eliza_llama_shim.h"

namespace {

constexpr llama_state_seq_flags CKPT_FLAGS =
    LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE;

struct eliza_mtp_engine {
    llama_model        * model   = nullptr; // borrowed (caller owns)
    llama_context      * ctx_tgt = nullptr; // borrowed (caller owns)
    llama_context      * ctx_dft = nullptr; // owned by the engine
    common_speculative * spec    = nullptr; // owned
    common_sampler     * smpl    = nullptr; // owned

    std::vector<llama_token> prompt; // committed token history (mirrors KV)
    llama_token              id_last = 0;   // last sampled token (next-step seed)

    int32_t n_ctx     = 0;
    int32_t draft_min = 1;
    int32_t draft_max = 2;

    // Rollback strategy per context (mirrors server-context.cpp). When a draft
    // is partially rejected we must trim the rejected KV tail. PART contexts do
    // it with a direct partial seq_rm; FULL/RS contexts cannot, so we snapshot
    // the committed prefix before drafting and restore it on rollback.
    bool use_ckpt_tgt = false;
    bool use_ckpt_dft = false;

    common_prompt_checkpoint ckpt; // committed-prefix snapshot (reused per step)

    llama_batch batch{}; // reusable verify batch, capacity 1 + draft_max

    uint64_t st_decoded  = 0;
    uint64_t st_drafted  = 0;
    uint64_t st_accepted = 0;
    uint64_t st_verify   = 0;
};

// Roll ctx back to the committed prefix [0, n_committed). PART contexts trim
// directly; FULL/RS contexts restore the checkpoint then drop the (now-empty)
// tail past the snapshot's max position.
void rollback_to_committed(
        llama_context *                  ctx,
        bool                             use_ckpt,
        const common_prompt_checkpoint & ckpt,
        bool                             is_tgt,
        int32_t                          n_committed) {
    if (use_ckpt) {
        if (is_tgt) {
            ckpt.load_tgt(ctx, 0, CKPT_FLAGS);
        } else {
            ckpt.load_dft(ctx, 0, CKPT_FLAGS);
        }
        common_context_seq_rm(ctx, 0, ckpt.pos_max + 1, -1);
    } else {
        common_context_seq_rm(ctx, 0, n_committed, -1);
    }
}

} // namespace

extern "C" {

void * eliza_llama_mtp_engine_create(
    void *   model_,
    void *   ctx_tgt_,
    int32_t  draft_min,
    int32_t  draft_max,
    float    temperature,
    int32_t  top_k,
    float    top_p,
    float    min_p,
    uint32_t seed) {
    auto * model   = static_cast<llama_model *>(model_);
    auto * ctx_tgt = static_cast<llama_context *>(ctx_tgt_);
    if (model == nullptr || ctx_tgt == nullptr) {
        return nullptr;
    }

    auto * e = new eliza_mtp_engine();
    e->model     = model;
    e->ctx_tgt   = ctx_tgt;
    e->draft_min = draft_min > 0 ? draft_min : 1;
    e->draft_max = draft_max >= e->draft_min ? draft_max : e->draft_min;
    e->n_ctx     = static_cast<int32_t>(llama_n_ctx(ctx_tgt));

    // The target context must support some form of suffix rollback, otherwise
    // rejected drafts can't be retracted and speculation is impossible.
    const auto seq_rm_tgt = common_context_can_seq_rm(ctx_tgt);
    if (seq_rm_tgt == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
        delete e;
        return nullptr;
    }
    e->use_ckpt_tgt = seq_rm_tgt != COMMON_CONTEXT_SEQ_RM_TYPE_PART;

    // MTP draft context over the SAME model.
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx     = llama_n_ctx(ctx_tgt);
    cp.n_batch   = llama_n_batch(ctx_tgt);
    cp.n_ubatch  = llama_n_ubatch(ctx_tgt);
    cp.n_seq_max = 1;
    cp.ctx_type  = LLAMA_CONTEXT_TYPE_MTP;
    cp.n_threads = 1;
    cp.n_threads_batch = 1;

    e->ctx_dft = llama_init_from_model(model, cp);
    if (e->ctx_dft == nullptr) {
        delete e;
        return nullptr;
    }

    const auto seq_rm_dft = common_context_can_seq_rm(e->ctx_dft);
    if (seq_rm_dft == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
        llama_free(e->ctx_dft);
        delete e;
        return nullptr;
    }
    e->use_ckpt_dft = seq_rm_dft != COMMON_CONTEXT_SEQ_RM_TYPE_PART;

    common_params_speculative sp;
    sp.types         = { COMMON_SPECULATIVE_TYPE_DRAFT_MTP };
    sp.draft.ctx_tgt = ctx_tgt;
    sp.draft.ctx_dft = e->ctx_dft;
    sp.draft.n_max   = e->draft_max;
    sp.draft.n_min   = e->draft_min;

    try {
        e->spec = common_speculative_init(sp, 1);
    } catch (...) {
        e->spec = nullptr;
    }
    if (e->spec == nullptr) {
        llama_free(e->ctx_dft);
        delete e;
        return nullptr;
    }

    common_params_sampling sparams;
    sparams.seed  = seed;
    sparams.temp  = temperature;
    sparams.top_k = top_k;
    sparams.top_p = top_p;
    sparams.min_p = min_p;

    e->smpl = common_sampler_init(model, sparams);
    if (e->smpl == nullptr) {
        common_speculative_free(e->spec);
        llama_free(e->ctx_dft);
        delete e;
        return nullptr;
    }

    e->batch = llama_batch_init(1 + e->draft_max, 0, 1);
    return e;
}

void eliza_llama_mtp_engine_free(void * engine) {
    auto * e = static_cast<eliza_mtp_engine *>(engine);
    if (e == nullptr) {
        return;
    }
    if (e->batch.token != nullptr || e->batch.embd != nullptr) {
        llama_batch_free(e->batch);
    }
    if (e->smpl != nullptr) {
        common_sampler_free(e->smpl);
    }
    if (e->spec != nullptr) {
        common_speculative_free(e->spec);
    }
    if (e->ctx_dft != nullptr) {
        llama_free(e->ctx_dft);
    }
    delete e;
}

int32_t eliza_llama_mtp_engine_prefill(
    void *          engine,
    const int32_t * tokens,
    int32_t         n_tokens,
    int32_t *       out_first_token) {
    auto * e = static_cast<eliza_mtp_engine *>(engine);
    if (e == nullptr || tokens == nullptr || n_tokens <= 0 || out_first_token == nullptr) {
        return -1;
    }

    e->prompt.assign(tokens, tokens + n_tokens);

    // MTP feeds the draft head off pre-norm target embeddings (enabled at spec
    // init); the regular post-norm embedding output stays off.
    llama_set_embeddings(e->ctx_tgt, false);

    const int32_t n_batch = static_cast<int32_t>(llama_n_batch(e->ctx_tgt));
    for (int32_t i = 0; i < n_tokens; i += n_batch) {
        const int32_t cnt = std::min(n_batch, n_tokens - i);
        llama_batch b = llama_batch_init(cnt, 0, 1);
        for (int32_t k = 0; k < cnt; ++k) {
            const bool is_last = (i + k) == (n_tokens - 1);
            common_batch_add(b, tokens[i + k], i + k, { 0 }, is_last);
        }
        const int rc = llama_decode(e->ctx_tgt, b);
        if (rc != 0) {
            llama_batch_free(b);
            return -2;
        }
        if (!common_speculative_process(e->spec, b)) {
            llama_batch_free(b);
            return -3;
        }
        llama_batch_free(b);
    }
    e->st_decoded += static_cast<uint64_t>(n_tokens);

    common_speculative_begin(e->spec, 0, e->prompt);

    const llama_token id = common_sampler_sample(e->smpl, e->ctx_tgt, n_tokens - 1);
    common_sampler_accept(e->smpl, id, true);
    e->id_last = id;
    *out_first_token = id;
    return 0;
}

int32_t eliza_llama_mtp_engine_step(void * engine, int32_t * out, int32_t cap) {
    auto * e = static_cast<eliza_mtp_engine *>(engine);
    if (e == nullptr || out == nullptr || cap < 1) {
        return -1;
    }

    // Step-boundary invariant: KV(tgt) == KV(dft) == committed prefix [0, P);
    // id_last is the next seed token, not yet decoded into either context.
    const int32_t P    = static_cast<int32_t>(e->prompt.size());
    const llama_token seed = e->id_last;

    // Bound the draft by the remaining context window (mirror get_n_draft_max).
    int32_t n_draft_max = e->draft_max;
    const int32_t remaining = e->n_ctx - P;
    if (remaining <= 1) {
        n_draft_max = 0;
    } else if (n_draft_max > remaining - 1) {
        n_draft_max = remaining - 1;
    }

    // 0) Snapshot the committed prefix before drafting pollutes the KV. For
    //    FULL/RS contexts this is the only way to retract rejected drafts.
    if (e->use_ckpt_tgt || e->use_ckpt_dft) {
        const llama_pos pos_min = llama_memory_seq_pos_min(llama_get_memory(e->ctx_tgt), 0);
        const llama_pos pos_max = llama_memory_seq_pos_max(llama_get_memory(e->ctx_tgt), 0);
        e->ckpt.update_pos(P, pos_min, pos_max);
        if (e->use_ckpt_tgt) {
            e->ckpt.update_tgt(e->ctx_tgt, 0, CKPT_FLAGS);
        }
        if (e->use_ckpt_dft) {
            e->ckpt.update_dft(e->ctx_dft, 0, CKPT_FLAGS);
        }
    }

    // 1) Draft (off the pending target embedding captured by process()). This
    //    advances ctx_dft's recurrent state past the committed prefix.
    std::vector<llama_token> draft;
    auto & dp = common_speculative_get_draft_params(e->spec, 0);
    if (n_draft_max > 0) {
        dp = {
            /* .drafting = */ true,
            /* .n_max    = */ n_draft_max,
            /* .n_past   = */ P,
            /* .id_last  = */ seed,
            /* .prompt   = */ &e->prompt,
            /* .result   = */ &draft,
        };
        common_speculative_draft(e->spec);
    } else {
        dp.drafting = false;
    }
    const int32_t D = static_cast<int32_t>(draft.size());

    // 2) Roll ctx_dft back to the committed prefix so process() can cleanly
    //    re-mirror the verify batch into it (mirrors server-context.cpp's
    //    "make checkpoints if needed" block, which undoes the draft's
    //    pre-advancement of ctx_dft before the verify decode).
    rollback_to_committed(e->ctx_dft, e->use_ckpt_dft, e->ckpt, /* is_tgt= */ false, P);

    // 3) Build the verify batch: [seed @ P, draft[i] @ P+1+i].
    common_batch_clear(e->batch);
    std::vector<int> idxs;
    idxs.reserve(static_cast<size_t>(D) + 1);
    idxs.push_back(0);
    common_batch_add(e->batch, seed, P, { 0 }, true);
    for (int32_t i = 0; i < D; ++i) {
        idxs.push_back(i + 1);
        common_batch_add(e->batch, draft[i], P + 1 + i, { 0 }, true);
    }

    // 4) Decode the verify batch on the target, then mirror it into the draft
    //    context (advances ctx_dft to [0, P+1+D), refreshes MTP carryover).
    llama_set_embeddings(e->ctx_tgt, false);
    if (llama_decode(e->ctx_tgt, e->batch) != 0) {
        return -2;
    }
    if (!common_speculative_process(e->spec, e->batch)) {
        return -3;
    }
    e->st_decoded += static_cast<uint64_t>(e->batch.n_tokens);
    e->st_drafted += static_cast<uint64_t>(D);

    // 5) Verify + accept against the target logits.
    std::vector<llama_token> accepted;
    if (D > 0) {
        accepted = common_sampler_sample_and_accept_n(e->smpl, e->ctx_tgt, idxs, draft);
        common_speculative_accept(e->spec, 0, static_cast<uint16_t>(accepted.size() - 1));
    } else {
        const llama_token id = common_sampler_sample(e->smpl, e->ctx_tgt, 0);
        common_sampler_accept(e->smpl, id, true);
        accepted.push_back(id);
    }
    const int32_t A = static_cast<int32_t>(accepted.size());
    e->st_accepted += static_cast<uint64_t>(A - 1);
    e->st_verify += 1;

    // 6) Reconcile the KV to the committed prefix + accepted tokens.
    //    The committed prefix grows by A tokens: [seed, accepted[0..A-2]];
    //    accepted.back() becomes the next-step seed (not decoded).
    const int32_t n_rollback = (D + 1) - A;
    const int32_t newP = P + A;
    if (n_rollback == 0) {
        // KV(tgt) == KV(dft) == [0, P+1+D) == [0, newP). Nothing to retract.
    } else if (!e->use_ckpt_tgt && !e->use_ckpt_dft) {
        // PART contexts: trim the rejected-draft tail directly.
        common_context_seq_rm(e->ctx_tgt, 0, newP, -1);
        common_context_seq_rm(e->ctx_dft, 0, newP, -1);
    } else {
        // FULL/RS contexts: restore the committed prefix, then re-decode the
        // accepted committed-growth tokens to advance both recurrent states to
        // [0, newP). process() also resets the MTP carryover embedding to the
        // last committed row — the correct seed for the next step's draft.
        rollback_to_committed(e->ctx_tgt, e->use_ckpt_tgt, e->ckpt, /* is_tgt= */ true,  P);
        rollback_to_committed(e->ctx_dft, e->use_ckpt_dft, e->ckpt, /* is_tgt= */ false, P);

        common_batch_clear(e->batch);
        common_batch_add(e->batch, seed, P, { 0 }, true);
        for (int32_t i = 0; i + 1 < A; ++i) {
            common_batch_add(e->batch, accepted[i], P + 1 + i, { 0 }, true);
        }
        llama_set_embeddings(e->ctx_tgt, false);
        if (llama_decode(e->ctx_tgt, e->batch) != 0) {
            return -4;
        }
        if (!common_speculative_process(e->spec, e->batch)) {
            return -5;
        }
    }

    // 7) Commit the accepted tokens to the prompt history.
    e->prompt.push_back(seed);
    for (int32_t i = 0; i + 1 < A; ++i) {
        e->prompt.push_back(accepted[i]);
    }
    e->id_last = accepted.back();

    // 8) Emit the accepted tokens.
    int32_t n_out = A;
    if (n_out > cap) {
        n_out = cap;
    }
    for (int32_t i = 0; i < n_out; ++i) {
        out[i] = accepted[i];
    }
    return n_out;
}

void eliza_llama_mtp_engine_stats(void * engine, struct eliza_mtp_stats * out) {
    if (out == nullptr) {
        return;
    }
    auto * e = static_cast<eliza_mtp_engine *>(engine);
    if (e == nullptr) {
        std::memset(out, 0, sizeof(*out));
        return;
    }
    out->decoded          = e->st_decoded;
    out->drafted          = e->st_drafted;
    out->accepted         = e->st_accepted;
    out->drafted_rejected = e->st_drafted - e->st_accepted;
    out->verify_steps     = e->st_verify;
}

} // extern "C"
