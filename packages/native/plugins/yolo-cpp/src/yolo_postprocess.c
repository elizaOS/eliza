/*
 * YOLOv8 / YOLOv11 decoupled-head postprocessing.
 *
 * Both heads emit, per anchor cell, 4 + num_classes channels:
 *   - channels[0..3]                 : cx, cy, w, h in input-image
 *                                      pixel coordinates (ggml's
 *                                      DFL+stride decode is folded
 *                                      into the conversion graph and
 *                                      already-decoded values are
 *                                      what arrives here).
 *   - channels[4..4+num_classes)     : per-class confidence in [0, 1]
 *                                      after sigmoid (also folded
 *                                      into the conversion graph).
 *
 * The decoupled head deliberately drops the legacy YOLOv5 objectness
 * channel; the per-class score IS the detection confidence.
 *
 * `channel_stride` lets this routine accept either layout that the
 * runtime might present:
 *   - per-anchor packed         (channels are at consecutive floats),
 *     stride = 1.
 *   - per-channel packed [C, A] (Ultralytics export default),
 *     stride = num_anchors.
 *
 * The Phase 2 ggml graph is responsible for ensuring `channels`
 * points at one anchor's data with the documented stride.
 */

#include "yolo/yolo.h"
#include "yolo_internal.h"

#include <stddef.h>

int yolo_decode_one(const float *channels,
                    size_t       channel_stride,
                    float        conf_threshold,
                    int          input_size,
                    float        scale,
                    int          pad_w,
                    int          pad_h,
                    yolo_detection *out) {
    if (channels == NULL || out == NULL || channel_stride == 0) {
        return 0;
    }

    const float cx = channels[0 * channel_stride];
    const float cy = channels[1 * channel_stride];
    const float w  = channels[2 * channel_stride];
    const float h  = channels[3 * channel_stride];

    int   best_id = -1;
    float best_score = 0.0f;
    for (int c = 0; c < YOLO_NUM_CLASSES; ++c) {
        const float v = channels[(4 + c) * channel_stride];
        if (v > best_score) {
            best_score = v;
            best_id = c;
        }
    }
    if (best_id < 0 || best_score < conf_threshold) {
        return 0;
    }

    /* Letterbox-undo: subtract the centre-pad, divide by the resize
     * scale to reach source-image pixel coordinates. The Phase 2 ggml
     * graph emits boxes already in input-image pixel coordinates
     * (i.e. scaled to `input_size`), so we subtract the pad and
     * divide by the scale used to fit the source into the input. */
    if (scale <= 0.0f) {
        return 0;
    }
    const float src_w = w / scale;
    const float src_h = h / scale;
    const float src_x = (cx - w * 0.5f - (float)pad_w) / scale;
    const float src_y = (cy - h * 0.5f - (float)pad_h) / scale;

    out->x          = src_x;
    out->y          = src_y;
    out->w          = src_w;
    out->h          = src_h;
    out->confidence = best_score;
    out->class_id   = best_id;

    /* `input_size` is unused at the decode step itself but is kept in
     * the signature so the Phase 2 graph can pass it through for
     * sanity checks / box clipping in a follow-up patch. */
    (void)input_size;
    return 1;
}
