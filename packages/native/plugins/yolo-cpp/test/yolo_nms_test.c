/*
 * Behavioural test for yolo_nms_inplace.
 *
 * Five synthetic detections cover the cases NMS must get right:
 *   D0 (person, 0.95) — top box of a tight cluster around (10, 10).
 *   D1 (person, 0.90) — heavy overlap with D0, same class. Suppressed.
 *   D2 (person, 0.80) — heavy overlap with D0, same class. Suppressed.
 *   D3 (car,    0.85) — heavy overlap with D0 IN GEOMETRY, but a
 *                       different class. Per-class NMS keeps it.
 *   D4 (person, 0.70) — disjoint geometry from D0. Kept.
 *
 * Expected survivors after NMS at iou=0.5: {D0, D3, D4}, in that
 * order (descending confidence — sort key is class-agnostic).
 */

#include "yolo/yolo.h"
#include "../src/yolo_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define EXPECT(cond, msg)                                              \
    do {                                                                \
        if (!(cond)) {                                                  \
            fprintf(stderr, "[yolo-nms] FAIL %s:%d %s\n",              \
                    __FILE__, __LINE__, msg);                          \
            ++failures;                                                 \
        }                                                               \
    } while (0)

static int float_eq(float a, float b) {
    return fabsf(a - b) < 1e-4f;
}

int main(void) {
    int failures = 0;

    /* Cluster centred on (10, 10), 20x20 box. Overlapping siblings
     * shifted by 2px -> IoU well above 0.5. D4 at (200, 200) is
     * disjoint. D3 colocated with D0 but a different class. */
    yolo_detection dets[5] = {
        { .x = 10.0f,  .y = 10.0f,  .w = 20.0f, .h = 20.0f,
          .confidence = 0.95f, .class_id = 0 /* person */ },
        { .x = 12.0f,  .y = 12.0f,  .w = 20.0f, .h = 20.0f,
          .confidence = 0.90f, .class_id = 0 /* person */ },
        { .x = 8.0f,   .y = 8.0f,   .w = 20.0f, .h = 20.0f,
          .confidence = 0.80f, .class_id = 0 /* person */ },
        { .x = 11.0f,  .y = 11.0f,  .w = 20.0f, .h = 20.0f,
          .confidence = 0.85f, .class_id = 2 /* car */ },
        { .x = 200.0f, .y = 200.0f, .w = 20.0f, .h = 20.0f,
          .confidence = 0.70f, .class_id = 0 /* person */ },
    };

    size_t kept = yolo_nms_inplace(dets, 5, 0.5f);

    EXPECT(kept == 3, "expected exactly three survivors");

    /* Sort key is descending confidence and is class-agnostic. So:
     *   dets[0] = D0 (person, 0.95)
     *   dets[1] = D3 (car,    0.85) — kept because cross-class
     *   dets[2] = D4 (person, 0.70) — kept because disjoint
     */
    EXPECT(float_eq(dets[0].confidence, 0.95f), "first survivor confidence");
    EXPECT(dets[0].class_id == 0,                "first survivor class");
    EXPECT(float_eq(dets[0].x, 10.0f),           "first survivor x");

    EXPECT(float_eq(dets[1].confidence, 0.85f), "second survivor confidence");
    EXPECT(dets[1].class_id == 2,                "second survivor class");

    EXPECT(float_eq(dets[2].confidence, 0.70f), "third survivor confidence");
    EXPECT(dets[2].class_id == 0,                "third survivor class");
    EXPECT(float_eq(dets[2].x, 200.0f),          "third survivor x");

    /* Edge cases. */
    EXPECT(yolo_nms_inplace(NULL, 0, 0.5f) == 0, "NULL input handled");
    yolo_detection lone = {
        .x = 0.0f, .y = 0.0f, .w = 10.0f, .h = 10.0f,
        .confidence = 0.5f, .class_id = 7,
    };
    EXPECT(yolo_nms_inplace(&lone, 1, 0.5f) == 1, "single det survives");

    printf("[yolo-nms] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
