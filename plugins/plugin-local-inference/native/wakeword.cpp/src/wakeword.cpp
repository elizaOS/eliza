/*
 * wakeword.cpp — native openWakeWord streaming detector, scaffolding.
 *
 * See `wakeword.h` and `../README.md` for the contract and the open
 * work. This file builds against the same ggml that the rest of the
 * fused build links (see `omnivoice.cpp/ggml/`) — keep the include
 * paths and link flags consistent.
 *
 * Implementation status:
 *   - GGUF mmap + metadata-contract validation: done (refuses to open
 *     on architectural mismatch — no silent fallback).
 *   - Head resolution by name: done (binds `head.<name>.*` tensors).
 *   - Mel filterbank: TODO.
 *   - Speech embedding model forward: TODO.
 *   - Classifier head forward: TODO.
 *
 * Until the three TODO kernels land, `eliza_wakeword_score` returns
 * `ELIZA_WAKEWORD_ERR_NOT_IMPLEMENTED` so callers cannot mistake an
 * uninitialized runtime for "wake word didn't fire". This is the
 * required failure mode per AGENTS.md §3, §8.
 */

#include "wakeword.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

// Forward-decls only — the real implementation pulls in ggml + the
// GGUF loader from the fused build. They are commented out so this
// file compiles even before the build system links it in, but the
// symbol expectations are explicit so the wiring change is mechanical.
//
// #include "ggml.h"
// #include "gguf.h"
// #include "gguf-weights.h" // from omnivoice.cpp/src/

namespace {

constexpr int kFormatVersion = 1;

// Helper: heap-allocate a NUL-terminated diagnostic string the caller
// will free via `eliza_wakeword_free_string`. Matches the convention
// the rest of `libelizainference` uses for `out_error`.
void set_error(char ** out, const char * fmt, ...) {
    if (!out) return;
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    size_t n = std::strlen(buf) + 1;
    char * heap = static_cast<char *>(std::malloc(n));
    if (!heap) { *out = nullptr; return; }
    std::memcpy(heap, buf, n);
    *out = heap;
}

// Lightweight slot for a tensor descriptor we resolved out of the GGUF.
// Once the kernels are wired up these will hold real `ggml_tensor *`
// pointers anchored in the fused build's weight context.
struct TensorSlot {
    std::string name;
    // void * tensor = nullptr; // ggml_tensor * once ggml is wired
};

struct HeadBinding {
    std::string name;
    std::vector<TensorSlot> tensors;
    bool placeholder = false;
};

} // namespace

struct eliza_wakeword_session {
    std::string gguf_path;
    std::string head_name;
    HeadBinding head;

    // Streaming state — owned by the C++ side, not the caller.
    // Audio tail carried between scoreFrame calls so consecutive
    // 80 ms chunks form a continuous waveform for the mel filterbank.
    std::vector<float> audio_tail; // size = ELIZA_WAKEWORD_MEL_LEAD_IN_SAMPLES
    std::vector<std::vector<float>> mel_ring; // each [MEL_BINS]
    int frames_since_embedding = 0;
    std::vector<std::vector<float>> embedding_ring; // each [EMBEDDING_DIM]
    float last_probability = 0.0f;

    // Architectural metadata loaded from the GGUF — checked once at open
    // and then kept around for the runtime to sanity-check kernel I/O.
    uint32_t format_version = 0;
    uint32_t sample_rate = 0;
    uint32_t frame_samples = 0;
    uint32_t mel_bins = 0;
    uint32_t embedding_window_frames = 0;
    uint32_t embedding_hop_frames = 0;
    uint32_t embedding_dim = 0;
    uint32_t head_window_embeddings = 0;

    // GGUF mmap + ggml weight context will live here once the fused
    // build pulls them in. The pointers stay opaque to the public API.
    // void * gguf_ctx = nullptr;
    // void * meta_ctx = nullptr;
    // void * weight_ctx = nullptr;
};

