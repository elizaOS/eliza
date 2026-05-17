/*
 * face-cpp internal Phase 2 reference header.
 *
 * Phase 2 is a pure-C scalar reference implementation: a minimal GGUF
 * v3 reader (mmap, F32 + F16 tensors only), an image preprocessor
 * (bilinear resize + normalize), the small NN kernels both heads need
 * (Conv2D, depthwise 3x3, pointwise 1x1, ReLU, MaxPool, Linear,
 * BN-fold), the BlazeFace forward graph, the face-embed forward graph,
 * and IoU-NMS. There is no actual ggml dispatch yet — `face_active_backend`
 * advertises `"ggml-cpu-ref"` so callers see the runtime is real but
 * scalar.
 *
 * Tensor layout convention everywhere here: NCHW for activations,
 * OIhw for conv weights. This matches the layout the converter
 * scripts emit (PyTorch state-dict order).
 */

#ifndef FACE_INTERNAL_H
#define FACE_INTERNAL_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "face/face.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- GGUF reader ---------------- */

typedef struct face_gguf face_gguf;

face_gguf *face_gguf_open(const char *path, int *err);
void       face_gguf_close(face_gguf *g);

const char *face_gguf_get_string(const face_gguf *g, const char *key);
int         face_gguf_get_uint32(const face_gguf *g, const char *key, uint32_t *out);

/* Lookup an F32 or F16 tensor. Returns its data pointer (read-only,
 * points into the mmap) plus dtype (0=F32, 1=F16). On dtype mismatch
 * the caller can convert via face_f16_to_f32 / face_get_tensor_f32. */
const void *face_gguf_get_tensor(
    const face_gguf *g, const char *name,
    int64_t *dims, int max_dims, int *ndim,
    uint32_t *out_dtype);

/* Lookup an F32 view, converting F16 to a heap-allocated float buffer
 * if needed. The caller frees `*out_owned` when non-NULL. The returned
 * pointer is either a pointer into the mmap (when owned is NULL) or
 * the freshly-allocated buffer. */
const float *face_gguf_get_f32_view(
    const face_gguf *g, const char *name,
    int64_t *dims, int max_dims, int *ndim,
    float **out_owned);

/* ---------------- F16 helpers ---------------- */

float face_f16_to_f32(uint16_t h);

/* ---------------- image preprocessing ---------------- */

/* Bilinear-resize an RGB8 image into a fixed (target_h, target_w) CHW
 * float plane. Used by both heads. Returns 0 or -ENOMEM. */
int face_resize_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h, int src_stride,
    float *out_chw, int target_h, int target_w);

/* In-place per-channel affine: out = (x - mean) / std. `n` is the
 * number of (h*w) pixels per channel; `c` is the channel count. */
void face_normalize_chw_inplace(
    float *plane, int channels, int hw,
    const float mean[3], const float std[3]);

/* ---------------- NN kernels (pure C, batch-of-1) ---------------- */

/* Standard Conv2D forward (batch-of-1):
 *   x   shape: (cin, hin, win)
 *   w   shape: (cout, cin, kh, kw)
 *   b   shape: (cout) or NULL
 *   out shape: (cout, hout, wout) where
 *     hout = (hin + 2*padh - kh)/strideh + 1
 *     wout = (win + 2*padw - kw)/stridew + 1
 */
void face_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out);

/* Depthwise Conv2D forward. Weight shape: (channels, 1, kh, kw). */
void face_depthwise_conv2d_ref(
    const float *x, int channels, int hin, int win,
    const float *w, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out);

/* Pointwise (1x1) Conv2D. Same as Conv2D with kh=kw=1, stride=1, pad=0
 * but specialized for the hot path. Weight shape: (cout, cin, 1, 1). */
void face_pointwise_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout,
    const float *b, float *out);

/* MaxPool2D forward. */
void face_maxpool2d_ref(
    const float *x, int channels, int hin, int win,
    int kh, int kw, int strideh, int stridew, int padh, int padw,
    float *out);

/* In-place ReLU on n floats. */
void face_relu_inplace(float *x, int n);

/* y = x @ w.T + b. Same convention as torch.nn.Linear. */
void face_linear_ref(
    const float *x, int m, int k,
    const float *w, int n,
    const float *b, float *out);

/* In-place L2 normalization across the last dim. n is total floats,
 * dim is the embedding dim. */
void face_l2_normalize_inplace(float *x, int dim);

/* Fold BN(x) = scale * x + shift, channel-wise + optional ReLU. */
void face_apply_bn_relu_inplace(
    float *x, int channels, int hw,
    const float *scale, const float *shift,
    bool relu);

/* Compute (scale, shift) from BN parameters such that
 * bn(x) = scale * x + shift. */
void face_bn_fold(
    const float *gamma, const float *beta,
    const float *mean, const float *var,
    float eps, int channels,
    float *scale_out, float *shift_out);

/* ---------------- BlazeFace forward + NMS ---------------- */

typedef struct face_blazeface_state face_blazeface_state;

face_blazeface_state *face_blazeface_state_new(const face_gguf *g, int *err);
void                  face_blazeface_state_free(face_blazeface_state *s);

/* Run a single BlazeFace forward pass on a 128x128 RGB plane (already
 * normalized into [-1, 1] in CHW float). Outputs the regressors
 * (FACE_DETECTOR_ANCHOR_COUNT * 16 floats) and scores
 * (FACE_DETECTOR_ANCHOR_COUNT floats) into caller-supplied buffers. */
int face_blazeface_forward(
    face_blazeface_state *s,
    const float *chw_input,
    float *out_regressors,
    float *out_scores);

/* IoU-based NMS over a face_detection list, in place. Returns the
 * surviving count (also re-orders the array so the first `kept`
 * entries are the survivors, sorted by descending confidence). */
size_t face_nms_inplace(face_detection *dets, size_t n, float iou_thresh);

/* ---------------- face-embed forward ---------------- */

typedef struct face_embed_state face_embed_state;

face_embed_state *face_embed_state_new(const face_gguf *g, int *err);
void              face_embed_state_free(face_embed_state *s);

/* Run a single embed forward pass on a 112x112 RGB plane already
 * preprocessed into CHW float (the embed graph normalizes from
 * [0, 255] internally). Writes FACE_EMBED_DIM L2-normalized floats. */
int face_embed_forward(
    face_embed_state *s,
    const float *chw_input,
    float *embedding_out);

#ifdef __cplusplus
}
#endif

#endif /* FACE_INTERNAL_H */
