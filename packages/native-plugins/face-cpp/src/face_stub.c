/*
 * face-cpp — ENOSYS stub for the model entry points.
 *
 * This translation unit satisfies the model-loading and inference
 * portions of the C ABI declared in `include/face/face.h` so callers
 * (the new TS bindings in plugins/plugin-vision, the smoke tests in
 * test/) link cleanly while the real ggml-backed port lands. Every
 * model entry point here returns `-ENOSYS`. The companion TUs
 * `face_anchor_decode.c`, `face_align.c`, and `face_distance.c`
 * implement real (model-independent) helpers behind the same ABI; the
 * port plan in `AGENTS.md` describes the replacement path for the
 * model entries below.
 */

#include "face/face.h"

#include <errno.h>
#include <stddef.h>

struct face_detect_session { int unused; };
struct face_embed_session  { int unused; };

int face_detect_open(const char *gguf_path, face_detect_handle *out) {
    (void)gguf_path;
    if (out) *out = NULL;
    return -ENOSYS;
}

int face_detect(face_detect_handle handle,
                const uint8_t *rgb,
                int w,
                int h,
                int stride,
                float conf,
                face_detection *out,
                size_t cap,
                size_t *count) {
    (void)handle;
    (void)rgb;
    (void)w;
    (void)h;
    (void)stride;
    (void)conf;
    (void)out;
    (void)cap;
    if (count) *count = 0;
    return -ENOSYS;
}

int face_detect_close(face_detect_handle handle) {
    (void)handle;
    return 0;
}

int face_embed_open(const char *gguf_path, face_embed_handle *out) {
    (void)gguf_path;
    if (out) *out = NULL;
    return -ENOSYS;
}

int face_embed(face_embed_handle handle,
               const uint8_t *rgb,
               int w,
               int h,
               int stride,
               const face_detection *crop,
               float *embedding_out) {
    (void)handle;
    (void)rgb;
    (void)w;
    (void)h;
    (void)stride;
    (void)crop;
    (void)embedding_out;
    return -ENOSYS;
}

int face_embed_close(face_embed_handle handle) {
    (void)handle;
    return 0;
}

const char *face_active_backend(void) {
    return "stub";
}
