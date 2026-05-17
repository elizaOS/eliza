/*
 * eliza_llama_shim_speculative.cpp — C-callable ("path b") wrapper around
 * llama.cpp's C++ `common_speculative_*` API, backed by the in-process
 * libllama on Android.
 *
 * WHY THIS FILE EXISTS — "path a" vs "path b":
 *
 *   The Android voice pipeline runs in-process (the AOSP adapter +
 *   Capacitor framework) — mic → VAD → Qwen3-ASR → DFlash-accelerated text →
 *   OmniVoice TTS, all inside the app process, no spawned children. But the
 *   DFlash speculative decode loop today uses **path a** (`aosp-dflash-adapter.ts`):
 *   cross-compile `llama-server` per ABI, have bun spawn it as a localhost
 *   child process, and POST `/v1/chat/completions` to it. That works (and is
 *   "cheaper to validate"), but it wastes RAM (a whole second model context +
 *   the server's own buffers), burns a loopback port, and pays a cold-start
 *   on every relaunch.
 *
 *   **Path b** binds the fork's `common_speculative_*` C++ helpers — the exact
 *   ones `llama-server`'s spec loop uses internally — through a C ABI into the
 *   in-process libllama, so the DFlash spec loop runs in the app process with
 *   no localhost server. The intended runtime contract is to dlopen
 *   `libeliza-llama-speculative-shim.so`, check
 *   eliza_speculative_supported(), and use the in-process path only when it
 *   returns 1. This file defines that C ABI.
 *
 * THE C-vs-C++ MISMATCH:
 *
 *   The fork's `common/speculative.h` API is pervasively C++:
 *     common_speculative_init(common_params_speculative &, llama_context *)
 *     common_speculative_draft(common_speculative *, const common_params_speculative &,
 *                              const llama_tokens & prompt, llama_token id_last)  // llama_tokens = std::vector<llama_token>
 *     common_speculative_begin(common_speculative *, const llama_tokens & prompt)
 *     common_speculative_accept(common_speculative *, uint16_t)
 *   bun:ffi (and any plain C FFI) can't pass `std::vector` / `std::string` /
 *   struct-by-reference. So this file is C++ (it links the C++ symbols) but
 *   exposes only a flat `extern "C"` surface: opaque pointers + plain int32
 *   arrays. Each entry point reconstructs the C++ types from the C-friendly
 *   args, calls the real helper, and copies any output back into a
 *   caller-provided int32 buffer (returning the count).
 *
 * BUILD STATUS:
 *   The C++ implementation below targets the current elizaOS/llama.cpp
 *   speculative API:
 *
 *     common_speculative_init(params, n_seq)
 *     common_speculative_get_draft_params(spec, seq_id)
 *     common_speculative_draft(spec)
 *     common_speculative_accept(spec, seq_id, n_accepted)
 *
 *   compile-libllama.mjs still falls back to ELIZA_SHIM_HEADERLESS when a
 *   checkout does not expose that API. In headerless mode the .so remains
 *   dlopen-able and exports the same C ABI, but reports unsupported.
 *
 *   Header dependency: needs the fork's `common/speculative.h`, `common/common.h`,
 *   and `llama.h` on the include path (the same checkout compile-libllama.mjs
 *   builds libllama from) once the real implementation is ported.
 *
 * llama.cpp pin: elizaOS/llama.cpp @ eliza/main (the combined fork with DFlash
 *   spec-decode + the eliza kernels). `common_params_speculative` field set
 *   tracked there; the setters below cover the subset the AOSP adapter
 *   overrides (n_draft / n_min / p_min / type / cache types / ctx size).
 */

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <exception>
#include <new>
#include <string>
#include <utility>
#include <vector>

// The fork's C++ headers. Android currently sets ELIZA_SHIM_HEADERLESS to
// compile a no-op stub that returns "unsupported" until the real implementation
// is ported to the current common/speculative.h API.
#if defined(ELIZA_SHIM_HEADERLESS)
typedef int32_t llama_token;
struct llama_context;
struct common_speculative;
#else
#include "llama.h"
#include "common.h"
#include "sampling.h"
#include "speculative.h"
#endif

// ---- the flat C ABI -------------------------------------------------------

