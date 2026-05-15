/*
 * silero-vad-cpp — ENOSYS stub for the model entry points.
 *
 * This translation unit satisfies the four "model" entry points of the
 * C ABI declared in `include/silero_vad/silero_vad.h`
 * (`silero_vad_open`, `silero_vad_reset_state`, `silero_vad_process`,
 * `silero_vad_close`) plus `silero_vad_active_backend`. Every entry
 * returns `-ENOSYS` and clears its out-parameters so callers cannot
 * accidentally read uninitialized memory while the real ggml-backed
 * port lands. The port plan in `AGENTS.md` describes the replacement
 * path.
 *
 * The state-management helpers in `silero_vad_state.c` and the linear
 * resampler in `silero_vad_resample.c` are *not* stubbed — they are
 * real, deterministic, pure-C utilities the rest of the runtime can
 * exercise today. Tests for both live in `test/`.
 */

#include "silero_vad/silero_vad.h"

#include <errno.h>
#include <stddef.h>

/*
 * Opaque session struct. The stub never produces an instance — the
 * stub `silero_vad_open` always returns `-ENOSYS` and writes NULL into
 * `*out` — but the type must be defined so `silero_vad_handle`
 * (a typedef'd pointer to it) is a complete pointer type at the call
 * site. The real implementation will replace this with the ggml graph,
 * scratch buffers, and per-session LSTM state container.
 */
struct silero_vad_session {
    int unused;
};

int silero_vad_open(const char *gguf_path, silero_vad_handle *out) {
    (void)gguf_path;
    if (out) {
        *out = NULL;
    }
    return -ENOSYS;
}

int silero_vad_reset_state(silero_vad_handle h) {
    (void)h;
    return -ENOSYS;
}

int silero_vad_process(silero_vad_handle h,
                       const float *pcm_16khz,
                       size_t n_samples,
                       float *speech_prob_out) {
    (void)h;
    (void)pcm_16khz;
    (void)n_samples;
    if (speech_prob_out) {
        *speech_prob_out = 0.0f;
    }
    return -ENOSYS;
}

int silero_vad_close(silero_vad_handle h) {
    /*
     * NULL-safe success per the header contract. A non-NULL handle
     * here means a caller invented a session out of thin air (the
     * stub `silero_vad_open` never returned one), so report it as
     * `-ENOSYS` to surface the misuse rather than silently absorbing
     * it.
     */
    if (h == NULL) {
        return 0;
    }
    return -ENOSYS;
}

const char *silero_vad_active_backend(void) {
    return "stub";
}
