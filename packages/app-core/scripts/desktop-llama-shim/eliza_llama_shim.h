// eliza_llama_shim.h — Bun.dlopen-friendly pointer-style wrappers around
// llama.cpp's struct-by-value entry points.
//
// Why this exists:
//   bun:ffi cannot pass llama.cpp's by-value param structs (model_params,
//   context_params, sampler_chain_params) or `struct llama_batch` directly.
//   The SysV AArch64 / x86_64 ABI for aggregates >16 bytes uses hidden
//   return pointers / split-register lowering that bun:ffi does not
//   synthesise. This shim heap-allocates each params struct (initialized
//   from llama.cpp's *_default_params), exposes field-by-field setters,
//   and dereferences once before delegating to the real by-value entry
//   point. Same trick on the batch path: `eliza_llama_batch_get_one`
//   malloc's a `struct llama_batch *` so the adapter holds a pointer,
//   `eliza_llama_decode` dereferences it before calling `llama_decode`.
//
//   This mirrors the AOSP shim convention used by
//   `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`.
//
// Build:
//   The desktop variant is built as a standalone shared library
//   (libeliza-llama-shim.dylib / .so / .dll) that NEEDED-links libllama.<ext>.
//   See packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs.

#ifndef ELIZA_LLAMA_SHIM_H
#define ELIZA_LLAMA_SHIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── model_params ─────────────────────────────────────────────────────────────
void* eliza_llama_model_params_default(void);
void  eliza_llama_model_params_free(void* p);
void  eliza_llama_model_params_set_n_gpu_layers(void* p, int32_t v);
void  eliza_llama_model_params_set_use_mmap(void* p, bool v);
void  eliza_llama_model_params_set_use_mlock(void* p, bool v);
void  eliza_llama_model_params_set_vocab_only(void* p, bool v);
void  eliza_llama_model_params_set_main_gpu(void* p, int32_t v);

void* eliza_llama_model_load_from_file(const char* path, void* params);

// ── context_params ───────────────────────────────────────────────────────────
void* eliza_llama_context_params_default(void);
void  eliza_llama_context_params_free(void* p);
void  eliza_llama_context_params_set_n_ctx(void* p, uint32_t v);
void  eliza_llama_context_params_set_n_batch(void* p, uint32_t v);
void  eliza_llama_context_params_set_n_ubatch(void* p, uint32_t v);
void  eliza_llama_context_params_set_n_threads(void* p, int32_t v);
void  eliza_llama_context_params_set_n_threads_batch(void* p, int32_t v);
void  eliza_llama_context_params_set_embeddings(void* p, bool v);
void  eliza_llama_context_params_set_pooling_type(void* p, int32_t v);
void  eliza_llama_context_params_set_type_k(void* p, int32_t v);
void  eliza_llama_context_params_set_type_v(void* p, int32_t v);
void  eliza_llama_context_params_set_offload_kqv(void* p, bool v);

void* eliza_llama_init_from_model(void* model, void* params);

// ── sampler_chain_params ─────────────────────────────────────────────────────
void* eliza_llama_sampler_chain_params_default(void);
void  eliza_llama_sampler_chain_params_free(void* p);
void* eliza_llama_sampler_chain_init(void* params);

// ── batch ────────────────────────────────────────────────────────────────────
// Heap-pointer wrappers around `struct llama_batch`. _get_one malloc's a
// pointer initialized via `llama_batch_get_one(tokens, n_tokens)`; _free
// releases that heap struct (NOT the token buffer the caller owns).
// _decode dereferences before delegating to `llama_decode`.
void*   eliza_llama_batch_get_one(void* tokens, int32_t n_tokens);
void    eliza_llama_batch_free(void* batch);
int32_t eliza_llama_decode(void* ctx, void* batch);

// ── logger ───────────────────────────────────────────────────────────────────
void eliza_llama_log_silence(void);

// ── DFlash combined-path (STRETCH; declared but stubbed until upstream
//     spec_config bindings land). The intent is that the same llama_context
//     drives plain + speculative decoding — the drafter attaches as state,
//     spec_mode selects, and `eliza_llama_decode_unified` is the single call
//     the adapter loop uses regardless of whether speculation is active.
//
//     Mode enum (mirrors common_speculative_type in llama.cpp/common):
//       0 = NONE (plain decode)
//       1 = AUTO (use drafter if attached, else plain)
//       2 = DFLASH (force drafter; error if not attached)
//
//     Returns 0 on success, negative on error. _attach_drafter takes
//     ownership of the drafter model pointer (the adapter must not free it
//     separately; _context_free / drafter detach handles it).
// ─────────────────────────────────────────────────────────────────────────────
int32_t eliza_llama_context_attach_drafter(
    void* main_ctx,
    void* drafter_model,
    uint32_t n_ctx_draft,
    int32_t n_gpu_layers_draft);

int32_t eliza_llama_context_set_spec_mode(
    void* main_ctx,
    int32_t mode,
    int32_t draft_min,
    int32_t draft_max);

int32_t eliza_llama_decode_unified(void* ctx, void* batch);

// Telemetry counters from the most recent decode_unified call. Out fields
// are written in this order (caller passes a 4-int32 buffer):
//   [0] drafted_tokens
//   [1] accepted_tokens
//   [2] rejected_tokens
//   [3] last_decode_status
void eliza_llama_dflash_stats(void* ctx, int32_t* out);

// ── token-tree sampler (STRETCH) ─────────────────────────────────────────────
// Construct a sampler that walks a precomputed prefix trie. The trie is
// passed as a flat byte buffer using the format documented in
// `packages/shared/src/local-inference/token-tree-format.md` (forthcoming).
// Returns a `struct llama_sampler *` the adapter chains via
// llama_sampler_chain_add. Returns NULL on parse failure.
void* eliza_llama_sampler_init_token_tree(const uint8_t* trie_bytes, size_t trie_size);

// ── prefill plan sampler (STRETCH) ───────────────────────────────────────────
// Construct a sampler that emits tokens from a fixed prefill plan
// (e.g. JSON schema scaffolding). Returns a `struct llama_sampler *` or
// NULL on parse failure.
void* eliza_llama_sampler_init_prefill_plan(const uint8_t* plan_bytes, size_t plan_size);

#ifdef __cplusplus
}
#endif

#endif // ELIZA_LLAMA_SHIM_H