extern "C" {

// Opaque handle the JS side carries around. Wraps the live common_speculative*
// plus a copy of the common_params_speculative the loop reuses (the C++ API
// wants the params by-ref on every draft() call).
struct eliza_speculative_handle;
struct eliza_speculative_stream;

// 1 when the speculative C++ symbols are linked into this .so. Android builds
// currently define ELIZA_SHIM_HEADERLESS, so this returns 0 and callers must
// treat the in-process speculative path as unavailable.
int eliza_speculative_supported(void) {
#if defined(ELIZA_SHIM_HEADERLESS)
    return 0;
#else
    return 1;
#endif
}

// Check the in-process target context is compatible for spec decoding
// (clears its memory — call before the first decode). Returns 1/0.
int eliza_speculative_is_compat(struct llama_context * ctx_tgt) {
#if defined(ELIZA_SHIM_HEADERLESS)
    (void) ctx_tgt; return 0;
#else
    // Current llama.cpp performs target/draft compatibility checks inside
    // common_speculative_init(). This lightweight probe only confirms the
    // target context is present; init() is the authoritative compatibility
    // gate.
    return ctx_tgt ? 1 : 0;
#endif
}

// Initialize. `ctx_tgt` is the in-process target llama_context (from the
// pointer-shim's llama_init_from_model). `ctx_draft` is the drafter context.
// `spec_type_name` is the fork's spec-type token ("dflash", "lookahead",
// "ngram", ...). `n_draft` / `n_min` / `p_min` are the DFlash window knobs
// (0 / negative ⇒ keep the fork default). Returns the handle, or NULL on
// failure (caller must continue without in-process speculation).
struct eliza_speculative_handle * eliza_speculative_init(
        struct llama_context * ctx_tgt,
        struct llama_context * ctx_draft,
        const char *           spec_type_name,
        int                    n_draft,
        int                    n_min,
        float                  p_min);

void eliza_speculative_free(struct eliza_speculative_handle * h);

// Optional: call once at the start of a new generation with the rendered
// prompt token ids (length `n_prompt`).
void eliza_speculative_begin(struct eliza_speculative_handle * h,
                             const int32_t * prompt_ids, int32_t n_prompt);

// Draft up to `n_draft` tokens given the current prompt prefix
// (`prompt_ids[0..n_prompt)`) and the last accepted token `id_last`. The
// resulting draft token ids are written into `out_ids` (capacity
// `out_cap`); the return value is the number actually produced
// (0 on failure / nothing to draft). The caller then verifies them against
// the in-process target model and reports how many were accepted via
// eliza_speculative_accept().
int32_t eliza_speculative_draft(struct eliza_speculative_handle * h,
                                const int32_t * prompt_ids, int32_t n_prompt,
                                int32_t id_last,
                                int32_t * out_ids, int32_t out_cap);

// Inform the spec decoder that `n_accepted` of the last drafted tokens were
// accepted by the target model (drives DFlash's adaptive window).
void eliza_speculative_accept(struct eliza_speculative_handle * h, uint16_t n_accepted);

// Print spec-decode stats (accept rate etc.) to stderr — diagnostics only.
void eliza_speculative_print_stats(const struct eliza_speculative_handle * h);

// Run a complete in-process target+draft speculative decode turn. This keeps
// the verification loop in native code so the JS adapter does not need to
// recreate llama_batch / sampler internals through bun:ffi.
//
// Returns output byte length on success. If `out_text` is too small, returns
// -required_bytes (including the trailing NUL) after copying a truncated,
// NUL-terminated prefix. Negative non-size codes are fatal errors.
int32_t eliza_speculative_generate_text(struct eliza_speculative_handle * h,
                                        const char * prompt_text,
                                        const char * grammar_text,
                                        int32_t max_tokens,
                                        float temperature,
                                        char * out_text,
                                        int32_t out_cap);

// Step-wise streaming variant of `eliza_speculative_generate_text`. The open
// call performs tokenize + prefill and returns NULL on setup failure. Each
// `next` call advances one speculative verification step and writes the
// accepted UTF-8 text for that step into `out_text`. `out_done` is set to 1 when
// EOS / max-token cap ended the turn. The caller must free the stream.
struct eliza_speculative_stream * eliza_speculative_stream_open(
        struct eliza_speculative_handle * h,
        const char * prompt_text,
        const char * grammar_text,
        int32_t max_tokens,
        float temperature);

int32_t eliza_speculative_stream_next(struct eliza_speculative_stream * s,
                                      char * out_text,
                                      int32_t out_cap,
                                      int32_t * out_done,
                                      int32_t * out_drafted,
                                      int32_t * out_accepted);

void eliza_speculative_stream_free(struct eliza_speculative_stream * s);

// Copy the last JSON stats/error payload into `out_json`.
int32_t eliza_speculative_last_stats_json(const struct eliza_speculative_handle * h,
                                          char * out_json,
                                          int32_t out_cap);

} // extern "C"

// ---- implementation -------------------------------------------------------

#if !defined(ELIZA_SHIM_HEADERLESS)

struct eliza_speculative_handle {
    common_speculative *      spec = nullptr;
    common_params_speculative params;
    llama_context *           ctx_target = nullptr;
    llama_context *           ctx_draft  = nullptr;
    llama_tokens              prompt;
    llama_tokens              draft;
    bool                      has_decoded = false;
    std::string               last_stats_json = "{}";
};

struct eliza_speculative_stream {
    eliza_speculative_handle * h = nullptr;
    llama_context *            ctx_target = nullptr;
    llama_context *            ctx_draft = nullptr;
    const llama_vocab *        vocab = nullptr;
    common_sampler_ptr         sampler;
    common_prompt_checkpoint   ckpt;
    llama_batch                batch{};
    bool                       batch_initialized = false;
    bool                       use_ckpt_tgt = false;
    bool                       use_ckpt_dft = false;
    bool                       done = false;
    bool                       failed = false;
    llama_seq_id               seq_id = 0;
    llama_token                id_last = 0;
    int32_t                    n_past = 0;
    int32_t                    n_predict_limit = 0;
    int32_t                    n_generated = 0;
    int32_t                    n_drafted = 0;
    int32_t                    n_accepted = 0;
    int32_t                    n_input = 0;
    int32_t                    batch_cap = 1;
    std::chrono::steady_clock::time_point started;
    std::chrono::steady_clock::time_point prefill_done;
    std::chrono::steady_clock::time_point decode_done;
};

static int32_t copy_string_to_c_buffer(const std::string & value, char * out, int32_t out_cap) {
    const int32_t required = static_cast<int32_t>(value.size() + 1);
    if (!out || out_cap <= 0) return required;
    if (out_cap < required) {
        const int32_t n = std::max<int32_t>(0, out_cap - 1);
        if (n > 0) {
            std::memcpy(out, value.data(), static_cast<size_t>(n));
        }
        out[out_cap - 1] = '\0';
        return -required;
    }
    std::memcpy(out, value.c_str(), static_cast<size_t>(required));
    return static_cast<int32_t>(value.size());
}

static int64_t elapsed_ms(std::chrono::steady_clock::time_point start,
                          std::chrono::steady_clock::time_point end) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
}

