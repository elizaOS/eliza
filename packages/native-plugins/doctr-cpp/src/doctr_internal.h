/*
 * doctr-cpp — internal Phase 2 reference implementation header.
 *
 * Phase 2 is pure-C scalar code (no SIMD): a minimal GGUF reader, an
 * image preprocessor, a small set of NN kernels (Conv2D, BN-folded
 * affine, ReLU, MaxPool, ConvTranspose2d, BiLSTM, MatMul, Sigmoid,
 * Softmax), and the DBNet postprocess. Phase 3 will add AVX2/NEON
 * dispatch behind the same internal API.
 *
 * Tensor layout convention everywhere in this file: NCHW for activations
 * (channel-major within an HxW plane), OIhw for conv weights, where O is
 * the output channel and I the input channel. This matches PyTorch's
 * default and also matches the layout in the GGUF that
 * scripts/doctr_to_gguf.py emits — the converter writes the state_dict
 * tensors as-is, so our C kernels can consume them without transposing.
 */

#ifndef DOCTR_INTERNAL_H
#define DOCTR_INTERNAL_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "doctr/doctr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- GGUF reader ---------------- */

typedef struct doctr_gguf doctr_gguf;

/* Open and mmap (or read into a heap buffer; implementation detail) the
 * GGUF at `path`. Returns NULL on failure and sets *err to a negative
 * errno. The reader supports F32 tensors only — that's all
 * scripts/doctr_to_gguf.py emits. */
doctr_gguf *doctr_gguf_open(const char *path, int *err);
void        doctr_gguf_close(doctr_gguf *g);

/* Lookup metadata (returns NULL when key is missing). */
const char *doctr_gguf_get_string(const doctr_gguf *g, const char *key);
int         doctr_gguf_get_uint32(const doctr_gguf *g, const char *key, uint32_t *out);

/* Lookup an F32 tensor. Returns its data pointer (read-only, points
 * into the GGUF buffer) and writes shape into `dims` (up to
 * `max_dims`); writes the actual rank into `*ndim`. Returns NULL when
 * the tensor is missing or has the wrong dtype. */
const float *doctr_gguf_get_f32(
    const doctr_gguf *g, const char *name,
    int64_t *dims, int max_dims, int *ndim);

/* ---------------- image preprocessing ---------------- */

/* In-place ImageNet normalization on an NCHW float plane: subtract
 * mean and divide by std per channel. doctr's normalization (mean
 * [0.798, 0.785, 0.772], std [0.264, 0.2749, 0.287]) is used by both
 * heads. */
void doctr_normalize_imagenet_inplace(float *plane, int channels, int hw);

/* Letterbox-resize an RGB8 image into a contiguous CHW float plane of
 * fixed `target_size x target_size`. Aspect ratio is preserved; the
 * unused border is filled with 0 (after normalization, that's the
 * mean-shifted background docTR uses). The function writes the actual
 * scaled-image bbox inside the letterboxed canvas into `*scaled_w` and
 * `*scaled_h` so the postprocess can map detector coords back to source
 * coords. Returns 0 or -ENOMEM. */
int doctr_letterbox_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h,
    float *out_chw, int target_size,
    int *scaled_w, int *scaled_h);

/* Bilinear-resize an RGB8 image into a fixed (target_h, target_w) CHW
 * float plane. Used by the recognizer (target_h=32). Returns 0 or
 * -ENOMEM. */
int doctr_resize_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h,
    float *out_chw, int target_h, int target_w);

/* ---------------- NN kernels (pure C, batch-of-1) ---------------- */

/* Conv2D forward (batch-of-1):
 *   x   shape: (cin, hin, win)
 *   w   shape: (cout, cin, kh, kw)
 *   b   shape: (cout) or NULL
 *   out shape: (cout, hout, wout) where
 *     hout = (hin + 2*padh - kh)/strideh + 1
 *     wout = (win + 2*padw - kw)/stridew + 1
 *
 * Caller must size `out` correctly. Slow naive impl — Phase 3 replaces
 * with an im2col-style SIMD path. */
void doctr_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out);

/* Apply BN affine (precomputed scale/shift) channel-wise + optional
 * ReLU. BN parameters are folded into scale/shift by the caller using
 * doctr_bn_fold(). */
