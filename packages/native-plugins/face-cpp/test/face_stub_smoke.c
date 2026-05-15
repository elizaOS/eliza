/*
 * Build-only smoke test for the face-cpp ABI surface.
 *
 * Phase 2: the model entries are real (face_blazeface_forward /
 * face_embed_forward). This smoke test no longer asserts ENOSYS — it
 * confirms:
 *   - the ABI links;
 *   - face_active_backend() reports the real backend tag (`ggml-cpu-ref`);
 *   - opening a nonexistent GGUF returns -ENOENT (not -ENOSYS) and
 *     clears the out-handle;
 *   - face_detect/face_embed_close are NULL-safe.
 *
 * Helper functions (anchors, alignment, distance) have their own
 * behavioural tests in this directory; the runtime tests
 * (face_runtime_test, face_embed_runtime_test) drive a real
 * forward pass against a synthetic GGUF written to /tmp.
 */

#include "face/face.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    const char *backend = face_active_backend();
    if (strcmp(backend, "ggml-cpu-ref") != 0) {
        fprintf(stderr, "[face-stub-smoke] unexpected backend: %s (expected ggml-cpu-ref)\n",
                backend);
        ++failures;
    }

    face_detect_handle dh = (face_detect_handle)0x1; /* clobbered */
    int rc = face_detect_open("/nonexistent.gguf", &dh);
    if (rc != -ENOENT) {
        fprintf(stderr, "[face-stub-smoke] face_detect_open(missing) returned %d, expected %d\n",
                rc, -ENOENT);
        ++failures;
    }
    if (dh != NULL) {
        fprintf(stderr, "[face-stub-smoke] face_detect_open did not clear out handle\n");
        ++failures;
    }

    if (face_detect_close(NULL) != 0) {
        fprintf(stderr, "[face-stub-smoke] face_detect_close(NULL) did not return 0\n");
        ++failures;
    }

    face_embed_handle eh = (face_embed_handle)0x1;
    rc = face_embed_open("/nonexistent.gguf", &eh);
    if (rc != -ENOENT) {
        fprintf(stderr, "[face-stub-smoke] face_embed_open(missing) returned %d, expected %d\n",
                rc, -ENOENT);
        ++failures;
    }
    if (eh != NULL) {
        fprintf(stderr, "[face-stub-smoke] face_embed_open did not clear out handle\n");
        ++failures;
    }

    if (face_embed_close(NULL) != 0) {
        fprintf(stderr, "[face-stub-smoke] face_embed_close(NULL) did not return 0\n");
        ++failures;
    }

    printf("[face-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
