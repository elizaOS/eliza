/*
 * Public C ABI implementation backed by the Phase 2 reference forward
 * passes in doctr_detector_ref.c and doctr_recognizer_ref.c.
 *
 * This translation unit owns the ABI symbols declared in
 * include/doctr/doctr.h. It is mutually exclusive with src/doctr_stub.c
 * — link exactly one of the two into a final binary. Phase 1 ships the
 * stub library (libdoctr.a); Phase 2 ships the reference library
 * (libdoctr_ref.a) so callers can pick which behavior they want at
 * link time without changing the header.
 *
 * Backend tag: "ref-c" (scalar pure-C reference). Phase 3 will swap in
 * an "avx2" / "neon" tag when SIMD dispatchers land.
 */

#include "doctr/doctr.h"
#include "doctr_internal.h"
#include "doctr_session.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

int doctr_open(const char *gguf_path, doctr_session **out) {
    if (out) *out = NULL;
    if (!gguf_path || !out) return -EINVAL;

    int err = 0;
    doctr_gguf *g = doctr_gguf_open(gguf_path, &err);
    if (!g) return err ? err : -EINVAL;

    /* Verify the GGUF declares the variants this header is dimensioned
     * around. Refuse anything else — silent acceptance would let a
     * future, differently-shaped checkpoint load and produce garbage
     * output. */
    const char *det_name = doctr_gguf_get_string(g, "doctr.detector");
    const char *rec_name = doctr_gguf_get_string(g, "doctr.recognizer");
    if (!det_name || !rec_name ||
        strcmp(det_name, DOCTR_DETECTOR_DB_RESNET50) != 0 ||
        strcmp(rec_name, DOCTR_RECOGNIZER_CRNN_VGG16_BN) != 0) {
        doctr_gguf_close(g);
        return -EINVAL;
    }

    uint32_t det_in = 0, rec_in = 0;
    if (doctr_gguf_get_uint32(g, "doctr.detector_input_size", &det_in) != 0 ||
        doctr_gguf_get_uint32(g, "doctr.recognizer_input_h", &rec_in) != 0 ||
        det_in == 0 || rec_in == 0) {
        doctr_gguf_close(g);
        return -EINVAL;
    }

    const char *vocab = doctr_gguf_get_string(g, "doctr.vocab");
    if (!vocab) {
        doctr_gguf_close(g);
        return -EINVAL;
    }

    /* Count UTF-8 codepoints in the vocab string. */
    int vocab_len = 0;
    {
        const unsigned char *p = (const unsigned char *)vocab;
        while (*p) {
            unsigned char b = *p;
            int cl;
            if      ((b & 0x80) == 0x00) cl = 1;
            else if ((b & 0xE0) == 0xC0) cl = 2;
            else if ((b & 0xF0) == 0xE0) cl = 3;
            else if ((b & 0xF8) == 0xF0) cl = 4;
            else { cl = -1; break; }
            for (int i = 1; i < cl; ++i) {
                if ((p[i] & 0xC0) != 0x80) { cl = -1; break; }
            }
            if (cl < 0) break;
            ++vocab_len;
            p += cl;
        }
    }
    if (vocab_len <= 0) {
        doctr_gguf_close(g);
        return -EINVAL;
    }

    doctr_session *s = (doctr_session *)calloc(1, sizeof(doctr_session));
    if (!s) {
        doctr_gguf_close(g);
        return -ENOMEM;
    }
    s->gguf = g;
    s->vocab_utf8 = (char *)vocab;  /* leaked dup owned by GGUF helper */
    s->vocab_len = vocab_len;
    s->detector_input_size = det_in;
    s->recognizer_input_h = rec_in;
    s->alphabet_size = vocab_len + 1;

    *out = s;
    return 0;
}

void doctr_close(doctr_session *session) {
    if (!session) return;
    if (session->gguf) doctr_gguf_close(session->gguf);
    free(session->vocab_utf8);
    free(session);
}

int doctr_detect(doctr_session *session,
                 const doctr_image *image,
                 doctr_detection *out,
                 size_t max_detections,
                 size_t *out_count) {
    if (out_count) *out_count = 0;
    if (!session || !image) return -EINVAL;
    return doctr_detector_forward(session, image, out, max_detections, out_count);
}

int doctr_recognize_word(doctr_session *session,
                         const doctr_image *crop,
                         doctr_recognition *out) {
    if (!session || !crop || !out) return -EINVAL;
    return doctr_recognizer_forward(session, crop, out);
}

const char *doctr_active_backend(void) {
    return "ref-c";
}
