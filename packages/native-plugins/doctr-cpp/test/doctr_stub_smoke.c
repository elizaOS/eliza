/*
 * Build-only smoke test for the doctr-cpp ENOSYS stub.
 *
 * Confirms the C ABI declared in `include/doctr/doctr.h` links and
 * that every entry point reports the expected `-ENOSYS`. This is
 * intentionally not a behavioural test — once the real ggml-backed
 * implementation lands, the parity / quality tests will live next to
 * it and this smoke test stays as a "the ABI still compiles" guard.
 */

#include "doctr/doctr.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(doctr_active_backend(), "stub") != 0) {
        fprintf(stderr, "[doctr-stub-smoke] unexpected backend: %s\n",
                doctr_active_backend());
        ++failures;
    }

    doctr_session *session = (doctr_session *)0x1; /* clobbered by doctr_open */
    int rc = doctr_open("/nonexistent.gguf", &session);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (session != NULL) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_open did not clear out handle\n");
        ++failures;
    }

    /* Safe with NULL — must not crash. */
    doctr_close(NULL);

    uint8_t pixels[3 * 4 * 4] = {0};
    doctr_image image = { .rgb = pixels, .width = 4, .height = 4 };
    doctr_detection detections[2] = {{{0, 0, 0, 0}, 0.0f}, {{0, 0, 0, 0}, 0.0f}};
    size_t count = 12345;
    rc = doctr_detect(NULL, &image, detections, 2, &count);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_detect returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (count != 0) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_detect did not zero out_count (%zu)\n",
                count);
        ++failures;
    }

    char text[16];
    float confs[16];
    doctr_recognition reco = {
        .text_utf8 = text,
        .text_utf8_capacity = sizeof(text),
        .text_utf8_length = 99,
        .char_confidences = confs,
        .char_confidences_capacity = sizeof(confs) / sizeof(confs[0]),
        .char_confidences_length = 99,
    };
    rc = doctr_recognize_word(NULL, &image, &reco);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_recognize_word returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (reco.text_utf8_length != 0 || reco.char_confidences_length != 0) {
        fprintf(stderr, "[doctr-stub-smoke] doctr_recognize_word did not reset lengths\n");
        ++failures;
    }
    if (text[0] != '\0') {
        fprintf(stderr, "[doctr-stub-smoke] doctr_recognize_word did not NUL-terminate\n");
        ++failures;
    }

    printf("[doctr-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
