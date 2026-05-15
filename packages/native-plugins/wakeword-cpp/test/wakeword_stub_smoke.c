/*
 * Build-only smoke test for the wakeword-cpp ENOSYS stub.
 *
 * Confirms the C ABI declared in `include/wakeword/wakeword.h` links
 * and that every public entry point reports the expected `-ENOSYS`.
 * This is intentionally not a behavioural test — once the real
 * ggml-backed three-stage pipeline lands, the parity / quality tests
 * will live next to it and this smoke test stays as a "the ABI still
 * compiles" guard, mirroring `doctr_stub_smoke.c`.
 */

#include "wakeword/wakeword.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(wakeword_active_backend(), "stub") != 0) {
        fprintf(stderr, "[wakeword-stub-smoke] unexpected backend: %s\n",
                wakeword_active_backend());
        ++failures;
    }

    wakeword_handle h = (wakeword_handle)0x1; /* clobbered by wakeword_open */
    int rc = wakeword_open("/nonexistent.melspec.gguf",
                           "/nonexistent.embedding.gguf",
                           "/nonexistent.classifier.gguf",
                           &h);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (h != NULL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open did not clear out handle\n");
        ++failures;
    }

    float score = 99.0f;
    rc = wakeword_process(NULL, NULL, 0, &score);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_process returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (score != 0.0f) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_process did not zero score (%f)\n",
                (double)score);
        ++failures;
    }

    rc = wakeword_set_threshold(NULL, 0.5f);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_set_threshold returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }

    rc = wakeword_close(NULL);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_close returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }

    printf("[wakeword-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
