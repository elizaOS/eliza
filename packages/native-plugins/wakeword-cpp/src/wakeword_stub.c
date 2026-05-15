/*
 * wakeword-cpp — ENOSYS stub.
 *
 * Satisfies the C ABI declared in `include/wakeword/wakeword.h` so
 * callers (the bun:ffi binding in
 * plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts,
 * the smoke test in test/wakeword_stub_smoke.c) link cleanly while the
 * real ggml-backed three-stage pipeline lands. Every entry point
 * returns `-ENOSYS`. The port plan in `AGENTS.md` describes the
 * replacement path.
 *
 * NOTE: the real, non-stub melspectrogram + sliding window TUs
 * (`wakeword_melspec.c`, `wakeword_window.c`) are linked alongside
 * this stub and tested in isolation; their entry points are not part
 * of the public ABI yet because the ggml-backed embedding/classifier
 * stages are not wired. The stub here covers only the *public*
 * `wakeword_*` surface.
 */

#include "wakeword/wakeword.h"

#include <errno.h>
#include <stddef.h>

struct wakeword_session {
    int unused;
};

int wakeword_open(const char *melspec_gguf,
                  const char *embedding_gguf,
                  const char *classifier_gguf,
                  wakeword_handle *out) {
    (void)melspec_gguf;
    (void)embedding_gguf;
    (void)classifier_gguf;
    if (out) *out = NULL;
    return -ENOSYS;
}

int wakeword_close(wakeword_handle h) {
    (void)h;
    return -ENOSYS;
}

int wakeword_process(wakeword_handle h,
                     const float *pcm_16khz,
                     size_t n_samples,
                     float *score_out) {
    (void)h;
    (void)pcm_16khz;
    (void)n_samples;
    if (score_out) *score_out = 0.0f;
    return -ENOSYS;
}

int wakeword_set_threshold(wakeword_handle h, float threshold) {
    (void)h;
    (void)threshold;
    return -ENOSYS;
}

const char *wakeword_active_backend(void) {
    return "stub";
}
