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

// ─── token-tree sampler ──────────────────────────────────────────────────────
//
// Wire format (mirrors packages/native-plugins/llama/src/token-tree-codec.ts):
//   u32  magic       = 0x544B5452 ("RTKT", little-endian)
//   u32  version     = 1
//   u32  path_len    (utf-8 byte count; not consumed by the sampler itself,
//                     the descriptor `path` is debug/routing metadata only)
//   ...  path        (utf-8 bytes, no trailing NUL)
//   u32  total_nodes
//   per node (DFS pre-order; node 0 is the synthetic root, token_id = -1):
//     i32  token_id
//     u8   terminal
//     u32  num_children
//     u32  child_ptrs[num_children]   (indices into the same node array;
//                                       invariant: ptr > self_index)
//
// Semantics: at each `apply`, restrict the logits to the set of valid next
// tokens reachable from the current trie position. On `accept`, descend to
// the child whose token_id matches the chosen token. When the descent hits
// a node with no further children (a "terminal leaf" — either flagged
// `terminal=1` or simply childless), reset to the root so the next
// generation step is unconstrained.

typedef struct trie_node {
    int32_t  token_id;
    uint8_t  terminal;
    uint32_t num_children;
    uint32_t * child_indices;
} trie_node_t;

typedef struct token_tree {
    trie_node_t * nodes;
    uint32_t      node_count;
    int32_t       current_index;  // 0 = root; -1 = sentinel "no constraint"
} token_tree_t;

static void token_tree_free_data(token_tree_t * tree) {
    if (!tree) return;
    if (tree->nodes) {
        for (uint32_t i = 0; i < tree->node_count; i++) {
            free(tree->nodes[i].child_indices);
        }
        free(tree->nodes);
    }
    free(tree);
}

// Parse the flat wire format into an allocated `token_tree_t`. Returns NULL
// on any parse error (bad magic, unsupported version, truncated buffer, or
// child pointer violating the forward-only invariant).
static token_tree_t * parse_token_tree(const uint8_t * bytes, size_t size) {
    if (!bytes || size < 16) return NULL;
    size_t off = 0;

    uint32_t magic;
    memcpy(&magic, bytes + off, 4); off += 4;
    if (magic != 0x544B5452u) return NULL;

    uint32_t version;
    memcpy(&version, bytes + off, 4); off += 4;
    if (version != 1u) return NULL;

    uint32_t path_len;
    memcpy(&path_len, bytes + off, 4); off += 4;
    if (off + path_len + 4 > size) return NULL;
    off += path_len;  // path bytes are not used by the sampler

    uint32_t node_count;
    memcpy(&node_count, bytes + off, 4); off += 4;
    if (node_count == 0) return NULL;

    token_tree_t * tree = (token_tree_t *)calloc(1, sizeof(*tree));
    if (!tree) return NULL;
    tree->node_count = node_count;
    tree->current_index = 0;
    tree->nodes = (trie_node_t *)calloc(node_count, sizeof(*tree->nodes));
    if (!tree->nodes) { free(tree); return NULL; }

    for (uint32_t i = 0; i < node_count; i++) {
        if (off + 9 > size) { token_tree_free_data(tree); return NULL; }
        int32_t token_id;
        memcpy(&token_id, bytes + off, 4); off += 4;
        uint8_t terminal = bytes[off]; off += 1;
        uint32_t num_children;
        memcpy(&num_children, bytes + off, 4); off += 4;
        if (off + (size_t)num_children * 4 > size) {
            token_tree_free_data(tree); return NULL;
        }
        tree->nodes[i].token_id = token_id;
        tree->nodes[i].terminal = terminal;
        tree->nodes[i].num_children = num_children;
        if (num_children > 0) {
            tree->nodes[i].child_indices =
                (uint32_t *)malloc(sizeof(uint32_t) * num_children);
            if (!tree->nodes[i].child_indices) {
                token_tree_free_data(tree); return NULL;
            }
            for (uint32_t c = 0; c < num_children; c++) {
                uint32_t ptr;
                memcpy(&ptr, bytes + off, 4); off += 4;
                if (ptr <= i || ptr >= node_count) {
                    token_tree_free_data(tree); return NULL;
                }
                tree->nodes[i].child_indices[c] = ptr;
            }
        } else {
            tree->nodes[i].child_indices = NULL;
        }
    }

    // Node 0 must be the synthetic root with sentinel token_id -1.
    if (tree->nodes[0].token_id != -1) {
        token_tree_free_data(tree); return NULL;
    }

    return tree;
}

