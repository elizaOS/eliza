# Token-Trie Sampler — Design & FFI Integration

## Goal

The token-trie sampler consumes the TypeScript-side token-tree descriptor (`packages/ui/src/services/local-inference/token-tree.ts`) to perform **argmax-over-valid-tokens** sampling inside constrained spans. Instead of repeatedly sampling and rejecting invalid tokens (the existing grammar-based flow), the sampler builds a decision trie at the C++ layer and restricts the logit pool to only legally-next tokens at each step. This eliminates wasted forward passes inside enum-value constraints, action-name choices, and other pin-the-set-of-continuations regions — achieving **unique-prefix skip-ahead** with no re-rolls.

The sampler runs on **every backend** (CPU, Metal, CUDA, Vulkan) because it operates at the logit-masking layer, above backend selection. It surfaces through the FFI ABI (`plugins/plugin-local-inference/src/services/ffi-llm-streaming-abi.ts`), not llama-server's HTTP fields, allowing both the desktop FFI path and the AOSP in-process path to activate the optimization without subprocess overhead.

## Sampler Interface (C/C++ Side)

### Symbol Declaration

```c
/**
 * Initialize a token-trie constraint sampler.
 *
 * Builds a decision trie from a serialized TokenTreePayload (JSON), enabling
 * argmax sampling over only the valid next-token set at each generation step.
 * The trie is keyed by the JSON descriptor; repeated calls with identical
 * payloads reuse the in-process cache (see §Cache plan below).
 *
 * @param vocab              The model's vocabulary (from llama_model_get_vocab).
 * @param trie_descriptor_json
 *                           Serialized TokenTreePayload in JSON. Must match
 *                           the TS TokenTreePayload type:
 *                           {
 *                             "modelId": string,
 *                             "descriptors": [
 *                               {
 *                                 "path": "action" | "parameters.fieldName" | "contexts[]" | ...,
 *                                 "leaves": [
 *                                   { "name": "ActionName", "tokens": [tok1, tok2, ...] },
 *                                   ...
 *                                 ]
 *                               },
 *                               ...
 *                             ]
 *                           }
 * @param mode               0 = argmax-greedy (always pick highest logit in
 *                           valid set), 1 = sampled-from-filtered (apply temp/
 *                           topP to the valid candidate set, then sample).
 *
 * @returns Opaque sampler pointer. Ownership transfers to the caller, who must
 *          call llama_sampler_free() when done (indirectly via chain cleanup).
 *          Returns nullptr on parse error or empty leaf set.
 */
struct llama_sampler * llama_sampler_init_token_trie(
    const struct llama_vocab * vocab,
    const char * trie_descriptor_json,
    int mode
);
```

### Sampler Lifecycle

Every `llama_sampler` in the chain implements a common interface (from `llama.cpp`):

```c
struct llama_sampler {
    // User-readable name for debugging.
    const char * (*name)(struct llama_sampler *);
    
    // Called when a token is generated (from elsewhere in the chain).
    // The trie sampler tracks its position in the trie and updates state.
    void (*accept)(struct llama_sampler *, llama_token);
    
    // Called on each sampling step: apply the constraint to the candidate
    // logits. The trie sampler masks logits of tokens NOT in node.children
    // to -inf, leaving only valid-next tokens unmasked. If the node is
    // terminal with no children (uniqueContinuation), returns immediately
    // (nothing to mask).
    void (*apply)(struct llama_sampler *, llama_token_data_array *);
    
    // Called when generate resets (e.g., user cancels or new generation
    // starts). The trie sampler resets to the root node.
    void (*reset)(struct llama_sampler *);
    
    // Called when the sampler is cloned (e.g., for a new session with same
    // params). The trie sampler clones its internal state (current position
    // in the trie, descriptor JSON for caching).
    struct llama_sampler * (*clone)(struct llama_sampler *);
    
    // Called when freeing the sampler. The trie sampler releases its context
    // (parsed descriptor, cached trie if ref count reaches zero).
    void (*free)(struct llama_sampler *);
    
    void * ctx;  // Opaque context; points to the trie sampler's state struct.
};
```

