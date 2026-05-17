/*
 * Internal session struct shared by the ref-impl translation units.
 *
 * The opaque `doctr_session` from the public ABI is forward-declared
 * in include/doctr/doctr.h; the ref-impl defines it here so the
 * detector/recognizer/postprocess sources can poke at it without
 * exposing internals to consumers.
 */

#ifndef DOCTR_SESSION_H
#define DOCTR_SESSION_H

#include "doctr/doctr.h"
#include "doctr_internal.h"

#ifdef __cplusplus
extern "C" {
#endif

struct doctr_session {
    doctr_gguf *gguf;
    char       *vocab_utf8;
    int         vocab_len;     /* codepoint count, not byte count */
    uint32_t    detector_input_size;
    uint32_t    recognizer_input_h;
    int         alphabet_size; /* vocab_len + 1 (CTC blank at index 0) */
};

/* Detector entry point — defined in doctr_detector_ref.c. */
int doctr_detector_forward(
    doctr_session *s, const doctr_image *image,
    doctr_detection *out, size_t max_detections, size_t *out_count);

/* Recognizer entry point — defined in doctr_recognizer_ref.c. */
int doctr_recognizer_forward(
    doctr_session *s, const doctr_image *crop, doctr_recognition *out);

#ifdef __cplusplus
}
#endif

#endif  /* DOCTR_SESSION_H */
