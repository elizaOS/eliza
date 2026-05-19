/*
 * Non-max suppression for YOLO detection output.
 *
 * Pure-C reference implementation. Operates on `yolo_detection`
 * records in place — sorts by descending confidence and rejects
 * boxes whose IoU against any already-kept box of the same class
 * exceeds `iou_threshold`.
 *
 * The classic YOLO contract is per-class NMS: two boxes of different
 * classes never suppress each other. This matches Ultralytics'
 * `non_max_suppression` (when `agnostic=False`, the default) and the
 * behaviour of the original `YOLODetector` TS implementation that
 * this library replaces.
 *
 * This TU is independent of ggml — it ports as-is into the Phase 2
 * implementation. The Phase 1 stub `yolo_detect` does NOT call this;
 * it returns `-ENOSYS` before any postprocessing. NMS is exposed to
 * tests through the internal header below so the algorithm can be
 * verified ahead of the ggml graph landing.
 */

#include "yolo/yolo.h"
#include "yolo_internal.h"

#include <stddef.h>

static float iou(const yolo_detection *a, const yolo_detection *b) {
    const float ax2 = a->x + a->w;
    const float ay2 = a->y + a->h;
    const float bx2 = b->x + b->w;
    const float by2 = b->y + b->h;

    const float ix1 = a->x > b->x ? a->x : b->x;
    const float iy1 = a->y > b->y ? a->y : b->y;
    const float ix2 = ax2 < bx2 ? ax2 : bx2;
    const float iy2 = ay2 < by2 ? ay2 : by2;

    if (ix2 <= ix1 || iy2 <= iy1) {
        return 0.0f;
    }
    const float inter = (ix2 - ix1) * (iy2 - iy1);
    const float area_a = a->w * a->h;
    const float area_b = b->w * b->h;
    const float uni = area_a + area_b - inter;
    if (uni <= 0.0f) {
        return 0.0f;
    }
    return inter / uni;
}

/* In-place insertion sort by descending confidence. n is small in
 * practice (post-threshold candidate counts are well under 1k for
 * typical 640x640 inputs) so quadratic worst case is fine. */
static void sort_by_confidence_desc(yolo_detection *dets, size_t n) {
    for (size_t i = 1; i < n; ++i) {
        yolo_detection key = dets[i];
        size_t j = i;
        while (j > 0 && dets[j - 1].confidence < key.confidence) {
            dets[j] = dets[j - 1];
            --j;
        }
        dets[j] = key;
    }
}

size_t yolo_nms_inplace(yolo_detection *dets,
                        size_t n,
                        float iou_threshold) {
    if (dets == NULL || n == 0) {
        return 0;
    }

    sort_by_confidence_desc(dets, n);

    /* `kept` is the count of survivors at the front of the array;
     * `i` walks the suppression candidates after that. */
    size_t kept = 0;
    for (size_t i = 0; i < n; ++i) {
        const yolo_detection *cand = &dets[i];
        int suppress = 0;
        for (size_t k = 0; k < kept; ++k) {
            const yolo_detection *anchor = &dets[k];
            if (anchor->class_id != cand->class_id) {
                continue;
            }
            if (iou(anchor, cand) > iou_threshold) {
                suppress = 1;
                break;
            }
        }
        if (!suppress) {
            if (kept != i) {
                dets[kept] = *cand;
            }
            ++kept;
        }
    }
    return kept;
}