typedef struct token_tree_sampler_ctx {
    token_tree_t * tree;
    // Snapshot of the magic+version+payload bytes so `.clone` can reparse.
    uint8_t * raw_bytes;
    size_t    raw_size;
} token_tree_sampler_ctx_t;

static const char * token_tree_sampler_name(const struct llama_sampler * smpl) {
    (void)smpl;
    return "eliza-token-tree";
}

// Returns 1 if `child_index` is a child of the node at `current_index`,
// 0 otherwise. The synthetic root (index 0, token_id -1) is the implicit
// starting position.
static int trie_child_for_token(
    const token_tree_t * tree, int32_t current_index, llama_token tok,
    uint32_t * out_child_index)
{
    if (current_index < 0 || (uint32_t)current_index >= tree->node_count) return 0;
    const trie_node_t * node = &tree->nodes[current_index];
    for (uint32_t i = 0; i < node->num_children; i++) {
        uint32_t ci = node->child_indices[i];
        if (ci >= tree->node_count) continue;
        if (tree->nodes[ci].token_id == tok) {
            if (out_child_index) *out_child_index = ci;
            return 1;
        }
    }
    return 0;
}

static void token_tree_sampler_apply(
    struct llama_sampler * smpl, llama_token_data_array * cur_p)
{
    token_tree_sampler_ctx_t * ctx = (token_tree_sampler_ctx_t *)smpl->ctx;
    if (!ctx || !ctx->tree || !cur_p || !cur_p->data) return;
    token_tree_t * tree = ctx->tree;
    // current_index = -1 means "no constraint" (we already ran past a leaf).
    if (tree->current_index < 0) return;
    if ((uint32_t)tree->current_index >= tree->node_count) return;
    const trie_node_t * node = &tree->nodes[tree->current_index];
    if (node->num_children == 0) {
        // No further constraint to apply; let downstream samplers decide.
        return;
    }

    // Build a small set of allowed token ids. node->num_children is typically
    // small (a handful of action names), so a linear scan per logit is fine.
    // For very large fan-outs callers should split into multiple stages.
    for (size_t i = 0; i < cur_p->size; i++) {
        llama_token tid = cur_p->data[i].id;
        int allowed = 0;
        for (uint32_t c = 0; c < node->num_children; c++) {
            uint32_t ci = node->child_indices[c];
            if (ci < tree->node_count && tree->nodes[ci].token_id == tid) {
                allowed = 1;
                break;
            }
        }
        if (!allowed) {
            cur_p->data[i].logit = -INFINITY;
        }
    }
    // Mark unsorted — we mutated logits, downstream must re-sort if needed.
    cur_p->sorted = false;
}

static void token_tree_sampler_accept(
    struct llama_sampler * smpl, llama_token token)
{
    token_tree_sampler_ctx_t * ctx = (token_tree_sampler_ctx_t *)smpl->ctx;
    if (!ctx || !ctx->tree) return;
    token_tree_t * tree = ctx->tree;
    if (tree->current_index < 0) return;
    uint32_t next;
    if (trie_child_for_token(tree, tree->current_index, token, &next)) {
        const trie_node_t * child = &tree->nodes[next];
        if (child->num_children == 0) {
            // Reached a leaf — release the constraint. Callers wanting a
            // hard stop should also attach a stop-token sampler.
            tree->current_index = -1;
        } else {
            tree->current_index = (int32_t)next;
        }
    } else {
        // Token did not match any valid child — apply() should have prevented
        // this, but be defensive: release the constraint rather than wedge.
        tree->current_index = -1;
    }
}

static void token_tree_sampler_reset(struct llama_sampler * smpl) {
    token_tree_sampler_ctx_t * ctx = (token_tree_sampler_ctx_t *)smpl->ctx;
    if (!ctx || !ctx->tree) return;
    ctx->tree->current_index = 0;
}

