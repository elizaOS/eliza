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
 *   no localhost server. `AospDflashAdapter` prefers this shim when present
 *   (`libeliza-llama-speculative-shim.so` next to `libllama.so` in the AAR);
 *   path a stays the fallback. This file IS that C ABI.
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
 * BUILD: compiled with the NDK C++ toolchain into
 *   libeliza-llama-speculative-shim.so, linked against the per-ABI libllama.so
 *   that omnivoice-fuse / compile-libllama.mjs produces. See
 *   packages/app-core/scripts/aosp/compile-shim.mjs (the speculative-shim
 *   target — symmetry with the existing seccomp shim + pointer-shim).
 *
 *   Header dependency: needs the fork's `common/speculative.h`, `common/common.h`,
 *   and `llama.h` on the include path (the same checkout compile-libllama.mjs
 *   builds libllama from). On a host without that checkout the file is still
 *   syntactically complete; the build hook resolves the headers.
 *
 * llama.cpp pin: elizaOS/llama.cpp @ eliza/main (the unified fork with DFlash
 *   spec-decode + the eliza kernels). `common_params_speculative` field set
 *   tracked there; the setters below cover the subset the AOSP adapter
 *   overrides (n_draft / n_min / p_min / type / cache types / ctx size).
 */

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// The fork's C++ headers. (If your build environment doesn't have the fork
// checkout on the include path, set ELIZA_SHIM_HEADERLESS to compile a
// no-op stub that returns "unsupported" — used only for syntax/ABI checks on
// hosts without the source; the real Android build always has the headers.)
#if defined(ELIZA_SHIM_HEADERLESS)
typedef int32_t llama_token;
struct llama_context;
struct common_speculative;
#else
#include "llama.h"
#include "common.h"
#include "speculative.h"
#endif

// ---- the flat C ABI -------------------------------------------------------

extern "C" {

// Opaque handle the JS side carries around. Wraps the live common_speculative*
// plus a copy of the common_params_speculative the loop reuses (the C++ API
// wants the params by-ref on every draft() call).
struct eliza_speculative_handle;

// 1 when the speculative C++ symbols are linked into this .so. The build hook
// links them; a degenerate (ELIZA_SHIM_HEADERLESS) build returns 0 so the
// adapter cleanly falls back to path a.
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
    return common_speculative_is_compat(reinterpret_cast<llama_context *>(ctx_tgt)) ? 1 : 0;
#endif
}

// Initialize. `ctx_tgt` is the in-process target llama_context (from the
// pointer-shim's llama_init_from_model). `ctx_draft` is the drafter context.
// `spec_type_name` is the fork's spec-type token ("dflash", "lookahead",
// "ngram", ...). `n_draft` / `n_min` / `p_min` are the DFlash window knobs
// (0 / negative ⇒ keep the fork default). Returns the handle, or NULL on
// failure (caller falls back to path a).
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

} // extern "C"

// ---- implementation -------------------------------------------------------

#if !defined(ELIZA_SHIM_HEADERLESS)

struct eliza_speculative_handle {
    common_speculative *      spec   = nullptr;
    common_params_speculative params;        // reused on every draft() call
    llama_context *           ctx_draft = nullptr;
};

extern "C" struct eliza_speculative_handle * eliza_speculative_init(
        struct llama_context * ctx_tgt,
        struct llama_context * ctx_draft,
        const char *           spec_type_name,
        int                    n_draft,
        int                    n_min,
        float                  p_min) {
    if (!ctx_tgt) return nullptr;
    auto * h = new (std::nothrow) eliza_speculative_handle();
    if (!h) return nullptr;

    // Drafter context lives in common_params_speculative.cpu_params / etc. in
    // the fork; the helper takes the *target* ctx and reaches the drafter via
    // params. We stash the drafter handle so the JS side can free it, and set
    // the params the fork's common_speculative_init reads.
    h->ctx_draft = reinterpret_cast<llama_context *>(ctx_draft);
    if (spec_type_name && *spec_type_name) {
        h->params.type = common_speculative_type_from_name(std::string(spec_type_name));
    }
    if (n_draft > 0) h->params.n_max = n_draft;
    if (n_min   > 0) h->params.n_min = n_min;
    if (p_min   > 0.0f) h->params.p_min = p_min;

    h->spec = common_speculative_init(h->params, reinterpret_cast<llama_context *>(ctx_tgt));
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
    llama_tokens prompt(prompt_ids, prompt_ids + n_prompt);
    common_speculative_begin(h->spec, prompt);
}

extern "C" int32_t eliza_speculative_draft(struct eliza_speculative_handle * h,
                                           const int32_t * prompt_ids, int32_t n_prompt,
                                           int32_t id_last,
                                           int32_t * out_ids, int32_t out_cap) {
    if (!h || !h->spec || !prompt_ids || n_prompt <= 0 || !out_ids || out_cap <= 0) return 0;
    llama_tokens prompt(prompt_ids, prompt_ids + n_prompt);
    llama_tokens drafted = common_speculative_draft(h->spec, h->params, prompt,
                                                    static_cast<llama_token>(id_last));
    const int32_t n = static_cast<int32_t>(drafted.size());
    const int32_t copy = (n < out_cap) ? n : out_cap;
    for (int32_t i = 0; i < copy; ++i) out_ids[i] = static_cast<int32_t>(drafted[i]);
    return copy;
}

extern "C" void eliza_speculative_accept(struct eliza_speculative_handle * h, uint16_t n_accepted) {
    if (!h || !h->spec) return;
    common_speculative_accept(h->spec, n_accepted);
}

extern "C" void eliza_speculative_print_stats(const struct eliza_speculative_handle * h) {
    if (!h || !h->spec) return;
    common_speculative_print_stats(h->spec);
}

#else  // ELIZA_SHIM_HEADERLESS — syntax/ABI-only stub (no fork headers on path)

struct eliza_speculative_handle { int unused; };
extern "C" struct eliza_speculative_handle * eliza_speculative_init(
        struct llama_context *, struct llama_context *, const char *, int, int, float) { return nullptr; }
extern "C" void eliza_speculative_free(struct eliza_speculative_handle *) {}
extern "C" void eliza_speculative_begin(struct eliza_speculative_handle *, const int32_t *, int32_t) {}
extern "C" int32_t eliza_speculative_draft(struct eliza_speculative_handle *, const int32_t *, int32_t,
                                           int32_t, int32_t *, int32_t) { return 0; }
extern "C" void eliza_speculative_accept(struct eliza_speculative_handle *, uint16_t) {}
extern "C" void eliza_speculative_print_stats(const struct eliza_speculative_handle *) {}

#endif
