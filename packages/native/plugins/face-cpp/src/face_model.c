/*
 * face_model.c — real implementations of the face_detect_* /
 * face_embed_* model entry points declared in include/face/face.h.
 *
 * Replaces the ENOSYS stub in face_stub.c. The model entries:
 *
 *   - mmap a GGUF produced by scripts/blazeface_to_gguf.py or
 *     scripts/face_embed_to_gguf.py;
 *   - validate the metadata (`face.detector` / `face.embedder` etc.)
 *     against the locked C ABI;
 *   - load all weights into a session struct;
 *   - on each forward call, preprocess the input, run the per-head
 *     forward (face_blazeface_forward / face_embed_forward), and
 *     post-process via face_blazeface_decode + face_nms_inplace
 *     (detection) or 5-pt align + L2 normalize (embedding).
 *
 * `face_active_backend()` reports `"ggml-cpu-ref"` — the kernels are
 * pure-C scalar today, but the loader, GGUF format, and forward graph
 * are real and shippable.
 */

#include "face/face.h"
#include "face_internal.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* BlazeFace's recommended NMS IoU threshold from MediaPipe
 * (`min_suppression_threshold = 0.3`). */
#define FACE_NMS_IOU_THRESHOLD 0.3f

/* ---------------- session structs ---------------- */

typedef struct face_detect_session {
    face_gguf            *gguf;
    face_blazeface_state *bf;
    face_blazeface_anchor *anchors;
} face_detect_session;

typedef struct face_embed_session {
    face_gguf        *gguf;
    face_embed_state *emb;
} face_embed_session;

/* ---------------- detection ---------------- */

int face_detect_open(const char *gguf_path, face_detect_handle *out) {
    if (out) *out = NULL;
    if (!gguf_path || !out) return -EINVAL;

    int err = 0;
    face_gguf *g = face_gguf_open(gguf_path, &err);
    if (!g) return err ? err : -ENOENT;

    /* Metadata validation. */
    const char *detector = face_gguf_get_string(g, "face.detector");
    if (!detector || strcmp(detector, FACE_DETECTOR_BLAZEFACE_FRONT) != 0) {
        face_gguf_close(g);
        return -EINVAL;
    }
    uint32_t input_size = 0;
    if (face_gguf_get_uint32(g, "face.detector_input_size", &input_size) != 0
        || input_size != FACE_DETECTOR_INPUT_SIZE) {
        face_gguf_close(g);
        return -EINVAL;
    }
    uint32_t anchor_count = 0;
    if (face_gguf_get_uint32(g, "face.anchor_count", &anchor_count) != 0
        || anchor_count != FACE_DETECTOR_ANCHOR_COUNT) {
        face_gguf_close(g);
        return -EINVAL;
    }

    face_detect_session *s = (face_detect_session *)calloc(1, sizeof(*s));
    if (!s) { face_gguf_close(g); return -ENOMEM; }
    s->gguf = g;

    s->bf = face_blazeface_state_new(g, &err);
    if (!s->bf) { face_detect_close(s); return err ? err : -EINVAL; }

    s->anchors = (face_blazeface_anchor *)calloc(
        FACE_DETECTOR_ANCHOR_COUNT, sizeof(face_blazeface_anchor));
    if (!s->anchors) { face_detect_close(s); return -ENOMEM; }
    int n = face_blazeface_make_anchors(s->anchors, FACE_DETECTOR_ANCHOR_COUNT);
    if (n != FACE_DETECTOR_ANCHOR_COUNT) {
        face_detect_close(s);
        return -EINVAL;
    }

    *out = s;
    return 0;
}

int face_detect(face_detect_handle handle,
                const uint8_t *rgb,
                int w,
                int h,
                int stride,
                float conf,
                face_detection *out,
                size_t cap,
                size_t *count)
{
    if (!handle || !rgb || !out || !count) return -EINVAL;
    if (w <= 0 || h <= 0 || stride < w * 3) return -EINVAL;
    *count = 0;

    /* 1. Resize to 128x128 RGB CHW float, normalized to [-1, 1]. */
    const int N = FACE_DETECTOR_INPUT_SIZE;
    float *chw = (float *)malloc(sizeof(float) * 3 * (size_t)N * (size_t)N);
    if (!chw) return -ENOMEM;
    int rc = face_resize_rgb_to_chw(rgb, w, h, stride, chw, N, N);
    if (rc) { free(chw); return rc; }
    /* BlazeFace preprocessor: x/127.5 - 1. */
    const float mean[3] = { 127.5f, 127.5f, 127.5f };
    const float std[3]  = { 127.5f, 127.5f, 127.5f };
    face_normalize_chw_inplace(chw, 3, N * N, mean, std);

    /* 2. Forward pass. */
    float *regs = (float *)malloc(sizeof(float) * FACE_DETECTOR_ANCHOR_COUNT * 16);
    float *scs  = (float *)malloc(sizeof(float) * FACE_DETECTOR_ANCHOR_COUNT);
    if (!regs || !scs) { free(chw); free(regs); free(scs); return -ENOMEM; }
    rc = face_blazeface_forward(handle->bf, chw, regs, scs);
    free(chw);
    if (rc) { free(regs); free(scs); return rc; }

    /* 3. Decode anchors → source-pixel detections (no NMS yet). */
    face_detection *raw = (face_detection *)malloc(
        sizeof(face_detection) * FACE_DETECTOR_ANCHOR_COUNT);
    if (!raw) { free(regs); free(scs); return -ENOMEM; }
    size_t raw_count = 0;
    rc = face_blazeface_decode(handle->anchors, regs, scs, conf,
                               w, h, raw, FACE_DETECTOR_ANCHOR_COUNT,
                               &raw_count);
    free(regs); free(scs);
    if (rc != 0 && rc != -ENOSPC) { free(raw); return rc; }

    /* 4. NMS in place. */
    size_t kept = face_nms_inplace(raw, raw_count, FACE_NMS_IOU_THRESHOLD);

    /* 5. Copy up to `cap` survivors out. */
    const size_t to_copy = kept < cap ? kept : cap;
    if (to_copy > 0) memcpy(out, raw, sizeof(face_detection) * to_copy);
    free(raw);

    *count = kept;
    return kept > cap ? -ENOSPC : 0;
}

