// yolo.h — C ABI for the ggml-backed YOLOv8 runtime.
//
// Forward pass + DFL/anchor decode + class sigmoid. Letterbox preprocessing and
// the final threshold/NMS stay in TypeScript (src/yolo-detector.ts).

#ifndef YOLO_H
#define YOLO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Export macro so the C ABI symbols are visible to bun:ffi / dlopen. On MSVC,
// extern "C" functions in a DLL are NOT exported without __declspec(dllexport).
#ifndef YOLO_API
#  ifdef _WIN32
#    define YOLO_API __declspec(dllexport)
#  else
#    define YOLO_API __attribute__((visibility("default")))
#  endif
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
YOLO_API yolo_ctx * yolo_init(const char * gguf_path);

// rgb_chw: CHW float32 RGB normalized to [0,1] (caller letterboxed to input_h x input_w).
// out_logits: caller-allocated. Size must be (4 + num_classes) * num_anchors float32.
// out_channels, out_anchors filled by the call.
YOLO_API int yolo_run(yolo_ctx * ctx,
             const float * rgb_chw,
             int h, int w,
             float * out_logits,
             int * out_channels,
             int * out_anchors);

// Returns the embedded UTF-8 class-names string (newline-separated, owned by ctx).
YOLO_API const char * yolo_classes(yolo_ctx * ctx);

YOLO_API void yolo_free(yolo_ctx * ctx);

#ifdef __cplusplus
}
#endif

#endif // YOLO_H
