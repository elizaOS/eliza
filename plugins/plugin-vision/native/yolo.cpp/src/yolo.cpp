// yolo.cpp — YOLOv8 forward pass via ggml.
//
// SCAFFOLD: matches the structure of doctr_det.cpp. Pins the API + graph
// outline; the actual conv/bn/silu/upsample wiring lands once the GGUF
// conversion script is run on a build host and we can verify the tensor
// names match what we expect.
//
// The C side runs only the CNN forward pass. Preprocessing (letterbox + RGB
// CHW normalize), output decode (cxcywh + per-class score → axis-aligned
// bbox + class id + score), and NMS all stay in TypeScript (see
// `plugins/plugin-vision/src/yolo-detector.ts`).

#include "yolo.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if defined(YOLO_HAVE_GGML)
#  include "ggml.h"
#  include "ggml-backend.h"
#endif

struct yolo_ctx {
    std::string gguf_path;
    std::string classes;
    std::string variant;
    int   input_h = 640;
    int   input_w = 640;
    int   strides[3] = {8, 16, 32};

#if defined(YOLO_HAVE_GGML)
    struct ggml_context  * gctx   = nullptr;
    ggml_backend_t         backend = nullptr;
    struct ggml_cgraph   * graph  = nullptr;
#endif
};

extern "C" yolo_ctx * yolo_init(const char * gguf_path) {
    if (!gguf_path) return nullptr;
    auto * ctx = new (std::nothrow) yolo_ctx();
    if (!ctx) return nullptr;
    ctx->gguf_path = gguf_path;

#if defined(YOLO_HAVE_GGML)
    // 1. gguf_init_from_file → read variant / input dims / classes / strides
    // 2. Allocate ggml context and load conv/bn/linear params per the
    //    YOLOv8 topology (24 conv blocks + 3 detection heads).
    // 3. Build cgraph for the forward pass.
    fprintf(stderr,
            "[yolo] init called for %s — GGML path not yet wired; weights must be built first.\n",
            gguf_path);
    delete ctx;
    return nullptr;
#else
    fprintf(stderr, "[yolo] built without YOLO_HAVE_GGML — weights cannot load.\n");
    delete ctx;
    return nullptr;
#endif
}

extern "C" int yolo_run(yolo_ctx * ctx,
                        const float * rgb_chw,
                        int h, int w,
                        float * out_logits,
                        int * out_channels,
                        int * out_anchors) {
    if (!ctx || !rgb_chw || !out_logits || !out_channels || !out_anchors) {
        return YOLO_ERR_SHAPE;
    }
    if (h != ctx->input_h || w != ctx->input_w) return YOLO_ERR_SHAPE;

#if defined(YOLO_HAVE_GGML)
    // Forward pass produces (1, 4+num_classes, num_anchors).
    // num_anchors = (input_h/8)² + (input_h/16)² + (input_h/32)² = 8400 for 640x640.
    *out_channels = 0;
    *out_anchors  = 0;
    std::memset(out_logits, 0, 0);
    return YOLO_ERR_BACKEND;
#else
    *out_channels = 0;
    *out_anchors = 0;
    return YOLO_ERR_BACKEND;
#endif
}

extern "C" const char * yolo_classes(yolo_ctx * ctx) {
    return ctx ? ctx->classes.c_str() : nullptr;
}

extern "C" void yolo_free(yolo_ctx * ctx) {
    if (!ctx) return;
#if defined(YOLO_HAVE_GGML)
    if (ctx->gctx)    ggml_free(ctx->gctx);
    if (ctx->backend) ggml_backend_free(ctx->backend);
#endif
    delete ctx;
}
