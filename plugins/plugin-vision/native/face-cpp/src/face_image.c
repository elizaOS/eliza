/*
 * face_image.c — image preprocessing for face-cpp.
 *
 * Bilinear resize from RGB8 (HWC) to CHW float, plus per-channel
 * affine normalization.
 */

#include "face_internal.h"

#include <errno.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int clampi(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

int face_resize_rgb_to_chw(
    const uint8_t *rgb, int src_w, int src_h, int src_stride,
    float *out_chw, int target_h, int target_w)
{
    if (!rgb || !out_chw) return -EINVAL;
    if (src_w <= 0 || src_h <= 0 || target_h <= 0 || target_w <= 0) return -EINVAL;
    if (src_stride < src_w * 3) return -EINVAL;

    /* PIL/OpenCV-style bilinear with corner alignment via
     * scale = (src - 1) / (target - 1) when target > 1, else 0. */
    const float sx = target_w > 1 ? (float)(src_w - 1) / (float)(target_w - 1) : 0.0f;
    const float sy = target_h > 1 ? (float)(src_h - 1) / (float)(target_h - 1) : 0.0f;

    const int ch_stride = target_h * target_w;

    for (int y = 0; y < target_h; ++y) {
        const float fy = (float)y * sy;
        const int y0 = (int)floorf(fy);
        const int y1 = y0 + 1;
        const float ay = fy - (float)y0;
        const int yc0 = clampi(y0, 0, src_h - 1);
        const int yc1 = clampi(y1, 0, src_h - 1);

        for (int x = 0; x < target_w; ++x) {
            const float fx = (float)x * sx;
            const int x0 = (int)floorf(fx);
            const int x1 = x0 + 1;
            const float ax = fx - (float)x0;
            const int xc0 = clampi(x0, 0, src_w - 1);
            const int xc1 = clampi(x1, 0, src_w - 1);

            for (int c = 0; c < 3; ++c) {
                const uint8_t p00 = rgb[(size_t)yc0 * (size_t)src_stride + (size_t)xc0 * 3 + (size_t)c];
                const uint8_t p10 = rgb[(size_t)yc0 * (size_t)src_stride + (size_t)xc1 * 3 + (size_t)c];
                const uint8_t p01 = rgb[(size_t)yc1 * (size_t)src_stride + (size_t)xc0 * 3 + (size_t)c];
                const uint8_t p11 = rgb[(size_t)yc1 * (size_t)src_stride + (size_t)xc1 * 3 + (size_t)c];

                const float top    = (1.0f - ax) * (float)p00 + ax * (float)p10;
                const float bottom = (1.0f - ax) * (float)p01 + ax * (float)p11;
                const float v      = (1.0f - ay) * top + ay * bottom;
                out_chw[(size_t)c * (size_t)ch_stride + (size_t)y * (size_t)target_w + (size_t)x] = v;
            }
        }
    }
    return 0;
}

void face_normalize_chw_inplace(
    float *plane, int channels, int hw,
    const float mean[3], const float std[3])
{
    for (int c = 0; c < channels; ++c) {
        const float m = mean[c];
        const float s = std[c];
        const float inv = (s != 0.0f) ? (1.0f / s) : 1.0f;
        float *p = plane + (size_t)c * (size_t)hw;
        for (int i = 0; i < hw; ++i) {
            p[i] = (p[i] - m) * inv;
        }
    }
}
