/*
 * Build-only smoke test for the wakeword-cpp public ABI.
 *
 * The library is now backed by the real runtime
 * (`src/wakeword_runtime.c`); this test checks that the entry points
 * still link and that the obvious error contracts hold:
 *
 *   - wakeword_active_backend() returns "native-cpu" (no longer "stub").
 *   - wakeword_open with NULL paths returns -EINVAL.
 *   - wakeword_open with a missing GGUF path returns -ENOENT.
 *   - wakeword_close(NULL) is a no-op (returns 0).
 *   - wakeword_set_threshold(NULL, ...) returns -EINVAL.
 *   - wakeword_process(NULL, ...) returns -EINVAL.
 *
 * The full runtime parity is exercised by `wakeword_runtime_test`,
 * which requires the three GGUFs to be on disk.
 */

#include "wakeword/wakeword.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(wakeword_active_backend(), "native-cpu") != 0) {
        fprintf(stderr, "[wakeword-stub-smoke] unexpected backend: %s\n",
                wakeword_active_backend());
        ++failures;
    }

    /* NULL paths → -EINVAL. */
    wakeword_handle h = (wakeword_handle)0x1;
    int rc = wakeword_open(NULL, NULL, NULL, &h);
    if (rc != -EINVAL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open(NULL paths) returned %d, expected -EINVAL\n", rc);
        ++failures;
    }
    if (h != NULL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open did not clear out handle\n");
        ++failures;
    }

    /* Missing files → -ENOENT. */
    h = (wakeword_handle)0x1;
    rc = wakeword_open("/nonexistent.melspec.gguf",
                       "/nonexistent.embedding.gguf",
                       "/nonexistent.classifier.gguf",
                       &h);
    if (rc != -ENOENT) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open(missing) returned %d, expected -ENOENT\n", rc);
        ++failures;
    }
    if (h != NULL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_open(missing) did not clear out handle\n");
        ++failures;
    }

    /* NULL-handle entry points. */
    float score = 99.0f;
    rc = wakeword_process(NULL, NULL, 0, &score);
    if (rc != -EINVAL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_process(NULL) returned %d, expected -EINVAL\n", rc);
        ++failures;
    }

    rc = wakeword_set_threshold(NULL, 0.5f);
    if (rc != -EINVAL) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_set_threshold(NULL) returned %d, expected -EINVAL\n", rc);
        ++failures;
    }

    rc = wakeword_close(NULL);
    if (rc != 0) {
        fprintf(stderr, "[wakeword-stub-smoke] wakeword_close(NULL) returned %d, expected 0\n", rc);
        ++failures;
    }

    printf("[wakeword-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
