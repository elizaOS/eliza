// whisper-eliza-adapter — flat C ABI on top of whisper.cpp.
//
// Implementation notes:
// - Greedy sampling, no timestamp filtering — Eliza's `OpenVinoStreamingTranscriber`
//   layer already drives a sliding-window strategy on top of this.
// - Threads default to half the host CPU count when n_threads <= 0 (the
//   upstream whisper.cpp default of 4 is too low for modern laptops).
// - The session holds a `whisper_context *` plus per-decode params we want to
//   keep stable across calls (n_threads, use_gpu); the language / translate
//   knobs come in per-call so a caller can flip them without re-opening.

#include "whisper_eliza_adapter.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

#include "whisper.h"

struct whisper_eliza_session {
    whisper_context * ctx       = nullptr;
    int               n_threads = 0;
    bool              use_gpu   = false;
    // whisper.cpp is not internally serialised across decode calls on the
    // same context — guard with a mutex so concurrent transcribe() calls
    // from the JS side cannot trample each other.
    std::mutex        mu;
};

extern "C" int whisper_eliza_abi_version(void) {
    return WHISPER_ELIZA_ADAPTER_ABI_VERSION;
}

extern "C" whisper_eliza_session_t * whisper_eliza_open(
    const char * gguf_path,
    int          n_threads,
    int          use_gpu)
{
    if (gguf_path == nullptr || gguf_path[0] == '\0') {
        return nullptr;
    }

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = use_gpu != 0;

    whisper_context * ctx = whisper_init_from_file_with_params(gguf_path, cparams);
    if (ctx == nullptr) {
        return nullptr;
    }

    int threads = n_threads;
    if (threads <= 0) {
        threads = std::max(1u, std::thread::hardware_concurrency() / 2u);
    }

    auto * session       = new (std::nothrow) whisper_eliza_session();
    if (session == nullptr) {
        whisper_free(ctx);
        return nullptr;
    }
    session->ctx       = ctx;
    session->n_threads = threads;
    session->use_gpu   = use_gpu != 0;
    return session;
}

extern "C" int whisper_eliza_transcribe(
    whisper_eliza_session_t * session,
    const float *             pcm16k,
    size_t                    n_samples,
    const char *              language,
    int                       translate,
    char *                    out_text,
    size_t                    out_text_size,
    size_t *                  out_written)
{
    if (session == nullptr || session->ctx == nullptr) {
        return WEA_ERR_INVALID_ARG;
    }
    if (out_written == nullptr) {
        return WEA_ERR_INVALID_ARG;
    }
    if (n_samples > 0 && pcm16k == nullptr) {
        return WEA_ERR_INVALID_ARG;
    }

    std::lock_guard<std::mutex> lock(session->mu);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads          = session->n_threads;
    params.translate          = translate != 0;
    params.no_context         = true;
    params.single_segment     = false;
    params.print_special      = false;
    params.print_progress     = false;
    params.print_realtime     = false;
    params.print_timestamps   = false;
    params.suppress_blank     = true;
    if (language != nullptr && language[0] != '\0') {
        params.language = language;
    } else {
        params.language = "en";
    }

    // n_samples=0 is a valid no-op: an empty window decode returns "".
    if (n_samples == 0) {
        if (out_text != nullptr && out_text_size >= 1) {
            out_text[0] = '\0';
        }
        *out_written = 0;
        return WEA_OK;
    }

    const int n_int = static_cast<int>(n_samples);
    if (n_int < 0 || static_cast<size_t>(n_int) != n_samples) {
        return WEA_ERR_INVALID_ARG;
    }

    int rc = whisper_full(session->ctx, params, pcm16k, n_int);
    if (rc != 0) {
        return WEA_ERR_DECODE_FAILED;
    }

    std::string joined;
    const int n_segments = whisper_full_n_segments(session->ctx);
    for (int i = 0; i < n_segments; ++i) {
        const char * seg = whisper_full_get_segment_text(session->ctx, i);
        if (seg == nullptr) continue;
        // whisper.cpp prepends a leading space on most segments; trim only
        // the very first to keep inter-segment spacing intact.
        if (joined.empty()) {
            while (*seg == ' ') ++seg;
        }
        joined.append(seg);
    }

    *out_written = joined.size();
    if (out_text == nullptr || out_text_size == 0) {
        return WEA_ERR_BUFFER_TOO_SMALL;
    }
    if (joined.size() + 1 > out_text_size) {
        return WEA_ERR_BUFFER_TOO_SMALL;
    }
    std::memcpy(out_text, joined.data(), joined.size());
    out_text[joined.size()] = '\0';
    return WEA_OK;
}

extern "C" void whisper_eliza_close(whisper_eliza_session_t * session) {
    if (session == nullptr) return;
    if (session->ctx != nullptr) {
        whisper_free(session->ctx);
        session->ctx = nullptr;
    }
    delete session;
}
