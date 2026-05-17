/*
 * COCO-80 class names — frozen ordering matches the Ultralytics
 * yolov8/yolov11 head's class index. The runtime returns these strings
 * from `yolo_class_name`; consumers use them to filter detections by
 * label (e.g. plugin-vision's `PersonDetector` keeps only `"person"`).
 *
 * The order is taken verbatim from the Ultralytics `coco.yaml` `names`
 * map (https://github.com/ultralytics/ultralytics blob
 * `ultralytics/cfg/datasets/coco.yaml`). Do not reorder.
 */

#include "yolo/yolo.h"

static const char *const COCO_CLASS_NAMES[YOLO_NUM_CLASSES] = {
    "person",         "bicycle",       "car",            "motorcycle",
    "airplane",       "bus",           "train",          "truck",
    "boat",           "traffic light", "fire hydrant",   "stop sign",
    "parking meter",  "bench",         "bird",           "cat",
    "dog",            "horse",         "sheep",          "cow",
    "elephant",       "bear",          "zebra",          "giraffe",
    "backpack",       "umbrella",      "handbag",        "tie",
    "suitcase",       "frisbee",       "skis",           "snowboard",
    "sports ball",    "kite",          "baseball bat",   "baseball glove",
    "skateboard",     "surfboard",     "tennis racket",  "bottle",
    "wine glass",     "cup",           "fork",           "knife",
    "spoon",          "bowl",          "banana",         "apple",
    "sandwich",       "orange",        "broccoli",       "carrot",
    "hot dog",        "pizza",         "donut",          "cake",
    "chair",          "couch",         "potted plant",   "bed",
    "dining table",   "toilet",        "tv",             "laptop",
    "mouse",          "remote",        "keyboard",       "cell phone",
    "microwave",      "oven",          "toaster",        "sink",
    "refrigerator",   "book",          "clock",          "vase",
    "scissors",       "teddy bear",    "hair drier",     "toothbrush",
};

const char *yolo_class_name(int class_id) {
    if (class_id < 0 || class_id >= YOLO_NUM_CLASSES) {
        return NULL;
    }
    return COCO_CLASS_NAMES[class_id];
}
