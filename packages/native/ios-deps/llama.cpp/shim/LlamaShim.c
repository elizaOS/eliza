// LlamaShim.c — implementation. See LlamaShim.h for rationale.
//
// This file expects to be compiled in the same translation unit graph as
// llama.cpp itself (so it can include `llama.h` from the same checkout).
// The xcframework build script in `build-ios.sh` adds this file to the
// static library target alongside the llama.cpp sources.

#include "LlamaShim.h"
#include "llama.h"

#include <stddef.h>

void eliza_llama_model_params_set_n_gpu_layers(void* params, int32_t n) {
    struct llama_model_params* p = (struct llama_model_params*)params;
    p->n_gpu_layers = n;
}

void eliza_llama_context_params_set_n_ctx(void* params, uint32_t n) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->n_ctx = n;
}

void eliza_llama_context_params_set_n_threads(void* params, int32_t n_threads, int32_t n_batch) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->n_threads = n_threads;
    p->n_threads_batch = n_batch;
}

void eliza_llama_context_params_set_batch_sizes(void* params, uint32_t n_batch, uint32_t n_ubatch) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->n_batch = n_batch;
    p->n_ubatch = n_ubatch;
}

void eliza_llama_context_params_set_type_k(void* params, int32_t type) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->type_k = (enum ggml_type)type;
}

void eliza_llama_context_params_set_type_v(void* params, int32_t type) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->type_v = (enum ggml_type)type;
}

void eliza_llama_batch_set_single(void* batch, int32_t token, int32_t pos, bool logits_out) {
    struct llama_batch* b = (struct llama_batch*)batch;
    b->token[0] = token;
    b->pos[0] = pos;
    b->n_seq_id[0] = 1;
    b->seq_id[0][0] = 0;
    b->logits[0] = logits_out ? 1 : 0;
    b->n_tokens = 1;
}

void eliza_llama_batch_append(void* batch, int32_t token, int32_t pos, bool logits_out) {
    struct llama_batch* b = (struct llama_batch*)batch;
    int32_t idx = b->n_tokens;
    b->token[idx] = token;
    b->pos[idx] = pos;
    b->n_seq_id[idx] = 1;
    b->seq_id[idx][0] = 0;
    b->logits[idx] = logits_out ? 1 : 0;
    b->n_tokens = idx + 1;
}

void eliza_llama_batch_reset(void* batch) {
    struct llama_batch* b = (struct llama_batch*)batch;
    b->n_tokens = 0;
}

// Silent logger callback — explicitly ignore everything.
static void eliza__silent_log(enum ggml_log_level level, const char* text, void* user_data) {
    (void)level;
    (void)text;
    (void)user_data;
}

void eliza_llama_log_silence(void) {
    llama_log_set(eliza__silent_log, NULL);
}

bool eliza_llama_has_metal(void) {
    return llama_supports_gpu_offload();
}

bool eliza_llama_speculative_supported(void) {
    return false;
}

int32_t eliza_llama_speculative_draft_gen(
    void* target_ctx,
    void* drafter_ctx,
    const int32_t* past_tokens,
    int32_t n_past,
    int32_t draft_min,
    int32_t draft_max,
    int32_t* out_drafted,
    int32_t out_capacity
) {
    (void)target_ctx;
    (void)drafter_ctx;
    (void)past_tokens;
    (void)n_past;
    (void)draft_min;
    (void)draft_max;
    (void)out_drafted;
    (void)out_capacity;
    return 0;
}

void* eliza_llama_sampler_init_token_tree(
    int32_t n_vocab,
    const uint8_t* trie_bytes,
    size_t trie_size
) {
    (void)n_vocab;
    (void)trie_bytes;
    (void)trie_size;
    return NULL;
}