int face_detect_close(face_detect_handle handle) {
    if (!handle) return 0;
    if (handle->bf)      face_blazeface_state_free(handle->bf);
    if (handle->anchors) free(handle->anchors);
    if (handle->gguf)    face_gguf_close(handle->gguf);
    free(handle);
    return 0;
}

/* ---------------- recognition ---------------- */

int face_embed_open(const char *gguf_path, face_embed_handle *out) {
    if (out) *out = NULL;
    if (!gguf_path || !out) return -EINVAL;

    int err = 0;
    face_gguf *g = face_gguf_open(gguf_path, &err);
    if (!g) return err ? err : -ENOENT;

    const char *embedder = face_gguf_get_string(g, "face.embedder");
    if (!embedder
        || (strcmp(embedder, FACE_EMBEDDER_FACENET_128) != 0
            && strcmp(embedder, FACE_EMBEDDER_ARCFACE_MINI_128) != 0)) {
        face_gguf_close(g);
        return -EINVAL;
    }
    uint32_t input_size = 0;
    if (face_gguf_get_uint32(g, "face.embedder_input_size", &input_size) != 0
        || input_size != FACE_EMBED_CROP_SIZE) {
        face_gguf_close(g);
        return -EINVAL;
    }
    uint32_t dim = 0;
    if (face_gguf_get_uint32(g, "face.embedder_dim", &dim) != 0
        || dim != FACE_EMBED_DIM) {
        face_gguf_close(g);
        return -EINVAL;
    }

    face_embed_session *s = (face_embed_session *)calloc(1, sizeof(*s));
    if (!s) { face_gguf_close(g); return -ENOMEM; }
    s->gguf = g;

    s->emb = face_embed_state_new(g, &err);
    if (!s->emb) { face_embed_close(s); return err ? err : -EINVAL; }

    *out = s;
    return 0;
}

int face_embed(face_embed_handle handle,
               const uint8_t *rgb,
               int w,
               int h,
               int stride,
               const face_detection *crop,
               float *embedding_out)
{
    if (!handle || !rgb || !crop || !embedding_out) return -EINVAL;
    if (w <= 0 || h <= 0 || stride < w * 3) return -EINVAL;

    /* 1. Affine-warp the 5-keypoint crop into a 112x112 RGB. */
    const int N = FACE_EMBED_CROP_SIZE;
    uint8_t *aligned = (uint8_t *)malloc((size_t)N * (size_t)N * 3);
    if (!aligned) return -ENOMEM;
    int rc = face_align_5pt(rgb, w, h, stride, crop, aligned);
    if (rc) { free(aligned); return rc; }

    /* 2. Convert to CHW float and normalize to [-1, 1]. */
    float *chw = (float *)malloc(sizeof(float) * 3 * (size_t)N * (size_t)N);
    if (!chw) { free(aligned); return -ENOMEM; }
    rc = face_resize_rgb_to_chw(aligned, N, N, N * 3, chw, N, N);
    free(aligned);
    if (rc) { free(chw); return rc; }
    const float mean[3] = { 127.5f, 127.5f, 127.5f };
    const float std[3]  = { 127.5f, 127.5f, 127.5f };
    face_normalize_chw_inplace(chw, 3, N * N, mean, std);

    /* 3. Forward + L2 normalize (already done in face_embed_forward). */
    rc = face_embed_forward(handle->emb, chw, embedding_out);
    free(chw);
    return rc;
}

int face_embed_close(face_embed_handle handle) {
    if (!handle) return 0;
    if (handle->emb)  face_embed_state_free(handle->emb);
    if (handle->gguf) face_gguf_close(handle->gguf);
    free(handle);
    return 0;
}

const char *face_active_backend(void) {
    return "ggml-cpu-ref";
}