static struct llama_sampler * token_tree_sampler_clone(
    const struct llama_sampler * smpl)
{
    const token_tree_sampler_ctx_t * src =
        (const token_tree_sampler_ctx_t *)smpl->ctx;
    if (!src || !src->raw_bytes) return NULL;
    return (struct llama_sampler *)eliza_llama_sampler_init_token_tree(
        src->raw_bytes, src->raw_size);
}

static void token_tree_sampler_free(struct llama_sampler * smpl) {
    if (!smpl) return;
    token_tree_sampler_ctx_t * ctx = (token_tree_sampler_ctx_t *)smpl->ctx;
    if (ctx) {
        token_tree_free_data(ctx->tree);
        free(ctx->raw_bytes);
        free(ctx);
    }
    // The `llama_sampler` shell itself is freed by llama.cpp's
    // llama_sampler_free dispatcher (it was allocated by llama_sampler_init).
}

static struct llama_sampler_i token_tree_sampler_i = {
    /* .name              = */ token_tree_sampler_name,
    /* .accept            = */ token_tree_sampler_accept,
    /* .apply             = */ token_tree_sampler_apply,
    /* .reset             = */ token_tree_sampler_reset,
    /* .clone             = */ token_tree_sampler_clone,
    /* .free              = */ token_tree_sampler_free,
    /* .backend_init      = */ NULL,
    /* .backend_accept    = */ NULL,
    /* .backend_apply     = */ NULL,
    /* .backend_set_input = */ NULL,
};

void* eliza_llama_sampler_init_token_tree(const uint8_t* trie_bytes, size_t trie_size) {
    if (!trie_bytes || trie_size == 0) return NULL;
    token_tree_t * tree = parse_token_tree(trie_bytes, trie_size);
    if (!tree) return NULL;

    token_tree_sampler_ctx_t * ctx =
        (token_tree_sampler_ctx_t *)calloc(1, sizeof(*ctx));
    if (!ctx) { token_tree_free_data(tree); return NULL; }
    ctx->tree = tree;
    ctx->raw_size = trie_size;
    ctx->raw_bytes = (uint8_t *)malloc(trie_size);
    if (!ctx->raw_bytes) {
        token_tree_free_data(tree); free(ctx); return NULL;
    }
    memcpy(ctx->raw_bytes, trie_bytes, trie_size);

    return llama_sampler_init(&token_tree_sampler_i, ctx);
}

// ─── prefill-plan sampler ────────────────────────────────────────────────────
//
// The TS-side `PrefillPlan { prefix, runs }` shape is text-based and depends
// on the model's tokenizer. Tokenization is the caller's responsibility;
// the C side consumes a pre-tokenized, position-keyed plan.
//
// Wire format:
//   u32  magic     = 0x50465054 ("PFPT", little-endian)
//   u32  version   = 1
//   u32  entry_count
//   per entry:
//     u8   is_free      (0 = forced literal, 1 = free sample)
//     i32  token_id     (only meaningful when is_free == 0; ignored otherwise)
//
// Semantics: the sampler tracks an integer cursor `pos`. On each `apply`,
// if `entries[pos].is_free == 1` (or `pos >= entry_count`), the sampler is
// a no-op. Otherwise it sets every logit other than `entries[pos].token_id`
// to -INFINITY and the chosen one to +INFINITY (this beats any downstream
// temperature/top-k stage). `accept` advances the cursor by one.

typedef struct prefill_entry {
    uint8_t  is_free;
    int32_t  token_id;
} prefill_entry_t;

typedef struct prefill_plan_state {
    prefill_entry_t * entries;
    uint32_t          entry_count;
    uint32_t          cursor;
    uint8_t *         raw_bytes;
    size_t            raw_size;
} prefill_plan_state_t;

static void prefill_plan_free_state(prefill_plan_state_t * s) {
    if (!s) return;
    free(s->entries);
    free(s->raw_bytes);
    free(s);
}

