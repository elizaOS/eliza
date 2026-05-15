/*
 * yolo-cpp — ENOSYS stub for the session lifecycle and detect entry
 * points.
 *
 * This translation unit satisfies the C ABI declared in
 * `include/yolo/yolo.h` for the parts that depend on the ggml graph
 * (load, infer, release). It is intentionally separate from
 * `yolo_classes.c` (real today), `yolo_nms.c` (real today), and
 * `yolo_postprocess.c` (real today) — those land independently of the
 * graph and stay in their own TUs once the Phase 2 ggml backend
 * arrives. Every entry point here returns `-ENOSYS` so callers (the
 * `plugin-vision` ggml binding, the test in `test/`) link cleanly
 * while the real port lands.
 *
 * The port plan in `AGENTS.md` describes the replacement path:
 *   - `yolo_open`  loads a GGUF emitted by `scripts/yolo_to_gguf.py`,
 *                  builds the ggml graph for yolov8n / yolov11n,
 *                  pins scratch buffers.
 *   - `yolo_detect` letterboxes `img` to YOLO_INPUT_SIZE, runs the
 *                   graph, decodes per-anchor outputs through
 *                   `yolo_decode_one`, applies `yolo_nms_inplace`,
 *                   un-letterboxes, writes survivors to `out`.
 *   - `yolo_close` releases the graph, scratch buffers, and the GGUF
 *                  mapping.
 */

#include "yolo/yolo.h"

#include <errno.h>
#include <stddef.h>

int yolo_open(const char *gguf_path, yolo_handle *out) {
    (void)gguf_path;
    if (out) {
        *out = NULL;
    }
    return -ENOSYS;
}

int yolo_detect(yolo_handle h,
                const yolo_image *img,
                float conf_threshold,
                float iou_threshold,
                yolo_detection *out,
                size_t out_cap,
                size_t *out_count) {
    (void)h;
    (void)img;
    (void)conf_threshold;
    (void)iou_threshold;
    (void)out;
    (void)out_cap;
    if (out_count) {
        *out_count = 0;
    }
    return -ENOSYS;
}

int yolo_close(yolo_handle h) {
    (void)h;
    return 0;
}

const char *yolo_active_backend(void) {
    return "stub";
}
