/*
 * Internal helpers shared between yolo-cpp translation units.
 *
 * Anything declared here is library-private; the public ABI lives in
 * `include/yolo/yolo.h`. We expose these to the in-tree tests so the
 * NMS, postprocess, GGUF reader, and kernels can be exercised before
 * (and alongside) the full forward pass.
 */

#ifndef YOLO_INTERNAL_H
#define YOLO_INTERNAL_H

#include "yolo/yolo.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── NMS + decoupled-head decode (real, Phase 1) ───────────────────── */

size_t yolo_nms_inplace(yolo_detection *dets,
                        size_t n,
                        float iou_threshold);

int yolo_decode_one(const float *channels,
                    size_t       channel_stride,
                    float        conf_threshold,
                    int          input_size,
                    float        scale,
                    int          pad_w,
                    int          pad_h,
                    yolo_detection *out);

/* ── letterbox preprocessing ──────────────────────────────────────── */

/* Letterbox-resize ``img`` (RGB8) into a CHW float plane sized
 * 3*target*target. Aspect ratio is preserved, the short edge is
 * center-padded with neutral grey (114/255), and the result is
 * normalized to [0, 1]. The function reports the resize scale and the
 * per-edge pad in pixels so the postprocess can un-letterbox bboxes
 * back to source-image absolute coordinates.
 *
 * Returns 0 or a negative errno. ``out_chw`` must be sized for
 * 3*target*target floats. */
int yolo_letterbox_rgb_to_chw(
    const yolo_image *img, int target_size,
    float *out_chw,
    float *out_scale, int *out_pad_w, int *out_pad_h);

/* ── GGUF reader ──────────────────────────────────────────────────── */

typedef struct yolo_gguf yolo_gguf;

/* Open and mmap the GGUF at ``path``. Returns NULL on failure and sets
 * ``*err`` to a negative errno. Supports F32 + F16 tensors. */
yolo_gguf *yolo_gguf_open(const char *path, int *err);
void       yolo_gguf_close(yolo_gguf *g);

/* Metadata getters. ``out`` for the string variant is a caller buffer;
 * ``cap`` is its capacity. ``out_len`` (when non-NULL) reports the
 * required length excluding the NUL. -ENOSPC if cap was too small. */
int yolo_gguf_get_string  (const yolo_gguf *g, const char *key,
                           char *out, size_t cap, size_t *out_len);
int yolo_gguf_get_uint32  (const yolo_gguf *g, const char *key, uint32_t *out);
int yolo_gguf_get_float32 (const yolo_gguf *g, const char *key, float    *out);

/* Lookup a tensor by exact name. Returns its data pointer (read-only,
 * points into the mmap; valid for the lifetime of the yolo_gguf
 * handle), writes its shape into ``dims`` (PyTorch outer-first order;
 * up to ``max_dims`` entries) and rank into ``*ndim``, and writes the
 * GGML dtype (0=F32, 1=F16) into ``*out_dtype``. Returns NULL if the
 * tensor is missing or the shape exceeds ``max_dims``. */
const void *yolo_gguf_tensor_data(
    const yolo_gguf *g, const char *name,
    int *out_dtype, int64_t *dims, int max_dims, int *ndim);

size_t      yolo_gguf_tensor_count(const yolo_gguf *g);
const char *yolo_gguf_tensor_name (const yolo_gguf *g, size_t i);

/* In-place fp16 → fp32 expansion. Caller sizes ``dst`` for ``n`` floats. */
void yolo_fp16_to_fp32(const void *src, float *dst, size_t n);

/* ── kernels (pure C, batch-of-1) ─────────────────────────────────── */

void yolo_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out);

void yolo_apply_affine(
    float *x, int channels, int hw,
    const float *scale, const float *shift);

void yolo_bn_fold(
    const float *gamma, const float *beta,
    const float *mean, const float *var,
    float eps, int channels,
    float *scale_out, float *shift_out);

void yolo_silu_inplace   (float *x, int n);
void yolo_sigmoid_inplace(float *x, int n);

void yolo_concat_channels(
    const float *a, int ca,
    const float *b, int cb,
    int h, int w, float *out);

void yolo_upsample2_nearest(
    const float *x, int channels, int hin, int win, float *out);

void yolo_maxpool2d_same(
    const float *x, int channels, int hin, int win,
    int k, float *out);

void yolo_softmax_rows(float *x, int rows, int cols);

#ifdef __cplusplus
}
#endif

#endif /* YOLO_INTERNAL_H */
