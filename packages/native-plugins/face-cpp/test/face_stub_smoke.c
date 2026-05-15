/*
 * Build-only smoke test for the face-cpp ENOSYS stub.
 *
 * Confirms the model entry points in `include/face/face.h` link and
 * report `-ENOSYS`. Helper functions (anchors, alignment, distance)
 * have their own behavioural tests in this directory; this smoke test
 * stays as a "the model ABI still compiles" guard.
 */

#include "face/face.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(face_active_backend(), "stub") != 0) {
        fprintf(stderr, "[face-stub-smoke] unexpected backend: %s\n",
                face_active_backend());
        ++failures;
    }

    face_detect_handle dh = (face_detect_handle)0x1; /* clobbered by face_detect_open */
    int rc = face_detect_open("/nonexistent.gguf", &dh);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[face-stub-smoke] face_detect_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (dh != NULL) {
        fprintf(stderr, "[face-stub-smoke] face_detect_open did not clear out handle\n");
        ++failures;
    }

    /* Safe with NULL — must not crash. */
    if (face_detect_close(NULL) != 0) {
        fprintf(stderr, "[face-stub-smoke] face_detect_close(NULL) did not return 0\n");
        ++failures;
    }

    uint8_t pixels[3 * 4 * 4] = {0};
    face_detection dets[2] = {0};
    size_t count = 12345;
    rc = face_detect(NULL, pixels, 4, 4, 4 * 3, 0.5f, dets, 2, &count);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[face-stub-smoke] face_detect returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (count != 0) {
        fprintf(stderr, "[face-stub-smoke] face_detect did not zero out_count (%zu)\n",
                count);
        ++failures;
    }

    face_embed_handle eh = (face_embed_handle)0x1;
    rc = face_embed_open("/nonexistent.gguf", &eh);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[face-stub-smoke] face_embed_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (eh != NULL) {
        fprintf(stderr, "[face-stub-smoke] face_embed_open did not clear out handle\n");
        ++failures;
    }

    float emb[FACE_EMBED_DIM] = {0};
    face_detection crop = {0};
    rc = face_embed(NULL, pixels, 4, 4, 4 * 3, &crop, emb);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[face-stub-smoke] face_embed returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }

    if (face_embed_close(NULL) != 0) {
        fprintf(stderr, "[face-stub-smoke] face_embed_close(NULL) did not return 0\n");
        ++failures;
    }

    printf("[face-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
