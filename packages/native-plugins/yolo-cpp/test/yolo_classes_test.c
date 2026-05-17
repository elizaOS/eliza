/*
 * Behavioural test for yolo_class_name.
 *
 * Verifies the COCO-80 ordering matches Ultralytics' canonical
 * mapping (the four corners of the array plus a NULL probe at the
 * out-of-range ends).
 */

#include "yolo/yolo.h"

#include <stdio.h>
#include <string.h>

#define EXPECT(cond, msg)                                              \
    do {                                                                \
        if (!(cond)) {                                                  \
            fprintf(stderr, "[yolo-classes] FAIL %s:%d %s\n",          \
                    __FILE__, __LINE__, msg);                          \
            ++failures;                                                 \
        }                                                               \
    } while (0)

int main(void) {
    int failures = 0;

    const char *zero = yolo_class_name(0);
    EXPECT(zero != NULL && strcmp(zero, "person") == 0,
           "class_id=0 is 'person'");

    const char *last = yolo_class_name(YOLO_NUM_CLASSES - 1);
    EXPECT(last != NULL && strcmp(last, "toothbrush") == 0,
           "class_id=79 is 'toothbrush'");

    EXPECT(yolo_class_name(-1) == NULL,
           "class_id=-1 returns NULL");
    EXPECT(yolo_class_name(YOLO_NUM_CLASSES) == NULL,
           "class_id=80 returns NULL");
    EXPECT(yolo_class_name(1024) == NULL,
           "far-out-of-range class_id returns NULL");

    /* Spot-check a couple of mid-range entries to catch off-by-one
     * regressions in the table: car=2, dog=16, laptop=63. */
    const char *car = yolo_class_name(2);
    EXPECT(car != NULL && strcmp(car, "car") == 0, "class_id=2 is 'car'");
    const char *dog = yolo_class_name(16);
    EXPECT(dog != NULL && strcmp(dog, "dog") == 0, "class_id=16 is 'dog'");
    const char *laptop = yolo_class_name(63);
    EXPECT(laptop != NULL && strcmp(laptop, "laptop") == 0,
           "class_id=63 is 'laptop'");

    printf("[yolo-classes] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