### Internal State Machine

The `llama_sampler_init_token_trie` returns a sampler whose `.ctx` points to:

```cpp
struct token_trie_sampler {
    const llama_vocab * vocab;          // (borrowed from model)
    std::string descriptor_json;        // Full input for cache key
    int mode;                           // 0 = greedy, 1 = sampled
    TokenTrieNode * current_node;       // Current position in trie (reset to root per gen)
    size_t position_in_span;            // Byte offset in current span (for multi-descriptor cases)
    bool is_active;                     // True when current_node != root && position < span_end
    bool unique_continuation;           // Cached from isUniqueContinuation(current_node)
    std::unordered_map<size_t, TokenTrieNode *> trie_cache;  // LRU[128]
};
```

**Invariants:**
- When the sampler is initialized, `current_node = root`, `is_active = false`.
- When a token is accepted, the sampler either steps forward in the trie (if the token is in `current_node->children`) or marks `is_active = false` (leaf reached, span ending or multi-descriptor boundary crossed).
- On `apply`, if `is_active && current_node->children.size() > 0`, only tokens in `children` keys are left unmasked; all others get `-inf` logits.
- On `reset`, the sampler resets `current_node = root` and `is_active = false`.
- **Critical invariant for per-prompt activation** (see §6 below): the descriptor contains a `path` tag. The sampler must be **explicitly activated** by the consumer to apply constraints only inside the right span.

## Sampler Chain Integration

### Existing Chain in `common/sampling.cpp:196+`

The current initialization builds a chain like this:

```cpp
// Line 196
llama_sampler * chain = llama_sampler_chain_init(lparams);
std::vector<llama_sampler *> samplers;

// Lines 311–356: build samplers vector in order
if (params.has_logit_bias()) {
    samplers.push_back(llama_sampler_init_logit_bias(...));
}

// Temperature, Top-K, Top-P, DRY, penalties, etc.
for (const auto & cnstr : params.samplers) {
    switch (cnstr) {
        case COMMON_SAMPLER_TYPE_TOP_K:
            samplers.push_back(llama_sampler_init_top_k(params.top_k));
            break;
        // ... more samplers ...
    }
}

// Final sampling selector (dist, mirostat, etc.)
samplers.push_back(llama_sampler_init_dist(params.seed));

// Lines 385–387: add all to chain
for (auto * smpl : samplers) {
    llama_sampler_chain_add(chain, smpl);
}

// AFTER the chain is built, grammar is attached separately
if (grmr) {
    // grammar is NOT in the chain; it's applied in common_sampler_accept()
}
```

### Proposed Insertion Point

The token-trie sampler must run **BEFORE the grammar sampler** (so the trie narrows the valid set first) and **AFTER temperature/penalty samplers** (so those modify logits of the full candidate set before the trie masks). The ordering is:

1. **Logit bias** (if set)
2. **DRY, penalties, frequency, presence** (token-shaping filters)
3. **Top-K, Top-P, Min-P, XTC, TypicalP** (candidate set reduction)
4. **Temperature** (logit scaling)
5. **[NEW] Token-Trie Sampler** ← Here: the trie masks to only valid next-tokens
6. **Adaptive-P / Dist / Mirostat** (final sampling selector)
7. **Grammar** (separate, applied in `common_sampler_accept` if `grammar_should_apply()`)

### Code Integration Pattern

