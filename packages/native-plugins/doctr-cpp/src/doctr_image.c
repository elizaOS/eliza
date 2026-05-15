/*
 * Image preprocessing for doctr-cpp Phase 2.
 *
 * Two flavours:
 *   - letterbox-resize for the detector (1024x1024 canvas, aspect
 *     preserved, zero pad). The caller hands us the source image's
 *     RGB8 plane and a pre-allocated CHW float buffer of size
 *     3*target*target.
 *   - plain bilinear resize for the recognizer (32xW canvas, aspect
 *     preserved by stretching W to a configured multiple — the C ABI
 *     specifies that the caller has already cropped to a 32-tall
 *     image, so we do plain (target_h, target_w) bilinear).
 *
 * After resizing, both heads share the doctr ImageNet normalization:
 *   x = (x/255 - mean) / std
 * with mean=[0.798,0.785,0.772] and std=[0.264,0.2749,0.287], applied
 * per channel. These constants come straight from python-doctr's
 * mindee/doctr#references; matching them lets the C-ref's output line
 * up numerically with the Python reference.
 */

#include "doctr_internal.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* doctr's ImageNet-style mean/std (RGB). */
static const float kDoctrMean[3] = { 0.798f, 0.785f, 0.772f };
static const float kDoctrStd[3]  = { 0.264f, 0.2749f, 0.287f };

void doctr_normalize_imagenet_inplace(float *plane, int channels, int hw) {
    for (int c = 0; c < channels; ++c) {
        float *row = plane + (size_t)c * (size_t)hw;
        const float m = (c < 3) ? kDoctrMean[c] : 0.0f;
        const float s = (c < 3) ? kDoctrStd[c]  : 1.0f;
        const float inv_s = 1.0f / s;
        for (int i = 0; i < hw; ++i) {
            row[i] = (row[i] - m) * inv_s;
        }
    }
}

/* Bilinear sample of an RGB8 image at fractional (sy, sx). Returns the
 * three channel values in out[0..2] (range [0,1]). */
static inline void sample_rgb_bilinear(
    const uint8_t *rgb, int src_w, int src_h, float sy, float sx, float out[3])
{
    if (sx < 0) sx = 0; if (sx > src_w - 1) sx = (float)(src_w - 1);
    if (sy < 0) sy = 0; if (sy > src_h - 1) sy = (float)(src_h - 1);
    int x0 = (int)floorf(sx); int y0 = (int)floorf(sy);
    int x1 = x0 + 1 < src_w ? x0 + 1 : x0;
    int y1 = y0 + 1 < src_h ? y0 + 1 : y0;
    float fx = sx - (float)x0;
    float fy = sy - (float)y0;
    const uint8_t *p00 = rgb + (size_t)((y0 * src_w + x0) * 3);
    const uint8_t *p01 = rgb + (size_t)((y0 * src_w + x1) * 3);
    const uint8_t *p10 = rgb + (size_t)((y1 * src_w + x0) * 3);
    const uint8_t *p11 = rgb + (size_t)((y1 * src_w + x1) * 3);
    for (int c = 0; c < 3; ++c) {
        float a = (float)p00[c] * (1.0f - fx) + (float)p01[c] * fx;
        float b = (float)p10[c] * (1.0f - fx) + (float)p11[c] * fx;
        out[c] = (a * (1.0f - fy) + b * fy) * (1.0f / 255.0f);
    }
}

int doctr_letterbox_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h,
    float *out_chw, int target_size,
    int *scaled_w, int *scaled_h)
{
    if (!rgb || !out_chw || src_w <= 0 || src_h <= 0 || target_size <= 0) {
        return -EINVAL;
    }
    /* Determine scale to fit longest edge to target_size. doctr uses
     * "preserve aspect, pad with zeros at top-left fixed" — the new
     * image is glued to (0,0) and the bottom-right is zero-padded. */
    float scale = (src_w >= src_h)
        ? (float)target_size / (float)src_w
        : (float)target_size / (float)src_h;
    int sw = (int)(src_w * scale + 0.5f);
    int sh = (int)(src_h * scale + 0.5f);
    if (sw > target_size) sw = target_size;
    if (sh > target_size) sh = target_size;
    if (sw < 1) sw = 1;
    if (sh < 1) sh = 1;
    if (scaled_w) *scaled_w = sw;
    if (scaled_h) *scaled_h = sh;

    const int hw = target_size * target_size;
    /* Zero out the canvas first (cheap; ensures pad regions are 0). */
    memset(out_chw, 0, sizeof(float) * 3 * (size_t)hw);

    const float inv_scale = 1.0f / scale;
    for (int y = 0; y < sh; ++y) {
        const float sy = (float)y * inv_scale;
        for (int x = 0; x < sw; ++x) {
            const float sx = (float)x * inv_scale;
            float rgb_f[3];
            sample_rgb_bilinear(rgb, src_w, src_h, sy, sx, rgb_f);
            for (int c = 0; c < 3; ++c) {
                out_chw[(size_t)c * hw + (size_t)y * target_size + x] = rgb_f[c];
            }
        }
    }

    /* Apply doctr ImageNet normalization on the *whole* canvas; the
     * pad region becomes -mean/std which is fine — the detector treats
     * that as background. */
    doctr_normalize_imagenet_inplace(out_chw, 3, hw);
    return 0;
}

int doctr_resize_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h,
    float *out_chw, int target_h, int target_w)
{
    if (!rgb || !out_chw || src_w <= 0 || src_h <= 0 || target_h <= 0 || target_w <= 0) {
        return -EINVAL;
    }
    const int hw = target_h * target_w;
    /* Plain bilinear stretch — recognizer crops have already been
     * sized to height-32 by the caller (per the C ABI doc on
     * doctr_recognize_word). */
    const float sy_scale = (float)src_h / (float)target_h;
    const float sx_scale = (float)src_w / (float)target_w;
    for (int y = 0; y < target_h; ++y) {
        const float sy = ((float)y + 0.5f) * sy_scale - 0.5f;
        for (int x = 0; x < target_w; ++x) {
            const float sx = ((float)x + 0.5f) * sx_scale - 0.5f;
            float rgb_f[3];
            sample_rgb_bilinear(rgb, src_w, src_h, sy, sx, rgb_f);
            for (int c = 0; c < 3; ++c) {
                out_chw[(size_t)c * hw + (size_t)y * target_w + x] = rgb_f[c];
            }
        }
    }
    doctr_normalize_imagenet_inplace(out_chw, 3, hw);
    return 0;
}
