// yolo.h — C ABI for the ggml-backed YOLOv8 runtime.
//
// Forward pass only — letterbox preprocessing, anchor-free decode, and NMS
// stay in TypeScript (they're trivial, runtime-portable, and identical
// across YOLO model variants). This C side runs only the CNN.

#ifndef YOLO_H
#define YOLO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct yolo_ctx yolo_ctx;

#define YOLO_OK            0
#define YOLO_ERR_FILE     -1
#define YOLO_ERR_FORMAT   -2
#define YOLO_ERR_OOM      -3
#define YOLO_ERR_SHAPE    -4
#define YOLO_ERR_BACKEND  -5

// Expected GGUF metadata:
//   - "yolo.variant"      = "yolov8n" | "yolov8s" | ...
//   - "yolo.input_h"      = int   (typical 640)
//   - "yolo.input_w"      = int   (typical 640)
//   - "yolo.classes"      = utf8 string (newline-separated, e.g. COCO 80)
//   - "yolo.strides"      = i32[3] (typical [8,16,32])
yolo_ctx * yolo_init(const char * gguf_path);

// rgb_chw: CHW float32 RGB normalized to [0,1] (caller letterboxed to input_h x input_w).
// out_logits: caller-allocated. Size must be (4 + num_classes) * num_anchors float32.
// out_channels, out_anchors filled by the call.
int yolo_run(yolo_ctx * ctx,
             const float * rgb_chw,
             int h, int w,
             float * out_logits,
             int * out_channels,
             int * out_anchors);

// Returns the embedded UTF-8 class-names string (newline-separated, owned by ctx).
const char * yolo_classes(yolo_ctx * ctx);

void yolo_free(yolo_ctx * ctx);

#ifdef __cplusplus
}
#endif

#endif // YOLO_H
