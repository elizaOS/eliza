/*
 * doctr-cpp public ABI glue for the native CPU reference runtime.
 *
 * The heavy detector/recognizer kernels live in doctr_detector_ref.c and
 * doctr_recognizer_ref.c. This file owns session lifecycle, GGUF metadata
 * validation, and dispatch from the public ABI to those reference forwards.
 */

#include "doctr_session.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

static char *dup_cstr(const char *s) {
    if (s == NULL) return NULL;
    size_t n = strlen(s);
    char *out = (char *)malloc(n + 1);
    if (out == NULL) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

static int count_utf8_codepoints(const char *s) {
    int n = 0;
    for (const unsigned char *p = (const unsigned char *)s; p != NULL && *p != '\0'; ++p) {
        if ((*p & 0xC0u) != 0x80u) ++n;
    }
    return n;
}

static int read_required_u32(const doctr_gguf *g, const char *key, uint32_t expected) {
    uint32_t value = 0;
    int rc = doctr_gguf_get_uint32(g, key, &value);
    if (rc != 0) return rc;
    return value == expected ? 0 : -EINVAL;
}

static int read_required_string(const doctr_gguf *g, const char *key, const char *expected) {
    const char *value = doctr_gguf_get_string(g, key);
    if (value == NULL) return -EINVAL;
    int ok = strcmp(value, expected) == 0;
    free((void *)value);
    return ok ? 0 : -EINVAL;
}

int doctr_open(const char *gguf_path, doctr_session **out) {
    if (out != NULL) *out = NULL;
    if (gguf_path == NULL || gguf_path[0] == '\0' || out == NULL) return -EINVAL;

    int err = 0;
    doctr_gguf *g = doctr_gguf_open(gguf_path, &err);
    if (g == NULL) return err != 0 ? err : -EIO;

    int rc = read_required_string(g, "doctr.detector", DOCTR_DETECTOR_DB_RESNET50);
    if (rc == 0) rc = read_required_string(g, "doctr.recognizer", DOCTR_RECOGNIZER_CRNN_VGG16_BN);
    if (rc == 0) rc = read_required_u32(g, "doctr.detector_input_size", 1024);
    if (rc == 0) rc = read_required_u32(g, "doctr.recognizer_input_h", 32);
    if (rc != 0) {
        doctr_gguf_close(g);
        return rc;
    }

    const char *vocab = doctr_gguf_get_string(g, "doctr.vocab");
    if (vocab == NULL || vocab[0] == '\0') {
        free((void *)vocab);
        doctr_gguf_close(g);
        return -EINVAL;
    }

    doctr_session *s = (doctr_session *)calloc(1, sizeof(*s));
    if (s == NULL) {
        free((void *)vocab);
        doctr_gguf_close(g);
        return -ENOMEM;
    }

    s->vocab_utf8 = dup_cstr(vocab);
    free((void *)vocab);
    if (s->vocab_utf8 == NULL) {
        free(s);
        doctr_gguf_close(g);
        return -ENOMEM;
    }

    s->gguf = g;
    s->vocab_len = count_utf8_codepoints(s->vocab_utf8);
    s->detector_input_size = 1024;
    s->recognizer_input_h = 32;
    s->alphabet_size = s->vocab_len + 1;
    *out = s;
    return 0;
}

void doctr_close(doctr_session *session) {
    if (session == NULL) return;
    doctr_gguf_close(session->gguf);
    free(session->vocab_utf8);
    free(session);
}

int doctr_detect(doctr_session *session,
                 const doctr_image *image,
                 doctr_detection *out,
                 size_t max_detections,
                 size_t *out_count) {
    return doctr_detector_forward(session, image, out, max_detections, out_count);
}

int doctr_recognize_word(doctr_session *session,
                         const doctr_image *crop,
                         doctr_recognition *out) {
    if (out != NULL) {
        out->text_utf8_length = 0;
        out->char_confidences_length = 0;
        if (out->text_utf8 != NULL && out->text_utf8_capacity > 0) {
            out->text_utf8[0] = '\0';
        }
    }
    return doctr_recognizer_forward(session, crop, out);
}

const char *doctr_active_backend(void) {
    return "cpu-ref";
}
