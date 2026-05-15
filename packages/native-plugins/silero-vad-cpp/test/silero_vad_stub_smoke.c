/*
 * Build-only smoke test for the silero-vad-cpp ENOSYS stub.
 *
 * Confirms the public C ABI declared in
 * `include/silero_vad/silero_vad.h` links and that every model entry
 * point reports the expected `-ENOSYS`. This is intentionally not a
 * behavioural test — once the real ggml-backed implementation lands,
 * the parity / quality tests will live next to it and this smoke test
 * stays as a "the ABI still compiles" guard.
 *
 * The resampler and state-management TUs have their own dedicated
 * tests (`silero_vad_resample_test.c`, `silero_vad_state_test.c`) and
 * are *not* exercised here — they are real implementations and would
 * not return `-ENOSYS`.
 */

#include "silero_vad/silero_vad.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(silero_vad_active_backend(), "stub") != 0) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] unexpected backend: %s\n",
                silero_vad_active_backend());
        ++failures;
    }

    /* `silero_vad_open` must return -ENOSYS and clear the out handle. */
    silero_vad_handle handle = (silero_vad_handle)(uintptr_t)0x1; /* clobbered */
    int rc = silero_vad_open("/nonexistent.gguf", &handle);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (handle != NULL) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_open did not clear out handle\n");
        ++failures;
    }

    /* `silero_vad_reset_state` must return -ENOSYS for any handle. */
    rc = silero_vad_reset_state(NULL);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_reset_state returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }

    /* `silero_vad_process` must return -ENOSYS and clear the prob out. */
    float window[SILERO_VAD_WINDOW_SAMPLES_16K] = {0.0f};
    float prob = 0.5f;
    rc = silero_vad_process(NULL, window, SILERO_VAD_WINDOW_SAMPLES_16K, &prob);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_process returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (prob != 0.0f) {
        fprintf(stderr,
                "[silero-vad-stub-smoke] silero_vad_process did not clear prob (%f)\n",
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
