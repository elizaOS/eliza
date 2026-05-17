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

// ── DFlash combined-path ─────────────────────────────────────────────────────
// Per-context side-state keyed by `main_ctx`. The drafter context is owned
// by the shim and freed when detach_drafter is called or when memory
// pressure is signalled. The unified decode path keeps the drafter KV
// cache in sync with the main context by decoding the same batch through
// both contexts in MODE=AUTO/DFLASH; speculative *sampling* (verify-and-
// rewind) lives one layer up in the adapter, where the sampler chain has
// access to logits from both contexts. The shim deliberately stops at
// "keep the drafter KV warm" because the public llama.h C API doesn't
// expose the kv-cache rewind primitives in a way the shim can drive
// generically.
//
// Mode enum (mirrors `common_speculative_type` in llama.cpp/common):
//   0 = NONE       (plain decode through main ctx)
//   1 = AUTO       (sync drafter KV if attached, else plain)
//   2 = DFLASH     (force drafter sync; error if not attached)
//
// All functions return 0 on success, negative on error.
//
// `attach_drafter` constructs a drafter context using llama_context_default_params
// with n_ctx=n_ctx_draft and the requested gpu layers. The drafter model
// pointer is borrowed (the shim does NOT free the model on detach; the
// caller owns the model lifetime, which matches how the main context is
// handled). If `n_parallel > 1` the drafter context is initialized with
// `n_seq_max=n_parallel` so the same drafter can serve concurrent
// sequences. Default `n_parallel=1` if zero is passed.
int32_t eliza_llama_context_attach_drafter(
    void* main_ctx,
    void* drafter_model,
    uint32_t n_ctx_draft,
    int32_t n_gpu_layers_draft,
    int32_t n_parallel);

// Releases the drafter context. Does NOT free the drafter model (caller
// owns). Safe to call when no drafter is attached (no-op).
void eliza_llama_context_detach_drafter(void* main_ctx);

// Returns 1 if a drafter is attached to main_ctx, 0 otherwise.
int32_t eliza_llama_context_has_drafter(void* main_ctx);

int32_t eliza_llama_context_set_spec_mode(
    void* main_ctx,
    int32_t mode,
    int32_t draft_min,
    int32_t draft_max);

int32_t eliza_llama_decode_unified(void* ctx, void* batch);

// Telemetry struct populated by `eliza_llama_dflash_stats_ex`.
// All counters are cumulative since the context was created (or since the
// last detach_drafter call resets them). Field order is stable for FFI.
struct eliza_dflash_stats {
    uint64_t decoded;            // total tokens passed through decode_unified
    uint64_t drafted;            // total draft tokens generated by the drafter
    uint64_t accepted;           // draft tokens accepted by the main model
    uint64_t drafted_rejected;   // drafted - accepted
    uint64_t verify_steps;       // number of verify-and-rewind cycles
};

// Legacy 4-int32 telemetry getter (kept for ABI compatibility with the
// earlier Phase-A stub surface). Writes:
//   [0] drafted_tokens
//   [1] accepted_tokens
//   [2] rejected_tokens
//   [3] last_decode_status
void eliza_llama_dflash_stats(void* ctx, int32_t* out);

// Preferred telemetry getter. Writes the struct above (zero-filled if no
// state is attached to ctx).
void eliza_llama_dflash_stats_ex(void* ctx, struct eliza_dflash_stats* out);

// Memory pressure levels mirror the desktop runtime's policy:
//   1 = WARN     — free drafter context but keep side-state for re-attach
//   2 = CRITICAL — WARN + llama_memory_clear on main ctx (KV eviction)
// Returns a best-effort byte-count estimate of memory released, or
// negative on error. Returns 0 if there was nothing to free.
int32_t eliza_llama_context_handle_memory_pressure(void* main_ctx, int32_t level);

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