static prefill_plan_state_t * parse_prefill_plan(const uint8_t * bytes, size_t size) {
    if (!bytes || size < 12) return NULL;
    size_t off = 0;
    uint32_t magic;
    memcpy(&magic, bytes + off, 4); off += 4;
    if (magic != 0x50465054u) return NULL;
    uint32_t version;
    memcpy(&version, bytes + off, 4); off += 4;
    if (version != 1u) return NULL;
    uint32_t count;
    memcpy(&count, bytes + off, 4); off += 4;
    // Each entry is 5 bytes (u8 + i32).
    if (off + (size_t)count * 5 > size) return NULL;

    prefill_plan_state_t * s =
        (prefill_plan_state_t *)calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->entry_count = count;
    s->cursor = 0;
    if (count > 0) {
        s->entries = (prefill_entry_t *)calloc(count, sizeof(*s->entries));
        if (!s->entries) { free(s); return NULL; }
        for (uint32_t i = 0; i < count; i++) {
            s->entries[i].is_free = bytes[off]; off += 1;
            int32_t tid;
            memcpy(&tid, bytes + off, 4); off += 4;
            s->entries[i].token_id = tid;
        }
    }
    return s;
}

static const char * prefill_plan_sampler_name(const struct llama_sampler * smpl) {
    (void)smpl;
    return "eliza-prefill-plan";
}

static void prefill_plan_sampler_apply(
    struct llama_sampler * smpl, llama_token_data_array * cur_p)
{
    prefill_plan_state_t * s = (prefill_plan_state_t *)smpl->ctx;
    if (!s || !cur_p || !cur_p->data) return;
    if (s->cursor >= s->entry_count) return;
    const prefill_entry_t * e = &s->entries[s->cursor];
    if (e->is_free) return;
    int32_t forced = e->token_id;
    for (size_t i = 0; i < cur_p->size; i++) {
        if (cur_p->data[i].id == forced) {
            cur_p->data[i].logit = INFINITY;
        } else {
            cur_p->data[i].logit = -INFINITY;
        }
    }
    cur_p->sorted = false;
}

static void prefill_plan_sampler_accept(
    struct llama_sampler * smpl, llama_token token)
{
    (void)token;
    prefill_plan_state_t * s = (prefill_plan_state_t *)smpl->ctx;
    if (!s) return;
    if (s->cursor < s->entry_count) s->cursor++;
}

static void prefill_plan_sampler_reset(struct llama_sampler * smpl) {
    prefill_plan_state_t * s = (prefill_plan_state_t *)smpl->ctx;
    if (!s) return;
    s->cursor = 0;
}

static struct llama_sampler * prefill_plan_sampler_clone(
    const struct llama_sampler * smpl)
{
    const prefill_plan_state_t * src = (const prefill_plan_state_t *)smpl->ctx;
    if (!src || !src->raw_bytes) return NULL;
    return (struct llama_sampler *)eliza_llama_sampler_init_prefill_plan(
        src->raw_bytes, src->raw_size);
}

static void prefill_plan_sampler_free(struct llama_sampler * smpl) {
    if (!smpl) return;
    prefill_plan_state_t * s = (prefill_plan_state_t *)smpl->ctx;
    prefill_plan_free_state(s);
}

static struct llama_sampler_i prefill_plan_sampler_i = {
    /* .name              = */ prefill_plan_sampler_name,
    /* .accept            = */ prefill_plan_sampler_accept,
    /* .apply             = */ prefill_plan_sampler_apply,
    /* .reset             = */ prefill_plan_sampler_reset,
    /* .clone             = */ prefill_plan_sampler_clone,
    /* .free              = */ prefill_plan_sampler_free,
    /* .backend_init      = */ NULL,
    /* .backend_accept    = */ NULL,
    /* .backend_apply     = */ NULL,
    /* .backend_set_input = */ NULL,
};

void* eliza_llama_sampler_init_prefill_plan(const uint8_t* plan_bytes, size_t plan_size) {
    if (!plan_bytes || plan_size == 0) return NULL;
    prefill_plan_state_t * s = parse_prefill_plan(plan_bytes, plan_size);
    if (!s) return NULL;
    s->raw_size = plan_size;
    s->raw_bytes = (uint8_t *)malloc(plan_size);
    if (!s->raw_bytes) { prefill_plan_free_state(s); return NULL; }
    memcpy(s->raw_bytes, plan_bytes, plan_size);
    return llama_sampler_init(&prefill_plan_sampler_i, s);
}
