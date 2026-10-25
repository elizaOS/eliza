/*
 * face_anchor_decode.c — BlazeFace anchor generation + raw-output
 * decoding. Real implementation, model-independent (only depends on
 * the BlazeFace front-model architecture / output layout).
 *
 * Reference: Bazarevsky et al., "BlazeFace: Sub-millisecond Neural
 * Face Detection on Mobile GPUs", arXiv:1907.05047. The anchor
 * schedule mirrors the canonical
 *   mediapipe/modules/face_detection/face_detection_front.pbtxt
 * configuration:
 *   input_size_height        = 128
 *   input_size_width         = 128
 *   anchor_offset_x          = 0.5
 *   anchor_offset_y          = 0.5
 *   strides                  = [8, 16]
 *   num_layers               = 2
 *   aspect_ratios            = [1.0]
 *   fixed_anchor_size        = true
 *   interpolated_scale_aspect_ratio = 1.0
 *   anchors_per_cell (per stride) = [2, 6]   # MediaPipe's
 *                                            # interpolation-aware count
 *
 * Total: 16*16*2 + 8*8*6 = 512 + 384 = 896 anchors, exactly
 * FACE_DETECTOR_ANCHOR_COUNT.
 *
 * Coordinates are in normalized [0, 1] relative to the 128x128 input.
 * Anchor `(w, h)` is fixed at 1 ("fixed_anchor_size = true"); the
 * regressor's bbox-size outputs are absolute input-pixel scales, not
 * deltas multiplied into anchor size.
 */

#include "face/face.h"

#include <errno.h>
#include <math.h>
#include <stddef.h>

/* BlazeFace front-model anchor schedule. */
#define BF_NUM_LAYERS 2

static const int s_strides[BF_NUM_LAYERS] = { 8, 16 };
static const int s_anchors_per_cell[BF_NUM_LAYERS] = { 2, 6 };

static int generate_anchors(face_blazeface_anchor *out, size_t cap) {
    const int input_size = FACE_DETECTOR_INPUT_SIZE;
    const float anchor_offset_x = 0.5f;
    const float anchor_offset_y = 0.5f;

    size_t k = 0;
    for (int layer = 0; layer < BF_NUM_LAYERS; ++layer) {
        const int stride = s_strides[layer];
        const int per_cell = s_anchors_per_cell[layer];
        const int feature_map_size = input_size / stride;

        for (int y = 0; y < feature_map_size; ++y) {
            for (int x = 0; x < feature_map_size; ++x) {
                const float x_center =
                    ((float)x + anchor_offset_x) / (float)feature_map_size;
                const float y_center =
                    ((float)y + anchor_offset_y) / (float)feature_map_size;
                for (int a = 0; a < per_cell; ++a) {
                    if (k >= cap) return -ENOSPC;
                    out[k].x_center = x_center;
                    out[k].y_center = y_center;
                    out[k].w = 1.0f;
                    out[k].h = 1.0f;
                    ++k;
                }
            }
        }
    }
    return (int)k;
}

int face_blazeface_make_anchors(face_blazeface_anchor *out, size_t cap) {
    if (!out) return -EINVAL;
    if (cap < (size_t)FACE_DETECTOR_ANCHOR_COUNT) return -ENOSPC;

    const int written = generate_anchors(out, cap);
    if (written < 0) return written;
    if (written != FACE_DETECTOR_ANCHOR_COUNT) {
        /* Internal invariant — schedule constants disagree with the
         * compile-time anchor count. Refuse silently-wrong output. */
        return -EINVAL;
    }
    return written;
}

static float sigmoidf(float x) {
    /* Standard sigmoid; clamp the input range for numerical stability
     * the same way MediaPipe's BlazeFace decoder does. */
    if (x < -50.0f) return 0.0f;
    if (x >  50.0f) return 1.0f;
    return 1.0f / (1.0f + expf(-x));
}

int face_blazeface_decode(const face_blazeface_anchor *anchors,
                          const float *regressors,
                          const float *scores,
                          float conf,
                          int src_w,
                          int src_h,
                          face_detection *out,
                          size_t cap,
                          size_t *count) {
    if (!anchors || !regressors || !scores || !out || !count) return -EINVAL;
    if (src_w <= 0 || src_h <= 0) return -EINVAL;

    *count = 0;

    const float input_size = (float)FACE_DETECTOR_INPUT_SIZE;
    const float sx = (float)src_w / input_size;
    const float sy = (float)src_h / input_size;

    /* Per-anchor regressor stride: 4 bbox + 6 keypoint pairs = 16. */
    const int regressor_stride = 4 + 2 * FACE_DETECTOR_KEYPOINT_COUNT;

    int overflow = 0;
    size_t kept = 0;

    for (int i = 0; i < FACE_DETECTOR_ANCHOR_COUNT; ++i) {
        const float score = sigmoidf(scores[i]);
        if (score < conf) continue;

        const float *r = regressors + (size_t)i * (size_t)regressor_stride;
        const face_blazeface_anchor *a = &anchors[i];

        /* MediaPipe convention: regressor outputs are in input-pixel
         * units (not normalized), and bbox center is anchor_center +
         * delta / input_size. Width/height are delta / input_size with
         * fixed_anchor_size=true. */
        const float x_center = r[0] / input_size + a->x_center;
        const float y_center = r[1] / input_size + a->y_center;
        const float w        = r[2] / input_size;  /* anchor w == 1 */
        const float h        = r[3] / input_size;

        const float x = (x_center - 0.5f * w) * (float)src_w;
        const float y = (y_center - 0.5f * h) * (float)src_h;
        const float ww = w * (float)src_w;
        const float hh = h * (float)src_h;

        if (kept >= cap) { overflow = 1; ++kept; continue; }

        face_detection *d = &out[kept];
        d->x = x;
        d->y = y;
        d->w = ww;
        d->h = hh;
        d->confidence = score;

        for (int kp = 0; kp < FACE_DETECTOR_KEYPOINT_COUNT; ++kp) {
            const float kx = r[4 + kp * 2 + 0] / input_size + a->x_center;
            const float ky = r[4 + kp * 2 + 1] / input_size + a->y_center;
            d->landmarks[kp * 2 + 0] = kx * (float)src_w;
            d->landmarks[kp * 2 + 1] = ky * (float)src_h;
        }

        ++kept;
    }

    *count = kept;
    /* Suppress unused-variable warnings on builds where sx/sy aren't
     * read directly. The values are folded into src_w/src_h above. */
    (void)sx;
    (void)sy;
    return overflow ? -ENOSPC : 0;
}
