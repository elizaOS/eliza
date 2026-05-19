/*
 * yolo-cpp — public C ABI for the standalone native plugin that ports
 * Ultralytics YOLOv8n / YOLOv11n object detection to the
 * elizaOS/llama.cpp fork's ggml dispatcher.
 *
 * Upstream:
 *   https://github.com/ultralytics/ultralytics
 *
 * This header is the *interface* that the eventual ggml-backed
 * implementation must satisfy. The companion stub in
 * `src/yolo_stub.c` returns ENOSYS for every entry point so callers
 * can compile and link against this library while the real port lands.
 *
 * One head is exposed:
 *   1. yolov8n / yolov11n — COCO-pretrained 80-class object detector.
 *      Input is an RGB image plane; output is a list of axis-aligned
 *      bboxes (centre + width/height in source-image absolute pixel
 *      coordinates), per-detection confidence, and COCO class id.
 *
 * Coordinate convention: every detection is `{x, y, width, height}`
 * in source-image absolute pixel coordinates (the library
 * un-letterboxes before returning). `(x, y)` is the bbox top-left.
 *
 * Threading: every entry point is reentrant against distinct
 * `yolo_handle` values. Sharing one handle across threads requires
 * the caller's own mutex.
 *
 * Error handling: all entry points return `int` — zero on success,
 * negative `errno`-style codes on failure. The stub returns `-ENOSYS`
 * so callers can probe for "real" availability with a single call.
 */

#ifndef YOLO_YOLO_H
#define YOLO_YOLO_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Pinned model variants this header is dimensioned around. The GGUF
 * conversion script (`scripts/yolo_to_gguf.py`) emits artifacts that
 * declare these as their `yolo.detector` key. The decoder refuses to
 * load a GGUF whose tag is not one of these. */
#define YOLO_DETECTOR_YOLOV8N   "yolov8n"
#define YOLO_DETECTOR_YOLOV11N  "yolov11n"

/* Input letterbox dim used by both yolov8n and yolov11n (square). */
#define YOLO_INPUT_SIZE         640

/* COCO 80-class output (class_id range is [0, YOLO_NUM_CLASSES)). */
#define YOLO_NUM_CLASSES        80

/*
 * Detection record. Coordinates are in source-image absolute pixels;
 * `(x, y)` is the bbox top-left and `(w, h)` are the bbox dimensions.
 * `class_id` is in [0, YOLO_NUM_CLASSES); `confidence` is in [0, 1].
 */
typedef struct yolo_detection {
    float x;
    float y;
    float w;
    float h;
    float confidence;
    int   class_id;
} yolo_detection;

/*
 * Detection input is a contiguous RGB plane, 8 bits per channel.
 * `stride` is the byte distance between consecutive rows; for tightly
 * packed images that is `w * 3`. Allowing a separate stride lets
 * callers feed sub-rectangles of a larger frame buffer without copy.
 */
typedef struct yolo_image {
    uint8_t *rgb;
    int      w;
    int      h;
    int      stride;
} yolo_image;

/* Opaque handle. The implementation will hold the loaded ggml graph,
 * scratch buffers, and any pinned tensors. */
typedef struct yolo_session *yolo_handle;

/* ---------------- session lifecycle ---------------- */

/*
 * Open a session against a YOLO GGUF file produced by
 * `scripts/yolo_to_gguf.py`. The GGUF must declare its `yolo.detector`
 * key as one of the pinned variants above. Returns 0 on success and
 * writes the new handle into `*out`. Returns `-ENOSYS` from the stub,
 * `-ENOENT` for missing GGUF, `-EINVAL` for shape/version mismatch.
 */
int yolo_open(const char *gguf_path, yolo_handle *out);

/*
 * Run detection over `img` and write up to `out_cap` detections into
 * `out`. The library writes the actual count into `*out_count`.
 *
 *   - `conf_threshold` filters candidates by max-class confidence
 *     before NMS (e.g. 0.25).
 *   - `iou_threshold` is the NMS IoU cutoff (e.g. 0.45).
 *
 * Returns 0 on success, `-ENOSPC` if the buffer was too small for the
 * detected box count (the caller should re-call with a bigger buffer;
 * `*out_count` then carries the required size).
 */
int yolo_detect(yolo_handle h,
                const yolo_image *img,
                float conf_threshold,
                float iou_threshold,
                yolo_detection *out,
                size_t out_cap,
                size_t *out_count);

/* Release a session. Safe to call on a NULL handle. */
int yolo_close(yolo_handle h);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend, e.g. "ggml-cpu",
 * "ggml-vulkan", "ggml-metal", "stub". Reflects the *runtime*-selected
 * path. The stub returns "stub".
 */
const char *yolo_active_backend(void);

/*
 * Return the COCO-80 class name for `class_id`, or NULL if the id is
 * out of range. The returned pointer is a static string with program
 * lifetime; the caller does not free it.
 *
 *   yolo_class_name(0)  == "person"
 *   yolo_class_name(79) == "toothbrush"
 *   yolo_class_name(-1) == NULL
 *   yolo_class_name(80) == NULL
 */
const char *yolo_class_name(int class_id);

#ifdef __cplusplus
}
#endif

#endif /* YOLO_YOLO_H */
