// LlamaShim.c — implementation. See LlamaShim.h for rationale.
//
// This file expects to be compiled in the same translation unit graph as
// llama.cpp itself (so it can include `llama.h` from the same checkout).
// The xcframework build script in `build-ios.sh` adds this file to the
// static library target alongside the llama.cpp sources.

#include "LlamaShim.h"
#include "llama.h"

#include <stddef.h>

void milady_llama_model_params_set_n_gpu_layers(void* params, int32_t n) {
    struct llama_model_params* p = (struct llama_model_params*)params;
    p->n_gpu_layers = n;
}

void milady_llama_context_params_set_n_ctx(void* params, uint32_t n) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->n_ctx = n;
}

void milady_llama_context_params_set_n_threads(void* params, int32_t n_threads, int32_t n_batch) {
    struct llama_context_params* p = (struct llama_context_params*)params;
    p->n_threads = n_threads;
    p->n_threads_batch = n_batch;
}

void milady_llama_batch_set_single(void* batch, int32_t token, int32_t pos, bool logits_out) {
    struct llama_batch* b = (struct llama_batch*)batch;
    b->token[0] = token;
    b->pos[0] = pos;
    b->n_seq_id[0] = 1;
    b->seq_id[0][0] = 0;
    b->logits[0] = logits_out ? 1 : 0;
    b->n_tokens = 1;
}

void milady_llama_batch_append(void* batch, int32_t token, int32_t pos, bool logits_out) {
    struct llama_batch* b = (struct llama_batch*)batch;
    int32_t idx = b->n_tokens;
    b->token[idx] = token;
    b->pos[idx] = pos;
    b->n_seq_id[idx] = 1;
    b->seq_id[idx][0] = 0;
    b->logits[idx] = logits_out ? 1 : 0;
    b->n_tokens = idx + 1;
}

void milady_llama_batch_reset(void* batch) {
    struct llama_batch* b = (struct llama_batch*)batch;
    b->n_tokens = 0;
}

// Silent logger callback — explicitly ignore everything.
static void milady__silent_log(enum ggml_log_level level, const char* text, void* user_data) {
    (void)level;
    (void)text;
    (void)user_data;
}

void milady_llama_log_silence(void) {
    llama_log_set(milady__silent_log, NULL);
}

bool milady_llama_has_metal(void) {
#if defined(GGML_USE_METAL) || defined(LM_GGML_USE_METAL)
    return true;
#else
    return false;
#endif
}
