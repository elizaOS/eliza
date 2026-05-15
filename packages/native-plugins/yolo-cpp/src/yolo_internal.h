/*
 * Internal helpers shared between yolo-cpp translation units.
 *
 * Anything declared here is library-private; the public ABI lives in
 * `include/yolo/yolo.h`. We expose these to the in-tree tests so the
 * NMS and postprocess implementations can be exercised before the
 * Phase 2 ggml graph lands.
 */

#ifndef YOLO_INTERNAL_H
#define YOLO_INTERNAL_H

#include "yolo/yolo.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Per-class non-max suppression in place. Sorts `dets[0..n)` by
 * descending confidence, then walks the array discarding any
 * detection whose IoU against an already-kept detection of the same
 * class exceeds `iou_threshold`. Returns the count of survivors,
 * which occupy `dets[0..return)` in descending confidence order.
 *
 * Two boxes of different `class_id` never suppress each other; this
 * matches Ultralytics' default `non_max_suppression(agnostic=False)`
 * behaviour and the original TS YOLODetector contract.
 */
size_t yolo_nms_inplace(yolo_detection *dets,
                        size_t n,
                        float iou_threshold);

/*
 * Decode one YOLOv8/YOLOv11 raw output tensor row into a
 * `yolo_detection`. The decoupled head produces 4 + 80 channels per
 * grid cell: cx, cy, w, h, then 80 per-class scores. This helper
 * picks the argmax class, applies `conf_threshold`, and writes the
 * result into `out` if accepted.
 *
 * Returns 1 if a detection was written, 0 if rejected by threshold.
 *
 * Phase 1 note: the ggml graph that produces the raw tensor is still
 * a stub. This helper is unit-tested with synthetic input so the
 * decode logic is verified ahead of the real graph.
 */
int yolo_decode_one(const float *channels,   /* length 4 + YOLO_NUM_CLASSES */
                    size_t       channel_stride,
                    float        conf_threshold,
                    int          input_size,
                    float        scale,
                    int          pad_w,
                    int          pad_h,
                    yolo_detection *out);

#ifdef __cplusplus
}
#endif

#endif /* YOLO_INTERNAL_H */
