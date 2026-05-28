// LlamaShim.h — thin C wrapper that lets Swift treat llama.cpp's
// `llama_model_params`, `llama_context_params`, and `llama_batch` as opaque
// byte bags while still being able to set the few fields elizaOS cares about.
//
// We do NOT mirror llama.cpp's structs into Swift. Their layouts drift
// across upstream releases. Instead we bundle this shim alongside llama.cpp
// in the same static library, and Swift calls these helpers via
// @_silgen_name. Whenever upstream renames a struct field, we update this
// shim once and Swift keeps working unchanged.
//
// Linked into `LlamaCpp.xcframework` by `build-ios.sh`.

#ifndef ELIZA_LLAMA_SHIM_H
#define ELIZA_LLAMA_SHIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque pass-through pointers. Swift passes UnsafeMutablePointer<...> in;
// we cast back to llama.cpp's real struct type internally.

// Set n_gpu_layers on a llama_model_params bag. Pass 999 to offload all
// layers to Metal (the recommended setting for fully-fitting models on iOS).
// Pass 0 for CPU-only.
void eliza_llama_model_params_set_n_gpu_layers(void* params, int32_t n);

// Set context size (number of tokens in the KV cache window) on a
// llama_context_params bag.
void eliza_llama_context_params_set_n_ctx(void* params, uint32_t n);

// Set thread counts on a llama_context_params bag. `n_threads` controls
// generation; `n_batch` controls prompt prefill.
void eliza_llama_context_params_set_n_threads(void* params, int32_t n_threads, int32_t n_batch);

// Set prompt/decode batch capacities on a llama_context_params bag.
void eliza_llama_context_params_set_batch_sizes(void* params, uint32_t n_batch, uint32_t n_ubatch);

// Set KV cache quantization types using ggml_type enum integer values.
void eliza_llama_context_params_set_type_k(void* params, int32_t type);
void eliza_llama_context_params_set_type_v(void* params, int32_t type);

// Configure a single-position batch from Swift. Sets:
//   batch->token[0] = token
//   batch->pos[0]   = pos
//   batch->seq_id[0][0] = 0
//   batch->n_seq_id[0]  = 1
//   batch->logits[0] = logits_out ? 1 : 0
//   batch->n_tokens = 1
void eliza_llama_batch_set_single(void* batch, int32_t token, int32_t pos, bool logits_out);

// Append a token to a batch at index `batch->n_tokens`, then increment
// `n_tokens`. Used for prompt-prefill where we want to enqueue many tokens
// before a single `llama_decode`. Caller must ensure the batch was created
// with enough capacity (see `llama_batch_init`'s n_tokens arg).
void eliza_llama_batch_append(void* batch, int32_t token, int32_t pos, bool logits_out);

// Reset `batch->n_tokens` to 0. The underlying buffers stay allocated; this
// is just a cheap clear so the same batch can be reused across prompt
// prefill, then single-token decoding loops.
void eliza_llama_batch_reset(void* batch);

// Silence llama.cpp's internal logger so it doesn't spam stderr during
// production app sessions. Idempotent.
void eliza_llama_log_silence(void);

// Reports whether llama.cpp was compiled with Metal support. Always returns
// `true` for builds produced by `build-ios.sh`; provided as a function so
// Swift code stays portable across build variants.
bool eliza_llama_has_metal(void);

// Optional acceleration hooks. Stock iOS slices return false/NULL/no drafts;
// MTP-capable slices can replace these with concrete implementations.
bool eliza_llama_speculative_supported(void);
int32_t eliza_llama_speculative_draft_gen(
    void* target_ctx,
    void* drafter_ctx,
    const int32_t* past_tokens,
    int32_t n_past,
    int32_t draft_min,
    int32_t draft_max,
    int32_t* out_drafted,
    int32_t out_capacity
);
void* eliza_llama_sampler_init_token_tree(int32_t n_vocab, const uint8_t* trie_bytes, size_t trie_size);

#ifdef __cplusplus
}
#endif

#endif // ELIZA_LLAMA_SHIM_H
