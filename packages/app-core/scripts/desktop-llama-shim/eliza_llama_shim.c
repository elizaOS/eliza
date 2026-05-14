// eliza_llama_shim.c — implementation. See eliza_llama_shim.h for rationale.
//
// Links against libllama (NEEDED at build time). The implementation is
// intentionally minimal: malloc a params struct, copy the *_default_params()
// return value into it, expose field setters by name, and dereference into
// the real llama.cpp call site when the adapter hands the pointer back.

#include "eliza_llama_shim.h"
#include "llama.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

// ─── model_params ────────────────────────────────────────────────────────────

void* eliza_llama_model_params_default(void) {
    struct llama_model_params* p = (struct llama_model_params*)malloc(sizeof(*p));
    if (!p) return NULL;
    *p = llama_model_default_params();
    return p;
}

void eliza_llama_model_params_free(void* p) { free(p); }

void eliza_llama_model_params_set_n_gpu_layers(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_model_params*)p)->n_gpu_layers = v;
}

void eliza_llama_model_params_set_use_mmap(void* p, bool v) {
    if (!p) return;
    ((struct llama_model_params*)p)->use_mmap = v;
}

void eliza_llama_model_params_set_use_mlock(void* p, bool v) {
    if (!p) return;
    ((struct llama_model_params*)p)->use_mlock = v;
}

void eliza_llama_model_params_set_vocab_only(void* p, bool v) {
    if (!p) return;
    ((struct llama_model_params*)p)->vocab_only = v;
}

void eliza_llama_model_params_set_main_gpu(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_model_params*)p)->main_gpu = v;
}

void* eliza_llama_model_load_from_file(const char* path, void* params) {
    if (!path || !params) return NULL;
    return llama_model_load_from_file(path, *(struct llama_model_params*)params);
}

// ─── context_params ──────────────────────────────────────────────────────────

void* eliza_llama_context_params_default(void) {
    struct llama_context_params* p = (struct llama_context_params*)malloc(sizeof(*p));
    if (!p) return NULL;
    *p = llama_context_default_params();
    return p;
}

void eliza_llama_context_params_free(void* p) { free(p); }

void eliza_llama_context_params_set_n_ctx(void* p, uint32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->n_ctx = v;
}
void eliza_llama_context_params_set_n_batch(void* p, uint32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->n_batch = v;
}
void eliza_llama_context_params_set_n_ubatch(void* p, uint32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->n_ubatch = v;
}
void eliza_llama_context_params_set_n_threads(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->n_threads = v;
}
void eliza_llama_context_params_set_n_threads_batch(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->n_threads_batch = v;
}
void eliza_llama_context_params_set_embeddings(void* p, bool v) {
    if (!p) return;
    ((struct llama_context_params*)p)->embeddings = v;
}
void eliza_llama_context_params_set_pooling_type(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->pooling_type = (enum llama_pooling_type)v;
}
void eliza_llama_context_params_set_type_k(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->type_k = (enum ggml_type)v;
}
void eliza_llama_context_params_set_type_v(void* p, int32_t v) {
    if (!p) return;
    ((struct llama_context_params*)p)->type_v = (enum ggml_type)v;
}
void eliza_llama_context_params_set_offload_kqv(void* p, bool v) {
    if (!p) return;
    ((struct llama_context_params*)p)->offload_kqv = v;
}

void* eliza_llama_init_from_model(void* model, void* params) {
    if (!model || !params) return NULL;
    return llama_init_from_model((struct llama_model*)model, *(struct llama_context_params*)params);
}

// ─── sampler_chain_params ────────────────────────────────────────────────────

void* eliza_llama_sampler_chain_params_default(void) {
    struct llama_sampler_chain_params* p = (struct llama_sampler_chain_params*)malloc(sizeof(*p));
    if (!p) return NULL;
    *p = llama_sampler_chain_default_params();
    return p;
}

void eliza_llama_sampler_chain_params_free(void* p) { free(p); }

void* eliza_llama_sampler_chain_init(void* params) {
    if (!params) return NULL;
    return llama_sampler_chain_init(*(struct llama_sampler_chain_params*)params);
}

// ─── batch ───────────────────────────────────────────────────────────────────

void* eliza_llama_batch_get_one(void* tokens, int32_t n_tokens) {
    if (!tokens || n_tokens <= 0) return NULL;
    struct llama_batch* b = (struct llama_batch*)malloc(sizeof(*b));
    if (!b) return NULL;
    *b = llama_batch_get_one((llama_token*)tokens, n_tokens);
    return b;
}

void eliza_llama_batch_free(void* batch) { free(batch); }

int32_t eliza_llama_decode(void* ctx, void* batch) {
    if (!ctx || !batch) return -1;
    return llama_decode((struct llama_context*)ctx, *(struct llama_batch*)batch);
}

// ─── logger ──────────────────────────────────────────────────────────────────

static void eliza__silent_log(enum ggml_log_level level, const char* text, void* user_data) {
    (void)level; (void)text; (void)user_data;
}

void eliza_llama_log_silence(void) {
    llama_log_set(eliza__silent_log, NULL);
}

// ─── DFlash combined-path (STUB) ─────────────────────────────────────────────
// The real implementation must reach into llama.cpp's common/ helpers
// (common_speculative_*) which are not exposed via the public C API and
// live in libcommon.a, not libllama.so. Phase B will pull a thin
// C wrapper over common_speculative into this shim. For now: stubs that
// return -ENOSYS so the bun:ffi surface is stable while the C++ side is
// wired up.

int32_t eliza_llama_context_attach_drafter(
    void* main_ctx, void* drafter_model,
    uint32_t n_ctx_draft, int32_t n_gpu_layers_draft) {
    (void)main_ctx; (void)drafter_model; (void)n_ctx_draft; (void)n_gpu_layers_draft;
    return -38; // -ENOSYS
}

int32_t eliza_llama_context_set_spec_mode(
    void* main_ctx, int32_t mode, int32_t draft_min, int32_t draft_max) {
    (void)main_ctx; (void)mode; (void)draft_min; (void)draft_max;
    return -38;
}

int32_t eliza_llama_decode_unified(void* ctx, void* batch) {
    // AUTO/NONE fallback: until the drafter wiring lands, decode_unified
    // delegates to plain decode. Callers that explicitly set spec_mode=DFLASH
    // already get -ENOSYS from set_spec_mode and won't reach this path.
    return eliza_llama_decode(ctx, batch);
}

void eliza_llama_dflash_stats(void* ctx, int32_t* out) {
    (void)ctx;
    if (!out) return;
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
}

// ─── token-tree / prefill-plan samplers (STUB) ───────────────────────────────
// Both samplers require implementing a custom llama_sampler vtable; the
// `llama_sampler_init` constructor is not in the public API headers
// (it's added via `llama_sampler_i` + `llama_sampler_init(...)` private
// glue). Phase B will land the vtable + serialization parser. For now:
// declared exports that return NULL so the dlopen surface is stable.

void* eliza_llama_sampler_init_token_tree(const uint8_t* trie_bytes, size_t trie_size) {
    (void)trie_bytes; (void)trie_size;
    return NULL;
}

void* eliza_llama_sampler_init_prefill_plan(const uint8_t* plan_bytes, size_t plan_size) {
    (void)plan_bytes; (void)plan_size;
    return NULL;
}
