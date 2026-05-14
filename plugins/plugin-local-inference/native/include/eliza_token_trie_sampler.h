/**
 * Token-trie sampler — C interface for constrained token generation.
 *
 * This header declares the FFI symbols and internal structures for the
 * token-trie sampler, which consumes TypeScript-side token-tree descriptors
 * (from packages/ui/src/services/local-inference/token-tree.ts) to perform
 * argmax-over-valid-tokens sampling in constrained spans.
 *
 * The sampler is initialized via llama_sampler_init_token_trie() and
 * integrates into the llama_sampler_chain. It masking logits of invalid
 * tokens to -∞, restricting the candidate set to only legally-next tokens.
 *
 * Wire format: JSON-serialized TokenTreePayload (matching the TS type).
 * Caching: LRU[128] by descriptor JSON content hash.
 * Thread safety: Single-threaded per session (matches llama.cpp's design).
 *
 * See TOKEN_TRIE_SAMPLER.md for design details.
 */

#ifndef ELIZA_TOKEN_TRIE_SAMPLER_H
#define ELIZA_TOKEN_TRIE_SAMPLER_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <stdint.h>

/**
 * Opaque llama_sampler pointer. The sampler is integrated into a
 * llama_sampler_chain and freed via llama_sampler_chain_free().
 */
struct llama_sampler;
struct llama_vocab;

/**
 * Initialize a token-trie constraint sampler.
 *
 * The sampler consumes a serialized TokenTreePayload (JSON) and builds
 * an internal prefix-trie of valid token sequences. During generation,
 * the sampler masks logits of invalid tokens to -∞, restricting sampling
 * to only tokens that are legal continuations of the current trie position.
 *
 * This eliminates wasted forward passes spent re-sampling and re-rolling
 * inside constrained regions (e.g., enum-value choices, action names).
 *
 * ## Parameters
 *
 * @param vocab
 *     The model's vocabulary (from llama_model_get_vocab()). The sampler
 *     uses this to validate token ids and resolve vocab size bounds.
 *
 * @param trie_descriptor_json
 *     The complete TokenTreePayload serialized as JSON. Schema:
 *
 *     ```json
 *     {
 *       "modelId": "eliza-1-q4-0",
 *       "descriptors": [
 *         {
 *           "path": "action",
 *           "leaves": [
 *             { "name": "THINK", "tokens": [100, 101] },
 *             { "name": "EXECUTE", "tokens": [200] }
 *           ]
 *         }
 *       ]
 *     }
 *     ```
 *
 *     The payload is also the cache key: identical payloads reuse the
 *     parsed trie via an LRU[128] cache.
 *
 *     Empty descriptors (zero leaves) result in the sampler returning
 *     nullptr. This is normal when no constrained spans apply to the
 *     current turn.
 *
 * @param mode
 *     Sampling mode:
 *     - 0: argmax-greedy. Always pick the highest logit token in the
 *       valid candidate set.
 *     - 1: sampled-from-filtered. Apply temperature, top-P, and other
 *       sampling filters to the valid candidate set, then sample.
 *     (Other modes reserved for future use.)
 *
 * ## Return value
 *
 * Returns an opaque llama_sampler* pointer on success. The sampler
 * integrates into the chain via llama_sampler_chain_add() and is freed
 * when the chain is freed (never call llama_sampler_free() directly on
 * the returned pointer — the chain owns it).
 *
 * Returns nullptr on:
 *   - JSON parse error (malformed descriptor)
 *   - Empty leaf set (no constrained tokens)
 *   - Memory allocation failure
 *
 * The caller should log a warning and fall back to grammar-only sampling
 * if nullptr is returned.
 *
 * ## Lifecycle
 *
 * Once integrated into the chain, the sampler:
 *   - Maintains internal state (current trie node position).
 *   - Updates on each eliza_inference_llm_stream_generate step.
 *   - Resets when generate is cancelled or a new generation starts.
 *
 * The sampler does NOT validate the model id. The TS layer must ensure
 * the descriptor was tokenized against the currently-loaded model.
 */
struct llama_sampler * llama_sampler_init_token_trie(
    const struct llama_vocab * vocab,
    const char * trie_descriptor_json,
    int mode
);

/**
 * Internal state structure (opaque to FFI layer, exposed for testing).
 *
 * This structure is allocated when llama_sampler_init_token_trie()
 * succeeds and is embedded in the llama_sampler.ctx field.
 *
 * Not part of the public FFI — exists for C++ implementation only.
 */
#ifdef __cplusplus

#include <unordered_map>
#include <string>
#include <memory>
#include <mutex>

/**
 * Single trie node. Matches the TS TokenTrieNode structure.
 * The trie is built on-demand from the descriptor and cached.
 */
struct TokenTrieNode {
    int token_id;                               // Token id of entering edge (-1 for root)
    std::unordered_map<int, TokenTrieNode *> children;  // Next-token map
    bool is_terminal;                           // True if path from root represents a complete leaf
    std::string leaf_name;                      // Original value name (debug / telemetry)
};

/**
 * Per-sampler state. Embedded in llama_sampler.ctx.
 */
struct token_trie_sampler_ctx {
    const llama_vocab * vocab;                  // (borrowed, not owned)
    std::string descriptor_json;                // Full JSON for cache key
    int mode;                                   // 0 = greedy, 1 = sampled
    TokenTrieNode * current_node;               // Current position in trie (reset to root per gen)
    bool is_active;                             // True when inside a constrained span
    size_t position_in_gen;                     // Token count since generation started (for debugging)
    
    // Cached flag: true if current_node has no children && is_terminal
    // Used to detect when the span should auto-reset.
    bool unique_continuation;
};

/**
 * Global LRU cache for parsed tries. Protected by g_trie_cache_lock.
 *
 * Key: SHA256(descriptor_json) hex string.
 * Value: parsed TokenTrieNode root.
 *
 * Max entries: 128. When full, evicts LRU entries with ref_count == 0.
 *
 * This cache is static to the implementation; accessible only via
 * the sampler initialization path.
 */
struct trie_cache_entry {
    std::string descriptor_json;
    TokenTrieNode * root;
    uint32_t ref_count;
};

extern std::unordered_map<std::string, trie_cache_entry> g_trie_cache;
extern std::mutex g_trie_cache_lock;

#endif  // __cplusplus

#ifdef __cplusplus
}
#endif

#endif  // ELIZA_TOKEN_TRIE_SAMPLER_H