static void set_error_stats(eliza_speculative_handle * h, const char * code, int32_t rc) {
    if (!h) return;
    char buf[256];
    std::snprintf(buf, sizeof(buf),
                  "{\"ok\":false,\"error\":\"%s\",\"rc\":%d}",
                  code ? code : "unknown",
                  rc);
    h->last_stats_json = buf;
}

static void write_success_stats(eliza_speculative_handle * h,
                                int32_t n_input,
                                int32_t n_generated,
                                int32_t n_drafted,
                                int32_t n_accepted,
                                int64_t prefill_ms,
                                int64_t decode_ms,
                                int64_t total_ms,
                                int32_t batch_cap,
                                int32_t draft_max,
                                bool streaming,
                                bool done) {
    if (!h) return;
    const double accept_rate =
        n_drafted > 0 ? static_cast<double>(n_accepted) / static_cast<double>(n_drafted) : 0.0;
    char stats[896];
    std::snprintf(stats, sizeof(stats),
                  "{\"ok\":true,\"nInput\":%d,\"nPredict\":%d,"
                  "\"nDrafted\":%d,\"nAccepted\":%d,\"acceptRate\":%.6f,"
                  "\"prefillMs\":%lld,\"decodeMs\":%lld,\"totalMs\":%lld,"
                  "\"batchCap\":%d,\"draftMax\":%d,\"streaming\":%s,\"done\":%s}",
                  n_input,
                  n_generated,
                  n_drafted,
                  n_accepted,
                  accept_rate,
                  static_cast<long long>(prefill_ms),
                  static_cast<long long>(decode_ms),
                  static_cast<long long>(total_ms),
                  batch_cap,
                  draft_max,
                  streaming ? "true" : "false",
                  done ? "true" : "false");
    h->last_stats_json = stats;
}

static void write_stream_stats(eliza_speculative_stream * s) {
    if (!s || !s->h) return;
    const auto now = std::chrono::steady_clock::now();
    const auto decode_end = s->done ? s->decode_done : now;
    write_success_stats(s->h,
                        s->n_input,
                        s->n_generated,
                        s->n_drafted,
                        s->n_accepted,
                        elapsed_ms(s->started, s->prefill_done),
                        elapsed_ms(s->prefill_done, decode_end),
                        elapsed_ms(s->started, decode_end),
                        s->batch_cap,
                        s->h->params.draft.n_max,
                        true,
                        s->done);
}

static int decode_token_span(llama_context * ctx,
                             const llama_tokens & tokens,
                             size_t start,
                             size_t end,
                             int32_t batch_cap,
                             llama_seq_id seq_id,
                             llama_pos pos_base) {
    if (start >= end) return 0;
    llama_batch batch = llama_batch_init(batch_cap, 0, 1);
    int rc = 0;
    for (size_t offset = start; offset < end && rc == 0; offset += static_cast<size_t>(batch_cap)) {
        const size_t chunk_end = std::min(end, offset + static_cast<size_t>(batch_cap));
        common_batch_clear(batch);
        for (size_t i = offset; i < chunk_end; ++i) {
            common_batch_add(batch,
                             tokens[i],
                             pos_base + static_cast<llama_pos>(i - start),
                             { seq_id },
                             false);
        }
        rc = llama_decode(ctx, batch);
    }
    llama_batch_free(batch);
    return rc;
}

extern "C" struct eliza_speculative_handle * eliza_speculative_init(
        struct llama_context * ctx_tgt,
        struct llama_context * ctx_draft,
        const char *           spec_type_name,
        int                    n_draft,
        int                    n_min,
        float                  p_min) {
    if (!ctx_tgt) return nullptr;
    if (!ctx_draft) return nullptr;
    auto * h = new (std::nothrow) eliza_speculative_handle();
    if (!h) return nullptr;

    h->ctx_target = reinterpret_cast<llama_context *>(ctx_tgt);
    h->ctx_draft = reinterpret_cast<llama_context *>(ctx_draft);
    h->params.draft.ctx_tgt = h->ctx_target;
    h->params.draft.ctx_dft = h->ctx_draft;
    // common_speculative_init gates draft-model implementations on
    // mparams.path being non-empty. The model is already loaded in-process
    // by the caller, so use a sentinel path to select the draft-model path
    // without asking common_init_from_params() to load another model.
    h->params.draft.mparams.path = "<in-process-draft-context>";
    if (spec_type_name && *spec_type_name) {
        const auto type = common_speculative_type_from_name(std::string(spec_type_name));
        if (type == COMMON_SPECULATIVE_TYPE_COUNT || type == COMMON_SPECULATIVE_TYPE_NONE) {
            delete h;
            return nullptr;
        }
        h->params.types = { type };
    } else {
        h->params.types = { COMMON_SPECULATIVE_TYPE_DFLASH };
    }
    if (n_draft > 0) h->params.draft.n_max = n_draft;
    if (n_min   > 0) h->params.draft.n_min = n_min;
    if (p_min   > 0.0f) h->params.draft.p_min = p_min;

    h->spec = common_speculative_init(h->params, 1);
    if (!h->spec) { delete h; return nullptr; }
    return h;
}

extern "C" void eliza_speculative_free(struct eliza_speculative_handle * h) {
    if (!h) return;
    if (h->spec) common_speculative_free(h->spec);
    delete h;
}

extern "C" void eliza_speculative_begin(struct eliza_speculative_handle * h,
                                        const int32_t * prompt_ids, int32_t n_prompt) {
    if (!h || !h->spec || !prompt_ids || n_prompt <= 0) return;
    h->prompt.assign(prompt_ids, prompt_ids + n_prompt);
    common_speculative_begin(h->spec, 0, h->prompt);
}

