/*
 * Letterbox + RGB-to-CHW-fp32 preprocessing for YOLOv8 / YOLOv11.
 *
 * Mirrors Ultralytics' default preprocessing pipeline:
 *   - bilinear resize so the longest edge fits ``target_size`` while
 *     preserving aspect ratio,
 *   - center-pad the short edge with neutral grey (114, 114, 114),
 *   - normalize uint8 RGB to fp32 in [0, 1],
 *   - write CHW (channel-major) float plane sized 3 * target * target.
 *
 * The function reports the scale + per-edge pad it used so callers can
 * un-letterbox detection bboxes back to source-image coordinates.
 *
 * No SIMD; pure scalar reference. Phase 3 may swap in a NEON/AVX path.
 */

#include "yolo_internal.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static inline void sample_rgb_bilinear(
    const uint8_t *rgb, int src_stride_bytes, int src_w, int src_h,
    float sy, float sx, float out[3])
{
    if (sx < 0)            sx = 0;
    if (sx > src_w - 1)    sx = (float)(src_w - 1);
    if (sy < 0)            sy = 0;
    if (sy > src_h - 1)    sy = (float)(src_h - 1);
    int x0 = (int)floorf(sx);
    int y0 = (int)floorf(sy);
    int x1 = x0 + 1 < src_w ? x0 + 1 : x0;
    int y1 = y0 + 1 < src_h ? y0 + 1 : y0;
    float fx = sx - (float)x0;
    float fy = sy - (float)y0;
    const uint8_t *p00 = rgb + (size_t)y0 * src_stride_bytes + (size_t)x0 * 3;
    const uint8_t *p01 = rgb + (size_t)y0 * src_stride_bytes + (size_t)x1 * 3;
    const uint8_t *p10 = rgb + (size_t)y1 * src_stride_bytes + (size_t)x0 * 3;
    const uint8_t *p11 = rgb + (size_t)y1 * src_stride_bytes + (size_t)x1 * 3;
    for (int c = 0; c < 3; ++c) {
        float a = (float)p00[c] * (1.0f - fx) + (float)p01[c] * fx;
        float b = (float)p10[c] * (1.0f - fx) + (float)p11[c] * fx;
        out[c] = (a * (1.0f - fy) + b * fy) * (1.0f / 255.0f);
    }
}

int yolo_letterbox_rgb_to_chw(
    const yolo_image *img, int target_size,
    float *out_chw,
    float *out_scale, int *out_pad_w, int *out_pad_h)
{
    if (!img || !img->rgb || !out_chw || target_size <= 0) return -EINVAL;
    if (img->w <= 0 || img->h <= 0) return -EINVAL;

    /* If stride <= 0 the caller is asking for tightly packed; default
     * to 3*w. Otherwise stride is bytes per row. */
    const int stride = img->stride > 0 ? img->stride : img->w * 3;

    const float scale = fminf(
        (float)target_size / (float)img->w,
        (float)target_size / (float)img->h);
    const int new_w = (int)(img->w * scale + 0.5f);
    const int new_h = (int)(img->h * scale + 0.5f);
    const int pad_w = (target_size - new_w) / 2;
    const int pad_h = (target_size - new_h) / 2;

    if (out_scale) *out_scale = scale;
    if (out_pad_w) *out_pad_w = pad_w;
    if (out_pad_h) *out_pad_h = pad_h;

    /* Fill with neutral grey 114/255 (Ultralytics default). */
    const float pad_val = 114.0f / 255.0f;
    const int hw = target_size * target_size;
    for (int c = 0; c < 3; ++c) {
        float *plane = out_chw + (size_t)c * hw;
        for (int i = 0; i < hw; ++i) plane[i] = pad_val;
    }

    /* Inverse mapping: dst (y, x) ← src (sy, sx) where
     *   sx = (x - pad_w + 0.5) / scale - 0.5
     *   sy = (y - pad_h + 0.5) / scale - 0.5
     * Pixel center convention (PIL/cv2). */
    const float inv_scale = 1.0f / scale;
    for (int dy = 0; dy < new_h; ++dy) {
        const int y = dy + pad_h;
        const float sy = ((float)dy + 0.5f) * inv_scale - 0.5f;
        for (int dx = 0; dx < new_w; ++dx) {
            const int x = dx + pad_w;
            const float sx = ((float)dx + 0.5f) * inv_scale - 0.5f;
            float rgb_f[3];
            sample_rgb_bilinear(img->rgb, stride, img->w, img->h, sy, sx, rgb_f);
            for (int c = 0; c < 3; ++c) {
                out_chw[(size_t)c * hw + (size_t)y * target_size + x] = rgb_f[c];
            }
        }
    }

    return 0;
}