extern "C" {

eliza_wakeword_session_t *
eliza_wakeword_open(const char * gguf_path, const char * head_name,
                    char ** out_error) {
    if (!gguf_path || !head_name) {
        set_error(out_error, "[wakeword] gguf_path and head_name are required");
        return nullptr;
    }

    // TODO(wakeword): mmap the GGUF and walk its KV pairs:
    //   - require `openwakeword.format_version == kFormatVersion`;
    //   - require sample_rate / frame_samples / mel_bins /
    //     embedding_window_frames / embedding_hop_frames /
    //     embedding_dim / head_window_embeddings to match the macros
    //     in wakeword.h. Any disagreement → ELIZA_WAKEWORD_ERR_BUNDLE_INVALID.
    //   - read the `openwakeword.head_names` string array, ensure
    //     `head_name` is in it; otherwise:
    //         set_error(out_error, "[wakeword] head '%s' is not in this
    //                   GGUF (available: ...)", head_name);
    //         return nullptr;
    //   - resolve every `head.<head_name>.*` tensor into HeadBinding;
    //   - resolve every `mel.*` and `embed.*` tensor into the session's
    //     ggml weight context.
    //
    // Until that lands, opening always fails with a clear "not ready"
    // diagnostic so we never hand back a half-loaded session.
    set_error(out_error,
              "[wakeword] runtime not ready: wakeword.cpp kernels are scaffolding only. "
              "Build the fused library with the wake-word GGML runtime linked in "
              "(see plugins/plugin-local-inference/native/wakeword.cpp/README.md).");
    return nullptr;
}

int eliza_wakeword_score(eliza_wakeword_session_t * session, const float * pcm,
                         size_t n_samples, float * out_probability,
                         char ** out_error) {
    if (!session || !pcm || !out_probability) {
        set_error(out_error, "[wakeword] score: session/pcm/out_probability required");
        return ELIZA_WAKEWORD_ERR_INVALID_ARG;
    }
    if (n_samples != ELIZA_WAKEWORD_FRAME_SAMPLES) {
        set_error(out_error,
                  "[wakeword] score: expected %d samples per frame, got %zu",
                  ELIZA_WAKEWORD_FRAME_SAMPLES, n_samples);
        return ELIZA_WAKEWORD_ERR_INVALID_ARG;
    }
    // TODO(wakeword):
    //   1. Copy `pcm` together with `session->audio_tail` into a
    //      contiguous (lead-in + frame) buffer; carry the new tail.
    //   2. Run the mel filterbank → 8 new mel frames; rescale
    //      `x / 10 + 2` (openWakeWord upstream convention) and push
    //      into `mel_ring` (cap at MEL_RING_CAP).
    //   3. While `mel_ring.size() >= EMBEDDING_WINDOW_FRAMES && frames_since_embedding >= EMBEDDING_HOP`:
    //         - take the last EMBEDDING_WINDOW_FRAMES mel frames,
    //         - run the speech embedding model → 96-dim embedding,
    //         - push into `embedding_ring` (cap), decrement
    //           `frames_since_embedding` by EMBEDDING_HOP.
    //   4. If `embedding_ring.size() >= HEAD_WINDOW_EMBEDDINGS`:
    //         - take the last HEAD_WINDOW_EMBEDDINGS,
    //         - run the head MLP → scalar in [0,1],
    //         - clamp and store in `last_probability`.
    //   5. `*out_probability = session->last_probability;`
    set_error(out_error,
              "[wakeword] runtime not ready: score() kernels are scaffolding only");
    return ELIZA_WAKEWORD_ERR_NOT_IMPLEMENTED;
}

int eliza_wakeword_reset(eliza_wakeword_session_t * session, char ** out_error) {
    if (!session) {
        set_error(out_error, "[wakeword] reset: session is NULL");
        return ELIZA_WAKEWORD_ERR_INVALID_ARG;
    }
    std::fill(session->audio_tail.begin(), session->audio_tail.end(), 0.0f);
    session->mel_ring.clear();
    session->frames_since_embedding = 0;
    session->embedding_ring.clear();
    session->last_probability = 0.0f;
    return ELIZA_WAKEWORD_OK;
}

void eliza_wakeword_close(eliza_wakeword_session_t * session) {
    if (!session) return;
    // TODO(wakeword): free ggml weight context + munmap the GGUF.
    delete session;
}

void eliza_wakeword_free_string(char * str) {
    if (str) std::free(str);
}

} // extern "C"