extern "C" int32_t eliza_speculative_draft(struct eliza_speculative_handle * h,
                                           const int32_t * prompt_ids, int32_t n_prompt,
                                           int32_t id_last,
                                           int32_t * out_ids, int32_t out_cap) {
    if (!h || !h->spec || !prompt_ids || n_prompt <= 0 || !out_ids || out_cap <= 0) return 0;
    h->prompt.assign(prompt_ids, prompt_ids + n_prompt);
    h->draft.clear();
    common_speculative_get_draft_params(h->spec, 0) = {
        /* .drafting = */ true,
        /* .n_max    = */ out_cap,
        /* .n_past   = */ n_prompt,
        /* .id_last  = */ static_cast<llama_token>(id_last),
        /* .prompt   = */ &h->prompt,
        /* .result   = */ &h->draft,
    };
    common_speculative_draft(h->spec);
    const int32_t n = static_cast<int32_t>(h->draft.size());
    const int32_t copy = (n < out_cap) ? n : out_cap;
    for (int32_t i = 0; i < copy; ++i) out_ids[i] = static_cast<int32_t>(h->draft[i]);
    return copy;
}

extern "C" void eliza_speculative_accept(struct eliza_speculative_handle * h, uint16_t n_accepted) {
    if (!h || !h->spec) return;
    common_speculative_accept(h->spec, 0, n_accepted);
}

extern "C" void eliza_speculative_print_stats(const struct eliza_speculative_handle * h) {
    if (!h || !h->spec) return;
    common_speculative_print_stats(h->spec);
}

