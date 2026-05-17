/*
 * doctr-cpp — ENOSYS stub.
 *
 * This translation unit satisfies the C ABI declared in
 * `include/doctr/doctr.h` so callers (plugin-vision's coord-OCR
 * adapter, the integration test in test/) link cleanly while the real
 * ggml-backed port lands. Every entry point returns `-ENOSYS`. The
 * port plan in `AGENTS.md` describes the replacement path.
 */

#include "doctr/doctr.h"

#include <errno.h>
#include <stddef.h>

struct doctr_session {
    int unused;
};

int doctr_open(const char *gguf_path, doctr_session **out) {
    (void)gguf_path;
    if (out) *out = NULL;
    return -ENOSYS;
}

void doctr_close(doctr_session *session) {
    (void)session;
}

int doctr_detect(doctr_session *session,
                 const doctr_image *image,
                 doctr_detection *out,
                 size_t max_detections,
                 size_t *out_count) {
    (void)session;
    (void)image;
    (void)out;
    (void)max_detections;
    if (out_count) *out_count = 0;
    return -ENOSYS;
}

int doctr_recognize_word(doctr_session *session,
                         const doctr_image *crop,
                         doctr_recognition *out) {
    (void)session;
    (void)crop;
    if (out) {
        out->text_utf8_length = 0;
        out->char_confidences_length = 0;
        if (out->text_utf8 && out->text_utf8_capacity > 0) {
            out->text_utf8[0] = '\0';
        }
    }
    return -ENOSYS;
}

const char *doctr_active_backend(void) {
    return "stub";
}