void doctr_apply_affine_relu(float *x, int channels, int hw,
                             const float *scale, const float *shift,
                             bool relu);

/* Fold a BN layer's (gamma, beta, mean, var, eps) into a per-channel
 * (scale, shift) pair such that bn(x) == scale * x + shift. */
void doctr_bn_fold(const float *gamma, const float *beta,
                   const float *mean, const float *var,
                   float eps, int channels,
                   float *scale_out, float *shift_out);

/* MaxPool2D forward (batch-of-1, kernel kh×kw, stride×stride). */
void doctr_maxpool2d_ref(
    const float *x, int channels, int hin, int win,
    int kh, int kw, int strideh, int stridew, int padh, int padw,
    float *out);

/* Bilinear upsample by integer factor `factor` (e.g. ×2). NCHW input,
 * NCHW output sized (channels, hin*factor, win*factor). Aligns corners
 * = False (PyTorch default). */
void doctr_upsample_bilinear_ref(
    const float *x, int channels, int hin, int win,
    int factor, float *out);

/* ConvTranspose2d for the prob_head's two upsampling layers. Stride 2,
 * kernel 2x2, no padding, no output_padding. Doctr uses this exact
 * configuration. */
void doctr_conv_transpose_2x2_s2_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout,    /* w: (cin, cout, 2, 2) */
    const float *b, float *out);

/* In-place sigmoid on `n` floats. */
void doctr_sigmoid_inplace(float *x, int n);

/* GEMM: out = x @ w.T + b. x is (m, k), w is (n, k), b is (n) or NULL,
 * out is (m, n). Same convention as torch.nn.Linear. */
void doctr_linear_ref(
    const float *x, int m, int k,
    const float *w, int n,
    const float *b, float *out);

/* LSTM cell — one timestep. Updates h and c in place.
 *   x:  (input_dim)
 *   h:  (hidden_dim)
 *   c:  (hidden_dim)
 *   w_ih: (4*hidden_dim, input_dim)  rows in i,f,g,o order (PyTorch)
 *   w_hh: (4*hidden_dim, hidden_dim)
 *   b_ih: (4*hidden_dim)
 *   b_hh: (4*hidden_dim)
 */
void doctr_lstm_step_ref(
    const float *x, int input_dim,
    float *h, float *c, int hidden_dim,
    const float *w_ih, const float *w_hh,
    const float *b_ih, const float *b_hh);

/* ---------------- DBNet postprocess ---------------- */

/* Turn a binary mask (HxW, fp32 values in [0,1]) into a list of
 * axis-aligned bboxes in source-image absolute pixel coordinates. The
 * caller passes the source size and the scaled-image size from
 * letterbox so the function can unscale.
 *
 * Returns the number of boxes that were emitted (clamped to
 * `max_detections`). When `n_total` is non-NULL the unclamped count is
 * written there too — that lets the C ABI return -ENOSPC and let the
 * caller resize.
 *
 * Threshold conventions match doctr's defaults:
 *   bin_thresh = 0.3   (mask binarization)
 *   box_thresh = 0.1   (component score ≥ this to emit)
 *   min_area   = 4     (drop tiny components)
 */
size_t doctr_dbnet_postprocess(
    const float *mask, int mask_h, int mask_w,
    int src_w, int src_h, int scaled_w, int scaled_h, int target_size,
    doctr_detection *out, size_t max_detections,
    size_t *n_total);

/* ---------------- CTC greedy decode ---------------- */

/* Greedy CTC decode of a (timesteps, vocab+1) fp32 logits matrix.
 * Position 0 of vocab+1 is the blank symbol; the remaining `vocab_len`
 * symbols are ordered to match the vocab string emitted by
 * scripts/doctr_to_gguf.py.
 *
 * Writes UTF-8 into `text` (NUL-terminated, capped at
 * `text_capacity-1` bytes) and the per-character mean confidence into
 * `confs` (capped at `confs_capacity` floats). Returns 0 on success or
 * -ENOSPC when either buffer was too small. */
int doctr_ctc_greedy_decode(
    const float *logits, int timesteps, int alphabet_size,
    const char *vocab_utf8, int vocab_len,
    char *text, size_t text_capacity, size_t *text_len,
    float *confs, size_t confs_capacity, size_t *confs_len);

#ifdef __cplusplus
}
#endif

#endif  /* DOCTR_INTERNAL_H */