```cpp
// In common_sampler_init, after building logit_bias & other samplers:

// NEW: Token-trie sampler (if trie descriptor provided)
llama_sampler * trie_smpl = nullptr;
if (!params.token_trie_descriptor_json.empty()) {
    trie_smpl = llama_sampler_init_token_trie(
        vocab,
        params.token_trie_descriptor_json.c_str(),
        params.token_trie_mode  // 0 = greedy, 1 = sampled
    );
    if (!trie_smpl) {
        LOG_WRN("%s: token-trie initialization failed, falling back to grammar\n", __func__);
    }
}

// ... existing samplers added to vector ...

// Temperature sampler added last before dist/mirostat
samplers.push_back(llama_sampler_init_temp_ext(params.temp, ...));

// Add trie sampler to chain BEFORE dist/mirostat
if (trie_smpl) {
    llama_sampler_chain_add(chain, trie_smpl);
}

// Add final selector (dist, adaptive-p, mirostat, etc.)
if (use_adaptive_p) {
    samplers.push_back(llama_sampler_init_adaptive_p(...));
} else {
    samplers.push_back(llama_sampler_init_dist(params.seed));
}

for (auto * smpl : samplers) {
    llama_sampler_chain_add(chain, smpl);
}
```

### Storage in `common_params_sampling`

Add two fields to `struct common_params_sampling` (in `common/arg.h` and its initialization):

```cpp
struct common_params_sampling {
    // ... existing fields ...
    
    // Token-trie constraint payload (JSON). Empty string = no trie.
    std::string token_trie_descriptor_json;
    
    // Trie sampling mode: 0 = argmax-greedy, 1 = sampled-from-filtered.
    int token_trie_mode = 0;
};
```

## FFI ABI Extension

### New C Symbols in the Libllama Common Shim

The fork's shim (linking against llama.cpp's sampler chain) exports the new symbols:

```c
/**
 * Activate token-trie constraint for the active generation context.
 *
 * The payload is the serialized TokenTreePayload. This symbol is called from
 * TS-side (via bun:ffi) before calling eliza_inference_llm_stream_generate.
 * The context stores the payload for use by the sampler during generation.
 *
 * @param handle           Active FfiLlmHandle from eliza_inference_llm_stream_open.
 * @param trie_payload_json  JSON string (full TokenTreePayload).
 * @param payload_len      Length of the JSON string (for bounds checking).
 * @param mode             0 = greedy, 1 = sampled.
 */
void eliza_inference_set_token_trie(
    FfiLlmHandle handle,
    const char * trie_payload_json,
    size_t payload_len,
    int mode
);

/**
 * Deactivate token-trie constraint (return to grammar-only sampling).
 * Called when the constrained span ends or the context is reused for
 * a different prompt.
 *
 * @param handle           Active FfiLlmHandle.
 */
void eliza_inference_clear_token_trie(FfiLlmHandle handle);
```

### Integration into `ffi-llm-streaming-abi.ts`

In the existing `FfiLlmStreamingAbi` interface, add optional methods:

```typescript
export interface FfiLlmStreamingAbi {
    // ... existing methods (open, prefill, generate, cancel, close) ...
    
    /**
     * Set token-trie constraint for the next generate call.
     * If provided, the trie replaces the grammar constraint for logit masking.
     *
     * @param handle           Active session handle.
     * @param triePayloadJson  Serialized TokenTreePayload.
     * @param mode             0 = greedy, 1 = sampled.
     */
    eliza_inference_set_token_trie?(
        handle: FfiLlmHandle,
        triePayloadJson: string,
        mode: number
    ): void;
    
    /**
     * Clear the trie constraint (return to grammar-only mode).
     *
     * @param handle           Active session handle.
     */
    eliza_inference_clear_token_trie?(handle: FfiLlmHandle): void;
}
```

**Note:** These are optional (`?`) to maintain backward compatibility with older fused builds that don't have the trie sampler symbols.

### Symbol Resolution Pattern (in `ffi-streaming-runner.ts`)

```typescript
async function setupTrieConstraint(
    handle: FfiLlmHandle,
    triePayload: TokenTreePayload | null,
    mode: number,
): Promise<void> {
    if (!triePayload) {
        // Clear any prior trie
        if (typeof this.ffi.eliza_inference_clear_token_trie === 'function') {
            this.ffi.eliza_inference_clear_token_trie(handle);
        }
        return;
    }
    
    // Set the new trie payload
    if (typeof this.ffi.eliza_inference_set_token_trie === 'function') {
        const json = JSON.stringify(triePayload);
        this.ffi.eliza_inference_set_token_trie(handle, json, mode);
    } else {
        // Fallback: log a warning, continue with grammar-only
        logger.warn('Token-trie sampler not available in this build');
    }
}
```

