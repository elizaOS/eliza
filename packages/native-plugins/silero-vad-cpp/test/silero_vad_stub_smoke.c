/*
 * Build-only smoke test for the silero-vad-cpp public ABI.
 *
 * Phase 1 named this "stub smoke" because every model entry point
 * returned `-ENOSYS`. Phase 2 wires the real runtime in
 * `src/silero_vad_runtime.c`; this test now confirms the public ABI
 * still links and that the runtime's *error paths* behave per the
 * header contract:
 *
 *   - `silero_vad_active_backend()` reports a non-NULL diagnostic
 *     string. The Phase 2 default is `"native-cpu"`.
 *   - `silero_vad_open(<missing>, &out)` returns `-ENOENT` and clears
 *     the out handle.
 *   - `silero_vad_open(NULL, ...)` and `silero_vad_open(path, NULL)`
 *     return `-EINVAL`.
 *   - `silero_vad_reset_state(NULL)` returns `-EINVAL`.
 *   - `silero_vad_process(NULL, ..., &prob)` returns `-EINVAL` and
 *     clears `*speech_prob_out`.
 *   - `silero_vad_close(NULL)` is a documented success.
 *
 * The behavioural correctness of the runtime (per-window probability
 * vs. silence / synthetic speech) is exercised by
 * `silero_vad_runtime_test.c`, which depends on a GGUF fixture and
 * runs separately.
 */

#include "silero_vad/silero_vad.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    const char *backend = silero_vad_active_backend();
    if (backend == NULL || backend[0] == '\0') {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_active_backend returned NULL/empty\n");
        ++failures;
    }

    /* `silero_vad_open` against a missing path: -ENOENT, out cleared. */
    silero_vad_handle handle = (silero_vad_handle)(uintptr_t)0x1; /* clobbered */
    int rc = silero_vad_open("/nonexistent.gguf", &handle);
    if (rc != -ENOENT) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open(missing) returned %d, expected %d\n",
                rc, -ENOENT);
        ++failures;
    }
    if (handle != NULL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open(missing) did not clear out handle\n");
        ++failures;
    }

    /* NULL path → -EINVAL. */
    handle = (silero_vad_handle)(uintptr_t)0x1;
    rc = silero_vad_open(NULL, &handle);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open(NULL path) returned %d, expected %d\n",
                rc, -EINVAL);
        ++failures;
    }
    if (handle != NULL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open(NULL path) did not clear out handle\n");
        ++failures;
    }

    /* NULL out → -EINVAL. */
    rc = silero_vad_open("/nonexistent.gguf", NULL);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open(NULL out) returned %d, expected %d\n",
                rc, -EINVAL);
        ++failures;
    }

    /* `silero_vad_reset_state(NULL)` → -EINVAL. */
    rc = silero_vad_reset_state(NULL);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_reset_state(NULL) returned %d, expected %d\n",
                rc, -EINVAL);
        ++failures;
    }

    /* `silero_vad_process(NULL, ...)` → -EINVAL, prob cleared. */
    float window[SILERO_VAD_WINDOW_SAMPLES_16K] = {0.0f};
    float prob = 0.5f;
    rc = silero_vad_process(NULL, window, SILERO_VAD_WINDOW_SAMPLES_16K, &prob);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_process(NULL) returned %d, expected %d\n",
                rc, -EINVAL);
        ++failures;
    }
    if (prob != 0.0f) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_process(NULL) did not clear prob (%f)\n",
                (double)prob);
        ++failures;
    }

    /* `silero_vad_close(NULL)` is a documented success. */
    rc = silero_vad_close(NULL);
    if (rc != 0) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_close(NULL) returned %d, expected 0\n",
                rc);
        ++failures;
    }

    printf("[silero-vad-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
