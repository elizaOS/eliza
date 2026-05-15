/*
 * docTR (Document Text Recognition) — public C ABI for the standalone
 * native plugin that ports mindee/doctr's detection + recognition heads
 * to the elizaOS/llama.cpp ggml dispatcher.
 *
 * Upstream:
 *   https://github.com/mindee/doctr
 *
 * This header is the *interface* that the eventual ggml-backed
 * implementation must satisfy. The companion stub in
 * `src/doctr_stub.c` returns ENOSYS for every entry point so callers
 * can compile and link against this library while the real port lands.
 *
 * Two heads are exposed:
 *   1. db_resnet50 — differentiable-binarization text detection. Input
 *      is an RGB image plane; output is a list of axis-aligned bboxes
 *      in pixel coordinates plus a confidence per bbox.
 *   2. crnn_vgg16_bn — CRNN word recognition. Input is a cropped word
 *      image (32-row normalized); output is a UTF-8 transcription plus
 *      a per-character confidence vector.
 *
 * Coordinate convention: every bbox is `{x, y, width, height}` in
 * source-image absolute pixel coordinates. The detector reports tile-
 * relative coordinates; the caller (plugin-vision's
 * `RapidOcrCoordAdapter` replacement) shifts them into the source
 * display's coordinate space.
 *
 * Threading: every entry point is reentrant against distinct
 * `doctr_session` handles. Sharing one handle across threads requires
 * the caller's own mutex.
 *
 * Error handling: all entry points return `int` — zero on success,
 * negative `errno`-style codes on failure. The stub returns `-ENOSYS`
 * so callers can probe for "real" availability with a single call.
 */

#ifndef DOCTR_DOCTR_H
#define DOCTR_DOCTR_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Pinned model variants this header is dimensioned around. The GGUF
 * conversion script (`scripts/doctr_to_gguf.py`) emits artifacts that
 * declare these as their `doctr.detector` / `doctr.recognizer` keys.
 * Decoders refuse to load a GGUF whose tags don't match. */
#define DOCTR_DETECTOR_DB_RESNET50      "db_resnet50"
#define DOCTR_RECOGNIZER_CRNN_VGG16_BN  "crnn_vgg16_bn"

/* Detection input is a contiguous RGB plane, 8 bits per channel,
 * height-major (`y * width * 3 + x * 3 + channel`). This matches the
 * doctr preprocessing pipeline after letterbox resize is applied by the
 * caller. */
typedef struct {
    const uint8_t *rgb;
    int width;
    int height;
} doctr_image;

typedef struct {
    int x;       /* source-image absolute pixel coordinate */
    int y;
    int width;
    int height;
} doctr_bbox;

typedef struct {
    doctr_bbox bbox;
    float confidence;
} doctr_detection;

/* Recognition output is a UTF-8 string and a per-character confidence
 * vector. The caller owns both buffers and passes their capacities; the
 * library writes back the actual lengths. */
typedef struct {
    char    *text_utf8;            /* caller-allocated, NUL-terminated on return */
    size_t   text_utf8_capacity;
    size_t   text_utf8_length;     /* set by the library */

    float   *char_confidences;     /* caller-allocated, length == codepoints */
    size_t   char_confidences_capacity;
    size_t   char_confidences_length;
} doctr_recognition;

/* Opaque handle. The implementation will hold the loaded ggml graphs,
 * scratch buffers, and any pinned tensors. */
typedef struct doctr_session doctr_session;

/* ---------------- session lifecycle ---------------- */

/*
 * Open a session against a docTR GGUF file produced by
 * `scripts/doctr_to_gguf.py`. The GGUF must declare both the detector
 * and recognizer variants this header is dimensioned around (see
 * macros above). Returns 0 on success and writes the new handle into
 * `*out`. Returns `-ENOSYS` from the stub.
 */
int doctr_open(const char *gguf_path, doctr_session **out);

/* Release a session. Safe to call with NULL. */
void doctr_close(doctr_session *session);

/* ---------------- detection ---------------- */

/*
 * Run db_resnet50 over `image` and write up to `max_detections`
 * detections into `out`. The library writes the actual count into
 * `*out_count`. Returns 0 on success, `-ENOSPC` if the buffer was too
 * small for the detected box count (the caller should re-call with a
 * bigger buffer; `*out_count` then carries the required size).
 */
int doctr_detect(doctr_session *session,
                 const doctr_image *image,
                 doctr_detection *out,
                 size_t max_detections,
                 size_t *out_count);

/* ---------------- recognition ---------------- */

/*
 * Run crnn_vgg16_bn over a single pre-cropped word image. The crop
 * must already be normalized to height 32 (doctr convention); the
 * library does the right-pad to a multiple of the receptive-field
 * stride.
 *
 * The caller owns `out->text_utf8` and `out->char_confidences`; the
 * library writes the recognized transcription and confidences into
 * those buffers and updates `*_length`. Returns `-ENOSPC` if either
 * buffer was too small.
 */
int doctr_recognize_word(doctr_session *session,
                         const doctr_image *crop,
                         doctr_recognition *out);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend, e.g. "ggml-cpu",
 * "ggml-metal", "stub". Reflects the *runtime*-selected path. The stub
 * returns "stub".
 */
const char *doctr_active_backend(void);

#ifdef __cplusplus
}
#endif

#endif /* DOCTR_DOCTR_H */