## TS-Side Wiring

### Integration into `ffi-streaming-runner.ts`

The runner's `runGenerateInner()` method (around line 145) should call `setupTrieConstraint` before each `eliza_inference_llm_stream_generate`:

```typescript
async runGenerateInner(
    args: FfiStreamingGenerateArgs,
    onStep: (step: LlmStreamStep) => void,
): Promise<void> {
    // 1. Prefill as usual
    const prefilled = this.ffi.eliza_inference_llm_stream_prefill(
        this.ctx.handle,
        args.promptTokens,
        args.slotId,
    );
    if (prefilled < 0) {
        throw new Error('Prefill failed');
    }
    
    // 2. [NEW] Activate token-trie constraint if provided
    if (args.tokenTreePayload) {
        await setupTrieConstraint(
            this.ctx.handle,
            args.tokenTreePayload,
            args.tokenTreeMode ?? 0,
        );
    }
    
    // 3. Generate
    await new Promise<void>((resolve, reject) => {
        const result = this.ffi.eliza_inference_llm_stream_generate(
            this.ctx.handle,
            args.maxTokens,
            args.temperature,
            args.topP,
            (tokenId, tokenText, isDone) => {
                // onStep callback
                onStep({ tokens: [tokenId], text: tokenText, done: isDone, ... });
                if (isDone) resolve();
            },
        );
        if (result !== 0) {
            reject(new Error(`generate failed: ${result}`));
        }
    });
    
    // 4. Clear trie constraint
    if (args.tokenTreePayload) {
        await setupTrieConstraint(this.ctx.handle, null, 0);
    }
}
```

### Adding Fields to `FfiStreamingGenerateArgs`

In `ffi-streaming-runner.ts`, add:

```typescript
export interface FfiStreamingGenerateArgs {
    // ... existing fields ...
    
    /** Optional token-tree constraint payload (from packages/ui/src/services/...). */
    tokenTreePayload?: TokenTreePayload;
    
    /** Trie sampling mode: 0 = greedy, 1 = sampled. Ignored if tokenTreePayload is null. */
    tokenTreeMode?: number;
}
```

### AOSP Integration

The AOSP adapter (`aosp-llama-streaming.ts`) follows the same pattern: if the underlying `libelizainference.so` exports `eliza_inference_set_token_trie` and `eliza_inference_clear_token_trie`, the `AospStreamingLlmBinding` should support them.

```typescript
export interface AospStreamingLlmBinding {
    // ... existing methods ...
    
    // Only if the underlying .so supports the trie sampler
    llmStreamSetTokenTrie?(args: {
        stream: AospLlmStreamHandle;
        triePayloadJson: string;
        mode: number;
    }): void;
    
    llmStreamClearTokenTrie?(args: {
        stream: AospLlmStreamHandle;
    }): void;
}
```

## Deactivation & Per-Prompt Activation

The token-tree descriptor carries a `path` tag (e.g., `"action"`, `"parameters.fieldName"`, `"contexts[]"`). **The C++ sampler does NOT validate the path** — it assumes the caller has determined the span boundaries and only calls `eliza_inference_set_token_trie` when inside the right region.

### Activation Protocol

1. **The executor (chat router / planner dispatcher) decides** whether the current prompt is in a constrained region. This decision is made at the TS layer based on `responseSkeleton.spans`.

2. **If in a constrained region**, the executor calls `setupTrieConstraint(handle, tokenTreePayload, mode)` before `generate()`.

3. **The C++ sampler** updates its position in the trie on every `accept()` call, regardless of whether `apply()` masks anything (the trie is always tracking, but only masks when `is_active && children.size() > 0`).

4. **When the span ends** (detected at the TS layer via `isTerminal && children.size() === 0`), the executor calls `setupTrieConstraint(handle, null, 0)` to reset.

### No Per-Token Protocol Needed