extern "C" int32_t eliza_speculative_generate_text(struct eliza_speculative_handle * h,
                                                   const char * prompt_text,
                                                   const char * grammar_text,
                                                   int32_t max_tokens,
                                                   float temperature,
                                                   char * out_text,
                                                   int32_t out_cap) {
    if (!h || !h->spec || !h->ctx_target || !h->ctx_draft) return -1;
    if (!prompt_text || !*prompt_text) {
        set_error_stats(h, "empty_prompt", -2);
        return -2;
    }
    const int32_t n_predict_limit = max_tokens > 0 ? max_tokens : 128;
    const llama_seq_id seq_id = 0;
    const auto started = std::chrono::steady_clock::now();
    auto prefill_done = started;
    auto decode_done = started;

    try {
        llama_context * ctx_tgt = h->ctx_target;
        llama_context * ctx_dft = h->ctx_draft;
        const llama_model * model_tgt = llama_get_model(ctx_tgt);
        const llama_vocab * vocab = llama_model_get_vocab(model_tgt);
        if (!model_tgt || !vocab) {
            set_error_stats(h, "missing_target_model_or_vocab", -3);
            return -3;
        }

        if (h->has_decoded) {
            llama_memory_clear(llama_get_memory(ctx_tgt), false);
            llama_memory_clear(llama_get_memory(ctx_dft), false);
        }
        llama_set_embeddings(ctx_tgt, false);
        llama_set_embeddings(ctx_dft, false);

        const auto rm_tgt = common_context_can_seq_rm(ctx_tgt);
        const auto rm_dft = common_context_can_seq_rm(ctx_dft);
        if (rm_tgt == COMMON_CONTEXT_SEQ_RM_TYPE_NO ||
            rm_dft == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
            set_error_stats(h, "sequence_removal_unavailable", -4);
            return -4;
        }
        const bool use_ckpt_tgt = rm_tgt == COMMON_CONTEXT_SEQ_RM_TYPE_FULL;
        const bool use_ckpt_dft = rm_dft == COMMON_CONTEXT_SEQ_RM_TYPE_FULL;

        llama_tokens input = common_tokenize(ctx_tgt, std::string(prompt_text), true, true);
        if (input.empty()) {
            set_error_stats(h, "tokenize_empty", -5);
            return -5;
        }

        const int32_t target_batch = std::max<int32_t>(1, static_cast<int32_t>(llama_n_batch(ctx_tgt)));
        const int32_t draft_batch = std::max<int32_t>(1, static_cast<int32_t>(llama_n_batch(ctx_dft)));
        const int32_t batch_cap = std::max<int32_t>(1, std::min(target_batch, draft_batch));
        const int32_t n_ctx = static_cast<int32_t>(llama_n_ctx(ctx_tgt));
        const int32_t prompt_capacity = std::max<int32_t>(
            1,
            n_ctx - std::max<int32_t>(n_predict_limit, batch_cap) - 1);
        if (static_cast<int32_t>(input.size()) > prompt_capacity) {
            input.erase(input.begin(), input.end() - prompt_capacity);
        }

        common_params_sampling sampling;
        sampling.seed = LLAMA_DEFAULT_SEED;
        sampling.temp = temperature;
        sampling.top_p = 0.9f;
        if (grammar_text && *grammar_text) {
            sampling.grammar = common_grammar(COMMON_GRAMMAR_TYPE_USER, std::string(grammar_text));
        }
        common_sampler_ptr sampler(common_sampler_init(model_tgt, sampling));
        if (!sampler) {
            set_error_stats(h, "sampler_init_failed", -6);
            return -6;
        }

        llama_token id_last = input.back();
        llama_tokens prompt_prefix(input.begin(), input.end() - 1);
        h->prompt = prompt_prefix;
        h->prompt.reserve(static_cast<size_t>(std::max<int32_t>(n_ctx, static_cast<int32_t>(h->prompt.size()))));
        h->draft.clear();

        if (!prompt_prefix.empty()) {
            const int rc_tgt = decode_token_span(
                ctx_tgt,
                prompt_prefix,
                0,
                prompt_prefix.size(),
                batch_cap,
                seq_id,
                0);
            if (rc_tgt != 0) {
                set_error_stats(h, "target_prefill_failed", rc_tgt);
                return -7;
            }
            const int rc_dft = decode_token_span(
                ctx_dft,
                prompt_prefix,
                0,
                prompt_prefix.size(),
                batch_cap,
                seq_id,
                0);
            if (rc_dft != 0) {
                set_error_stats(h, "draft_prefill_failed", rc_dft);
                return -8;
            }
            h->has_decoded = true;
        }
        int32_t n_past = static_cast<int32_t>(prompt_prefix.size());
        common_speculative_begin(h->spec, seq_id, h->prompt);
        prefill_done = std::chrono::steady_clock::now();

        llama_batch batch = llama_batch_init(batch_cap, 0, 1);
        std::string output;
        output.reserve(static_cast<size_t>(n_predict_limit * 4));
        int32_t n_generated = 0;
        int32_t n_drafted = 0;
        int32_t n_accepted = 0;
        common_prompt_checkpoint ckpt;
        bool has_eos = false;

        while (n_generated < n_predict_limit && !has_eos) {
            if (h->draft.empty()) {
                ckpt.update_pos(
                    static_cast<int64_t>(h->prompt.size()),
                    llama_memory_seq_pos_min(llama_get_memory(ctx_tgt), seq_id),
                    llama_memory_seq_pos_max(llama_get_memory(ctx_tgt), seq_id));
                if (use_ckpt_dft) {
                    ckpt.update_dft(ctx_dft, seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                }

                int32_t draft_cap = h->params.draft.n_max > 0 ? h->params.draft.n_max : 16;
                draft_cap = std::max<int32_t>(0, std::min(draft_cap, batch_cap - 1));
                draft_cap = std::min<int32_t>(draft_cap, n_predict_limit - n_generated - 1);
                common_speculative_get_draft_params(h->spec, seq_id) = {
                    /* .drafting = */ true,
                    /* .n_max    = */ draft_cap,
                    /* .n_past   = */ n_past,
                    /* .id_last  = */ id_last,
                    /* .prompt   = */ &h->prompt,
                    /* .result   = */ &h->draft,
                };
                if (draft_cap > 0) {
                    common_speculative_draft(h->spec);
                }
                if (static_cast<int32_t>(h->draft.size()) > draft_cap) {
                    h->draft.resize(static_cast<size_t>(draft_cap));
                }
                if (!h->draft.empty() && use_ckpt_tgt) {
                    ckpt.update_tgt(ctx_tgt, seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                }

                ckpt.load_dft(ctx_dft, seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(ctx_dft), seq_id, ckpt.pos_max + 1, -1);
            } else if (use_ckpt_tgt && ckpt.empty()) {
                llama_batch_free(batch);
                set_error_stats(h, "missing_speculative_checkpoint", -12);
                return -12;
            }
            const size_t draft_size = h->draft.size();
            const size_t n_draft_original = draft_size;

            common_batch_clear(batch);
            common_batch_add(batch, id_last, n_past++, { seq_id }, true);
            for (size_t i = 0; i < h->draft.size(); ++i) {
                common_batch_add(batch,
                                 h->draft[i],
                                 n_past + static_cast<llama_pos>(i),
                                 { seq_id },
                                 true);
            }

            const int rc_tgt = llama_decode(ctx_tgt, batch);
            if (rc_tgt != 0) {
                llama_batch_free(batch);
                set_error_stats(h, "target_decode_failed", rc_tgt);
                return -9;
            }
            h->has_decoded = true;

            const int rc_dft = llama_decode(ctx_dft, batch);
            if (rc_dft != 0) {
                llama_batch_free(batch);
                set_error_stats(h, "draft_decode_failed", rc_dft);
                return -10;
            }

            common_sampler_ptr sampler_saved;
            if (use_ckpt_tgt) {
                sampler_saved.reset(common_sampler_clone(sampler.get()));
            }
            auto ids = common_sampler_sample_and_accept_n(sampler.get(), ctx_tgt, h->draft);
            if (ids.empty()) {
                llama_batch_free(batch);
                set_error_stats(h, "no_sampled_tokens", -11);
                return -11;
            }

            const int32_t accepted =
                static_cast<int32_t>(std::min<size_t>(ids.size() - 1, draft_size));

            if (use_ckpt_tgt && ids.size() - 1 < draft_size) {
                h->draft = std::move(ids);

                ckpt.load_tgt(ctx_tgt, seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(ctx_tgt), seq_id, ckpt.pos_max + 1, -1);

                ckpt.load_dft(ctx_dft, seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(ctx_dft), seq_id, ckpt.pos_max + 1, -1);

                h->prompt.resize(static_cast<size_t>(std::max<int64_t>(0, ckpt.n_tokens)));
                if (sampler_saved) {
                    sampler = std::move(sampler_saved);
                }
                n_past = static_cast<int32_t>(h->prompt.size());
                continue;
            }

            common_speculative_accept(h->spec, seq_id, static_cast<uint16_t>(accepted));
            n_past += accepted;
            n_drafted += static_cast<int32_t>(n_draft_original);
            n_accepted += accepted;

            for (size_t i = 0; i < ids.size() && n_generated < n_predict_limit; ++i) {
                h->prompt.push_back(id_last);
                id_last = ids[i];
                if (llama_vocab_is_eog(vocab, id_last)) {
                    has_eos = true;
                    break;
                }
                output += common_token_to_piece(ctx_tgt, id_last, false);
                ++n_generated;
            }

            h->draft.clear();
            llama_memory_seq_rm(llama_get_memory(ctx_tgt), seq_id, n_past, -1);
            llama_memory_seq_rm(llama_get_memory(ctx_dft), seq_id, n_past, -1);
        }
        decode_done = std::chrono::steady_clock::now();
        llama_batch_free(batch);

        const double accept_rate =
            n_drafted > 0 ? static_cast<double>(n_accepted) / static_cast<double>(n_drafted) : 0.0;
        char stats[768];
        std::snprintf(stats, sizeof(stats),
                      "{\"ok\":true,\"nInput\":%d,\"nPredict\":%d,"
                      "\"nDrafted\":%d,\"nAccepted\":%d,\"acceptRate\":%.6f,"
                      "\"prefillMs\":%lld,\"decodeMs\":%lld,\"totalMs\":%lld,"
                      "\"batchCap\":%d,\"draftMax\":%d}",
                      static_cast<int32_t>(input.size()),
                      n_generated,
                      n_drafted,
                      n_accepted,
                      accept_rate,
                      static_cast<long long>(elapsed_ms(started, prefill_done)),
                      static_cast<long long>(elapsed_ms(prefill_done, decode_done)),
                      static_cast<long long>(elapsed_ms(started, decode_done)),
                      batch_cap,
                      h->params.draft.n_max);
        h->last_stats_json = stats;
        return copy_string_to_c_buffer(output, out_text, out_cap);
    } catch (const std::exception & e) {
        char buf[384];
        std::snprintf(buf, sizeof(buf),
                      "{\"ok\":false,\"error\":\"exception\",\"message\":\"%.240s\"}",
                      e.what());
        h->last_stats_json = buf;
        return -99;
    } catch (...) {
        set_error_stats(h, "unknown_exception", -100);
        return -100;
	    }
	}

extern "C" struct eliza_speculative_stream * eliza_speculative_stream_open(
        struct eliza_speculative_handle * h,
        const char * prompt_text,
        const char * grammar_text,
        int32_t max_tokens,
        float temperature) {
    if (!h || !h->spec || !h->ctx_target || !h->ctx_draft) return nullptr;
    if (!prompt_text || !*prompt_text) {
        set_error_stats(h, "empty_prompt", -2);
        return nullptr;
    }

    eliza_speculative_stream * s = new (std::nothrow) eliza_speculative_stream();
    if (!s) {
        set_error_stats(h, "stream_alloc_failed", -20);
        return nullptr;
    }

    s->h = h;
    s->ctx_target = h->ctx_target;
    s->ctx_draft = h->ctx_draft;
    s->seq_id = 0;
    s->n_predict_limit = max_tokens > 0 ? max_tokens : 128;
    s->started = std::chrono::steady_clock::now();
    s->prefill_done = s->started;
    s->decode_done = s->started;

    auto fail = [&](const char * code, int32_t rc) -> eliza_speculative_stream * {
        set_error_stats(h, code, rc);
        if (s->batch_initialized) {
            llama_batch_free(s->batch);
            s->batch_initialized = false;
        }
        delete s;
        return nullptr;
    };

    try {
        const llama_model * model_tgt = llama_get_model(s->ctx_target);
        s->vocab = model_tgt ? llama_model_get_vocab(model_tgt) : nullptr;
        if (!model_tgt || !s->vocab) {
            return fail("missing_target_model_or_vocab", -3);
        }

        if (h->has_decoded) {
            llama_memory_clear(llama_get_memory(s->ctx_target), false);
            llama_memory_clear(llama_get_memory(s->ctx_draft), false);
        }
        llama_set_embeddings(s->ctx_target, false);
        llama_set_embeddings(s->ctx_draft, false);

        const auto rm_tgt = common_context_can_seq_rm(s->ctx_target);
        const auto rm_dft = common_context_can_seq_rm(s->ctx_draft);
        if (rm_tgt == COMMON_CONTEXT_SEQ_RM_TYPE_NO ||
            rm_dft == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
            return fail("sequence_removal_unavailable", -4);
        }
        s->use_ckpt_tgt = rm_tgt == COMMON_CONTEXT_SEQ_RM_TYPE_FULL;
        s->use_ckpt_dft = rm_dft == COMMON_CONTEXT_SEQ_RM_TYPE_FULL;

        llama_tokens input = common_tokenize(s->ctx_target, std::string(prompt_text), true, true);
        if (input.empty()) {
            return fail("tokenize_empty", -5);
        }
        s->n_input = static_cast<int32_t>(input.size());

        const int32_t target_batch = std::max<int32_t>(1, static_cast<int32_t>(llama_n_batch(s->ctx_target)));
        const int32_t draft_batch = std::max<int32_t>(1, static_cast<int32_t>(llama_n_batch(s->ctx_draft)));
        s->batch_cap = std::max<int32_t>(1, std::min(target_batch, draft_batch));
        const int32_t n_ctx = static_cast<int32_t>(llama_n_ctx(s->ctx_target));
        const int32_t prompt_capacity = std::max<int32_t>(
            1,
            n_ctx - std::max<int32_t>(s->n_predict_limit, s->batch_cap) - 1);
        if (static_cast<int32_t>(input.size()) > prompt_capacity) {
            input.erase(input.begin(), input.end() - prompt_capacity);
        }

        common_params_sampling sampling;
        sampling.seed = LLAMA_DEFAULT_SEED;
        sampling.temp = temperature;
        sampling.top_p = 0.9f;
        if (grammar_text && *grammar_text) {
            sampling.grammar = common_grammar(COMMON_GRAMMAR_TYPE_USER, std::string(grammar_text));
        }
        common_sampler_ptr sampler(common_sampler_init(model_tgt, sampling));
        if (!sampler) {
            return fail("sampler_init_failed", -6);
        }
        s->sampler = std::move(sampler);

        s->id_last = input.back();
        llama_tokens prompt_prefix(input.begin(), input.end() - 1);
        h->prompt = prompt_prefix;
        h->prompt.reserve(static_cast<size_t>(std::max<int32_t>(n_ctx, static_cast<int32_t>(h->prompt.size()))));
        h->draft.clear();

        if (!prompt_prefix.empty()) {
            const int rc_tgt = decode_token_span(
                s->ctx_target,
                prompt_prefix,
                0,
                prompt_prefix.size(),
                s->batch_cap,
                s->seq_id,
                0);
            if (rc_tgt != 0) {
                return fail("target_prefill_failed", rc_tgt);
            }
            const int rc_dft = decode_token_span(
                s->ctx_draft,
                prompt_prefix,
                0,
                prompt_prefix.size(),
                s->batch_cap,
                s->seq_id,
                0);
            if (rc_dft != 0) {
                return fail("draft_prefill_failed", rc_dft);
            }
            h->has_decoded = true;
        }

        s->n_past = static_cast<int32_t>(prompt_prefix.size());
        common_speculative_begin(h->spec, s->seq_id, h->prompt);
        s->prefill_done = std::chrono::steady_clock::now();
        s->batch = llama_batch_init(s->batch_cap, 0, 1);
        s->batch_initialized = true;
        write_stream_stats(s);
        return s;
    } catch (const std::exception & e) {
        char buf[384];
        std::snprintf(buf, sizeof(buf),
                      "{\"ok\":false,\"error\":\"exception\",\"message\":\"%.240s\"}",
                      e.what());
        h->last_stats_json = buf;
        if (s->batch_initialized) {
            llama_batch_free(s->batch);
            s->batch_initialized = false;
        }
        delete s;
        return nullptr;
    } catch (...) {
        if (s->batch_initialized) {
            llama_batch_free(s->batch);
            s->batch_initialized = false;
        }
        delete s;
        set_error_stats(h, "unknown_exception", -100);
        return nullptr;
    }
}

extern "C" int32_t eliza_speculative_stream_next(struct eliza_speculative_stream * s,
                                                  char * out_text,
                                                  int32_t out_cap,
                                                  int32_t * out_done,
                                                  int32_t * out_drafted,
                                                  int32_t * out_accepted) {
    if (out_done) *out_done = 0;
    if (out_drafted) *out_drafted = 0;
    if (out_accepted) *out_accepted = 0;
    if (!s || !s->h || !s->h->spec || !s->batch_initialized || s->failed) return -1;
    if (s->done) {
        if (out_done) *out_done = 1;
        return copy_string_to_c_buffer("", out_text, out_cap);
    }

    try {
        std::string chunk;
        int32_t step_drafted = 0;
        int32_t step_accepted = 0;

        while (chunk.empty() && !s->done && s->n_generated < s->n_predict_limit) {
            if (s->h->draft.empty()) {
                s->ckpt.update_pos(
                    static_cast<int64_t>(s->h->prompt.size()),
                    llama_memory_seq_pos_min(llama_get_memory(s->ctx_target), s->seq_id),
                    llama_memory_seq_pos_max(llama_get_memory(s->ctx_target), s->seq_id));
                if (s->use_ckpt_dft) {
                    s->ckpt.update_dft(s->ctx_draft, s->seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                }

                int32_t draft_cap = s->h->params.draft.n_max > 0 ? s->h->params.draft.n_max : 16;
                draft_cap = std::max<int32_t>(0, std::min(draft_cap, s->batch_cap - 1));
                draft_cap = std::min<int32_t>(draft_cap, s->n_predict_limit - s->n_generated - 1);
                common_speculative_get_draft_params(s->h->spec, s->seq_id) = {
                    /* .drafting = */ true,
                    /* .n_max    = */ draft_cap,
                    /* .n_past   = */ s->n_past,
                    /* .id_last  = */ s->id_last,
                    /* .prompt   = */ &s->h->prompt,
                    /* .result   = */ &s->h->draft,
                };
                if (draft_cap > 0) {
                    common_speculative_draft(s->h->spec);
                }
                if (static_cast<int32_t>(s->h->draft.size()) > draft_cap) {
                    s->h->draft.resize(static_cast<size_t>(draft_cap));
                }
                if (!s->h->draft.empty() && s->use_ckpt_tgt) {
                    s->ckpt.update_tgt(s->ctx_target, s->seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                }

                s->ckpt.load_dft(s->ctx_draft, s->seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(s->ctx_draft), s->seq_id, s->ckpt.pos_max + 1, -1);
            } else if (s->use_ckpt_tgt && s->ckpt.empty()) {
                set_error_stats(s->h, "missing_speculative_checkpoint", -12);
                s->failed = true;
                return -12;
            }

            const size_t draft_size = s->h->draft.size();
            const size_t n_draft_original = draft_size;

            common_batch_clear(s->batch);
            common_batch_add(s->batch, s->id_last, s->n_past++, { s->seq_id }, true);
            for (size_t i = 0; i < s->h->draft.size(); ++i) {
                common_batch_add(s->batch,
                                 s->h->draft[i],
                                 s->n_past + static_cast<llama_pos>(i),
                                 { s->seq_id },
                                 true);
            }

            const int rc_tgt = llama_decode(s->ctx_target, s->batch);
            if (rc_tgt != 0) {
                set_error_stats(s->h, "target_decode_failed", rc_tgt);
                s->failed = true;
                return -9;
            }
            s->h->has_decoded = true;

            const int rc_dft = llama_decode(s->ctx_draft, s->batch);
            if (rc_dft != 0) {
                set_error_stats(s->h, "draft_decode_failed", rc_dft);
                s->failed = true;
                return -10;
            }

            common_sampler_ptr sampler_saved;
            if (s->use_ckpt_tgt) {
                sampler_saved.reset(common_sampler_clone(s->sampler.get()));
            }
            auto ids = common_sampler_sample_and_accept_n(s->sampler.get(), s->ctx_target, s->h->draft);
            if (ids.empty()) {
                set_error_stats(s->h, "no_sampled_tokens", -11);
                s->failed = true;
                return -11;
            }

            const int32_t accepted =
                static_cast<int32_t>(std::min<size_t>(ids.size() - 1, draft_size));

            if (s->use_ckpt_tgt && ids.size() - 1 < draft_size) {
                s->h->draft = std::move(ids);

                s->ckpt.load_tgt(s->ctx_target, s->seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(s->ctx_target), s->seq_id, s->ckpt.pos_max + 1, -1);

                s->ckpt.load_dft(s->ctx_draft, s->seq_id, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY | LLAMA_STATE_SEQ_FLAGS_ON_DEVICE);
                llama_memory_seq_rm(llama_get_memory(s->ctx_draft), s->seq_id, s->ckpt.pos_max + 1, -1);

                s->h->prompt.resize(static_cast<size_t>(std::max<int64_t>(0, s->ckpt.n_tokens)));
                if (sampler_saved) {
                    s->sampler = std::move(sampler_saved);
                }
                s->n_past = static_cast<int32_t>(s->h->prompt.size());
                continue;
            }

            common_speculative_accept(s->h->spec, s->seq_id, static_cast<uint16_t>(accepted));
            s->n_past += accepted;
            s->n_drafted += static_cast<int32_t>(n_draft_original);
            s->n_accepted += accepted;
            step_drafted += static_cast<int32_t>(n_draft_original);
            step_accepted += accepted;

            for (size_t i = 0; i < ids.size() && s->n_generated < s->n_predict_limit; ++i) {
                s->h->prompt.push_back(s->id_last);
                s->id_last = ids[i];
                if (llama_vocab_is_eog(s->vocab, s->id_last)) {
                    s->done = true;
                    break;
                }
                chunk += common_token_to_piece(s->ctx_target, s->id_last, false);
                ++s->n_generated;
            }

            s->h->draft.clear();
            llama_memory_seq_rm(llama_get_memory(s->ctx_target), s->seq_id, s->n_past, -1);
            llama_memory_seq_rm(llama_get_memory(s->ctx_draft), s->seq_id, s->n_past, -1);
        }

        if (s->n_generated >= s->n_predict_limit) {
            s->done = true;
        }
        if (s->done) {
            s->decode_done = std::chrono::steady_clock::now();
        }
        write_stream_stats(s);
        if (out_done) *out_done = s->done ? 1 : 0;
        if (out_drafted) *out_drafted = step_drafted;
        if (out_accepted) *out_accepted = step_accepted;
        return copy_string_to_c_buffer(chunk, out_text, out_cap);
    } catch (const std::exception & e) {
        char buf[384];
        std::snprintf(buf, sizeof(buf),
                      "{\"ok\":false,\"error\":\"exception\",\"message\":\"%.240s\"}",
                      e.what());
        s->h->last_stats_json = buf;
        s->failed = true;
        return -99;
    } catch (...) {
        set_error_stats(s->h, "unknown_exception", -100);
        s->failed = true;
        return -100;
    }
}

extern "C" void eliza_speculative_stream_free(struct eliza_speculative_stream * s) {
    if (!s) return;
    if (!s->done) {
        s->done = true;
        s->decode_done = std::chrono::steady_clock::now();
        write_stream_stats(s);
    }
    if (s->batch_initialized) {
        llama_batch_free(s->batch);
        s->batch_initialized = false;
    }
    delete s;
}

extern "C" int32_t eliza_speculative_last_stats_json(const struct eliza_speculative_handle * h,
                                                     char * out_json,
                                                     int32_t out_cap) {
    if (!h) return -1;
    return copy_string_to_c_buffer(h->last_stats_json, out_json, out_cap);
}

#else  // ELIZA_SHIM_HEADERLESS — syntax/ABI-only stub (no fork headers on path)

struct eliza_speculative_handle { int unused; };
struct eliza_speculative_stream { int unused; };
extern "C" struct eliza_speculative_handle * eliza_speculative_init(
        struct llama_context *, struct llama_context *, const char *, int, int, float) { return nullptr; }
extern "C" void eliza_speculative_free(struct eliza_speculative_handle *) {}
extern "C" void eliza_speculative_begin(struct eliza_speculative_handle *, const int32_t *, int32_t) {}
extern "C" int32_t eliza_speculative_draft(struct eliza_speculative_handle *, const int32_t *, int32_t,
                                           int32_t, int32_t *, int32_t) { return 0; }
extern "C" void eliza_speculative_accept(struct eliza_speculative_handle *, uint16_t) {}
extern "C" void eliza_speculative_print_stats(const struct eliza_speculative_handle *) {}
extern "C" int32_t eliza_speculative_generate_text(struct eliza_speculative_handle *,
                                                   const char *,
                                                   const char *,
                                                   int32_t,
                                                   float,
                                                   char *,
                                                   int32_t) { return -1; }
extern "C" struct eliza_speculative_stream * eliza_speculative_stream_open(
        struct eliza_speculative_handle *,
        const char *,
        const char *,
        int32_t,
        float) { return nullptr; }
extern "C" int32_t eliza_speculative_stream_next(struct eliza_speculative_stream *,
                                                  char *,
                                                  int32_t,
                                                  int32_t *,
                                                  int32_t *,
                                                  int32_t *) { return -1; }
extern "C" void eliza_speculative_stream_free(struct eliza_speculative_stream *) {}
extern "C" int32_t eliza_speculative_last_stats_json(const struct eliza_speculative_handle *,
                                                     char * out_json,
                                                     int32_t out_cap) {
    const char * stats = "{\"ok\":false,\"error\":\"unsupported\"}";
    if (!out_json || out_cap <= 0) return static_cast<int32_t>(std::strlen(stats) + 1);
    const int32_t required = static_cast<int32_t>(std::strlen(stats) + 1);
    const int32_t n = std::min<int32_t>(required, out_cap);
    std::memcpy(out_json, stats, static_cast<size_t>(n - 1));
    out_json[n - 1] = '\0';
    return out_cap < required ? -required : required - 1;
}

#endif
