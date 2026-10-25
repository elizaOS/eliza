/**
 * Applies confidence-ordered hard suppression to single-class face detections.
 *
 * The operation compacts records in place without changing the bounding box,
 * confidence, or landmark data of retained detections. A candidate is removed
 * only when its intersection-over-union with an earlier, higher-confidence
 * detection exceeds the caller-provided threshold.
 */

#include "face_internal.h"
#include "face/face.h"

#include <stddef.h>
#include <string.h>

static float iou(const face_detection *a, const face_detection *b) {
    const float ax2 = a->x + a->w;
    const float ay2 = a->y + a->h;
    const float bx2 = b->x + b->w;
    const float by2 = b->y + b->h;

    const float ix1 = a->x > b->x ? a->x : b->x;
    const float iy1 = a->y > b->y ? a->y : b->y;
    const float ix2 = ax2 < bx2 ? ax2 : bx2;
    const float iy2 = ay2 < by2 ? ay2 : by2;

    if (ix2 <= ix1 || iy2 <= iy1) return 0.0f;
    const float inter = (ix2 - ix1) * (iy2 - iy1);
    const float area_a = a->w * a->h;
    const float area_b = b->w * b->h;
    const float uni = area_a + area_b - inter;
    if (uni <= 0.0f) return 0.0f;
    return inter / uni;
}

/* Insertion sort by descending confidence. n is small in practice
 * (post-threshold candidate counts on a 128x128 BlazeFace input are at
 * most a few dozen). */
static void sort_by_confidence_desc(face_detection *dets, size_t n) {
    for (size_t i = 1; i < n; ++i) {
        face_detection key = dets[i];
        size_t j = i;
        while (j > 0 && dets[j - 1].confidence < key.confidence) {
            dets[j] = dets[j - 1];
            --j;
        }
        dets[j] = key;
    }
}

size_t face_nms_inplace(face_detection *dets, size_t n, float iou_thresh) {
    if (dets == NULL || n == 0) return 0;

    sort_by_confidence_desc(dets, n);

    size_t kept = 0;
    for (size_t i = 0; i < n; ++i) {
        const face_detection *cand = &dets[i];
        int suppress = 0;
        for (size_t k = 0; k < kept; ++k) {
            if (iou(&dets[k], cand) > iou_thresh) {
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