The sampler does NOT expose a per-token "is this position in the span?" query. Instead:
- The TS layer manages span activation/deactivation based on `responseSkeleton`.
- The C++ sampler maintains position state but only applies masking when active.
- This keeps the FFI surface small and avoids round-trip latency per token.

## Cache Plan

### Motivation

Building the trie from the JSON descriptor on every prompt is wasteful. The descriptor is keyed by `(modelId, sortedStringSet)`, so the same action set (or enum field values) across multiple turns reuses the trie structure.

### Cache Design

The C++ sampler allocates an **LRU cache with max=128 entries** in a thread-local or static context (since llama.cpp's sampler chain is single-threaded per session):

```cpp
// In sampler initialization
struct trie_cache_entry {
    std::string descriptor_json;
    TokenTrieNode * root;
    size_t ref_count;           // Multiple samplers can reference the same trie
};

static std::unordered_map<std::string, trie_cache_entry> g_trie_cache;
static std::mutex g_trie_cache_lock;

// Hash key: SHA256(descriptor_json) — ensures determinism
std::string cache_key = sha256_hex(descriptor_json);

// On eliza_inference_set_token_trie:
{
    std::lock_guard<std::mutex> lock(g_trie_cache_lock);
    if (g_trie_cache.count(cache_key)) {
        // Reuse existing trie
        ctx->current_node = g_trie_cache[cache_key].root;
        g_trie_cache[cache_key].ref_count += 1;
    } else {
        // Parse JSON, build new trie, cache it
        TokenTrieNode * root = parse_and_build_trie(descriptor_json);
        g_trie_cache[cache_key] = { descriptor_json, root, 1 };
        ctx->current_node = root;
    }
    
    // Evict LRU if cache exceeds 128 entries
    if (g_trie_cache.size() > 128) {
        // Find entry with ref_count == 0 and oldest insertion time
        // Evict it
    }
}
```

### Memory Estimate

For the typical action set (30 actions × ~4 tokens each with ~30% prefix sharing):
- ~20–30 trie nodes per action = ~600–900 nodes total
- Per node: ~200 bytes (V8 hidden class + Map overhead) = ~120–180 KB per trie
- 128 tries in LRU = ~15–23 MB

This is well within the system budget (no eviction pressure on typical devices).

## Test Plan

### C++ Unit Tests

Add a new file `plugins/plugin-local-inference/native/tests/test_token_trie_sampler.cpp`:

```cpp
#include <gtest/gtest.h>
#include "llama.h"
#include "token_trie_sampler.h"

class TokenTrieSamplerTest : public ::testing::Test {
protected:
    const llama_vocab * vocab;  // Fixture setup loads a tiny test model
    
    void SetUp() override {
        // Load a small test model (or mock vocab)
    }
};

TEST_F(TokenTrieSamplerTest, InitializeEmptyDescriptor) {
    // Descriptor with zero leaves should return nullptr
    const char * json = R"({ "modelId": "test", "descriptors": [] })";
    auto sampler = llama_sampler_init_token_trie(vocab, json, 0);
    EXPECT_EQ(sampler, nullptr);
}

TEST_F(TokenTrieSamplerTest, MaskInvalidTokens) {
    // Build a descriptor for two actions: "THINK" [t1, t2] and "EXECUTE" [e1]
    // Create mock logits, apply sampler, verify only {t1, e1} are unmasked
    const char * json = R"({
        "modelId": "test",
        "descriptors": [{
            "path": "action",
            "leaves": [
                { "name": "THINK", "tokens": [100, 101] },
                { "name": "EXECUTE", "tokens": [200] }
            ]
        }]
    })";
    auto sampler = llama_sampler_init_token_trie(vocab, json, 0);
    ASSERT_NE(sampler, nullptr);
    
    // Mock logits: arbitrary values for tokens 100, 200, 999
    llama_token_data candidates[] = {
        {100, 5.0f, 0.0f},
        {200, 4.0f, 0.0f},
        {999, 6.0f, 0.0f},  // Invalid (not in trie)
    };
    llama_token_data_array logits = {
        candidates,
        3,
        -1,
        false
    };
    
    // Apply sampler's masking
    sampler->apply(sampler, &logits);
    
    // Verify token 999 is now -inf, others unchanged
    EXPECT_FLOAT_EQ(logits.data[0].logit, 5.0f);    // 100: valid
    EXPECT_FLOAT_EQ(logits.data[1].logit, 4.0f);    // 200: valid
    EXPECT_TRUE(std::isinf(logits.data[2].logit) && logits.data[2].logit < 0.0f);  // 999: masked
    
    sampler->free(sampler);
}

TEST_F(TokenTrieSamplerTest, TrieWalking) {
    // Accept token 100 (first of "THINK"), verify current_node advances
    // Accept token 101 (second of "THINK"), verify terminal & no children
    const char * json = R"({
        "modelId": "test",
        "descriptors": [{
            "path": "action",
            "leaves": [{"name": "THINK", "tokens": [100, 101]}]
        }]
    })";
    auto sampler = llama_sampler_init_token_trie(vocab, json, 0);
    ASSERT_NE(sampler, nullptr);
    
    // At root, next token can only be 100
    llama_token_data candidates[] = { {100, 1.0f, 0.0f} };
    llama_token_data_array logits = { candidates, 1, -1, false };
    sampler->apply(sampler, &logits);
    EXPECT_FLOAT_EQ(logits.data[0].logit, 1.0f);  // unmasked
    
    sampler->accept(sampler, 100);
    
    // After accepting 100, next token must be 101
    logits.data[0].id = 101;
    sampler->apply(sampler, &logits);
    EXPECT_FLOAT_EQ(logits.data[0].logit, 1.0f);  // unmasked
    
    sampler->accept(sampler, 101);
    
    // After 101, we're at terminal. Next token is unconstrained (root again).
    // No-op apply.
    sampler->apply(sampler, &logits);
    
    sampler->free(sampler);
}
```

### TypeScript Integration Tests

Add a test in `plugins/plugin-local-inference/src/services/__tests__/ffi-streaming-runner.test.ts`:

```typescript
describe('FfiStreamingRunner with token-trie', () => {
    it('should call eliza_inference_set_token_trie before generate', async () => {
        const mockFfi = createMockFfi();
        const setTrieSpy = jest.fn();
        const clearTrieSpy = jest.fn();
        mockFfi.eliza_inference_set_token_trie = setTrieSpy;
        mockFfi.eliza_inference_clear_token_trie = clearTrieSpy;
        
        const runner = new FfiStreamingRunner(mockFfi, mockCtx);
        const triePayload: TokenTreePayload = {
            modelId: 'test-model',
            descriptors: [{
                path: 'action',
                leaves: [
                    { name: 'THINK', tokens: [100, 101] },
                    { name: 'EXECUTE', tokens: [200] },
                ],
            }],
        };
        
        await runner.generateWithUsage({
            promptTokens: new Int32Array([1, 2, 3]),
            slotId: -1,
            maxTokens: 10,
            temperature: 0.7,
            topP: 0.9,
            tokenTreePayload: triePayload,
            tokenTreeMode: 0,  // greedy
            onTextChunk: jest.fn(),
        });
        
        // Verify set_token_trie was called with the payload
        expect(setTrieSpy).toHaveBeenCalledWith(
            expect.any(Object),  // handle
            JSON.stringify(triePayload),
            0,  // mode
        );
        
        // Verify clear_token_trie was called at the end
        expect(clearTrieSpy).toHaveBeenCalled();
    });
});
```

### End-to-End Benchmark

Add a benchmark mode `--mode strict-trie-ffi` to the existing benchmark suite. Measure:

- **Skip-ratio**: `(full_candidates - valid_candidates) / full_candidates` at each step inside the trie.
- **Forward-pass delta**: tokens evaluated in trie mode vs. grammar-only mode (the trie should match the grammar's valid set).
- **Latency delta**: generation time per token with trie vs. without.
- **Token accuracy**: verify that trie mode produces identical tokens as grammar mode (bit-exact match on logit argmax).

Example invocation:

```bash
# Baseline (grammar-only)
./build-bench --mode strict-guided \
    --model path/to/model.gguf \
    --prompt path/to/action-enum-prompt.txt \
    --output bench-grammar.json

# Trie mode
./build-bench --mode strict-trie-ffi \
    --model path/to/model.gguf \
    --prompt path/to/action-enum-prompt.txt \
    --token-tree-descriptor path/to/trie-descriptor.json \
    --output bench-trie.json
```

Benchmark output should include:
```json
{
  "mode": "strict-trie-ffi",
  "model": "...",
  "skip_ratio_mean": 0.65,
  "skip_ratio_std": 0.08,
  "tokens_per_second": 42.1,
  "tokens_per_second_vs_grammar": 1.08,  // 8% faster
  "token_accuracy": 1.0,  // Perfect agreement with grammar
  "forward_passes_saved": 127,
  "forward_passes_total": 256
}
```

## Risks & Open Questions

1. **Sampler chain backend compatibility**: Does the llama.cpp sampler chain (specifically the `apply` callback) work identically across CPU, Metal, CUDA, and Vulkan? Or do some backends have custom logit-masking paths that bypass the chain? **Action**: Run the benchmark on 4+ hardware configurations to confirm.

2. **Prebuilt libllama vs. fork's libllama-common**: The AOSP plugin currently uses the prebuilt `libllama.so` from the Apothic fork. Does node-llama-cpp on desktop also use the same fork (with the sampler chain support)? Or does it bundle a different llama.cpp version? **Action**: Audit the desktop build pipeline to confirm all paths use the fork's post-b8198 sampler chain.

3. **JSON parse cost on hot path**: Deserializing the JSON descriptor on every `set_token_trie` call could add latency. Should we switch to a binary payload (struct-of-arrays or MessagePack) to avoid parse cost? **Answer for now**: Start with JSON (matches the existing wire format from TS); optimize to binary if benchmarks show >1ms overhead.

4. **Multithreading & cache safety**: If multiple sessions run concurrently (e.g., parallel speculative decoding), does the global trie cache lock cause contention? **Mitigation**: Use a thread-local or per-session cache instead of global static; accept per-session memory overhead (~2 MB per concurrent generation) as the price of lock-free access.

5. **Vocab mismatch detection**: The descriptor carries `modelId`, but the C++ sampler does not validate it against the currently-loaded model's id. If the user accidentally mixes tries from two different model checkpoints, the tokens will be silently wrong. **Mitigation**: The TS layer should validate `modelId` before calling `set_token_trie`; the C++ layer logs a warning if the payload looks inconsistent (e.g., token ids > vocab size).

6. **Span boundary detection**: The descriptor's `path` is informational. The sampler does not know when the span ends; it relies on the TS layer to call `clear_token_trie`. If the TS layer forgets, the trie will mask beyond the intended region. **Mitigation**: Add a per-descriptor timeout (e.g., reset after 500 tokens without an explicit `clear`) as a safety net; log warnings when the trie resets unexpectedly.

7. **Interaction with reasoning budget sampler**: The existing `rbudget` sampler suppresses certain tokens inside thinking blocks. Does the trie sampler run before or after `rbudget`? If `rbudget` masks a token that the trie also tried to mask, does the double-masking cause issues? **Answer**: Trie runs before `rbudget` in the chain, so `rbudget` sees a pre-filtered candidate set. This is correct; no interaction issue.

8. **Grammar lazy-init timing**: The fork supports lazy grammar initialization that doesn't fully parse the grammar until the first generation. Does the trie sampler interact with this? **Answer**: The trie is independent; lazy grammars are a separate concern. Trie is applied regardless of grammar mode.

## Header File

A draft C++ header is provided at:
```
plugins/plugin-local-inference/native/include/eliza_token_trie_sampler.h
```

This header declares:
- `llama_sampler * llama_sampler_init_token_trie(...)`
- Internal struct definitions for FFI bindings
- Helper functions for parsing and caching

The implementation will follow in a subsequent step.
