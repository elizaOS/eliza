// yolo.cpp — YOLOv8n forward pass via ggml.
//
// Implements the full YOLOv8 nano graph on ggml's CPU backend:
//   backbone (Conv / C2f / SPPF) → PAN-FPN neck → decoupled head (cv2 box + cv3 cls).
// The CNN runs in ggml; the cheap tail (DFL distribution decode, anchor/stride
// decode to pixel cx/cy/w/h, and class sigmoid) runs in plain C++ here so the
// emitted tensor is exactly what `src/yolo-detector.ts::parseYoloV8` expects:
//
//   out_logits laid out [channels=4+nc=84, anchors=8400], channel-major
//   (value(c,a) = out_logits[c*8400 + a]); rows 0..3 = cx,cy,w,h in 640x640
//   letterboxed input pixels; rows 4..83 = per-class probabilities (sigmoid).
//   Anchor order P3(6400) → P4(1600) → P5(400).
//
// Weights come from the GGUF written by scripts/convert.py: BatchNorm is folded
// into each conv at convert time, so every CBS conv is a plain conv weight+bias
// followed by SiLU; the head's stage-2 1x1 convs are plain conv+bias (no act).
// The DFL buffer is NOT stored — the expectation over reg_max=16 bins is
// computed directly below.

#include "yolo.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#if defined(YOLO_HAVE_GGML)
#  include "ggml.h"
#  include "ggml-alloc.h"
#  include "ggml-backend.h"
#  include "ggml-cpu.h"
#  include "gguf.h"
#endif

struct yolo_ctx {
    std::string gguf_path;
    std::string classes;
    int input_h = 640;
    int input_w = 640;

#if defined(YOLO_HAVE_GGML)
    ggml_backend_t        backend = nullptr;
    struct ggml_context * wctx    = nullptr;  // weights (named tensors, backend buffer)
    ggml_backend_buffer_t wbuf    = nullptr;
#endif
};

#if defined(YOLO_HAVE_GGML)

// ---- weight lookup ---------------------------------------------------------

static struct ggml_tensor * w_get(struct ggml_context * wc, const std::string & name) {
    struct ggml_tensor * t = ggml_get_tensor(wc, name.c_str());
    if (!t) {
        fprintf(stderr, "[yolo] missing tensor '%s'\n", name.c_str());
    }
    return t;
}

// ---- graph helpers ---------------------------------------------------------
//
// `g`  = compute-graph context (no_alloc); `wc` = weights context.
// A "CBS" conv = conv2d(stride) + per-channel bias + SiLU. Padding is derived
// from the kernel width (k3 -> 1, k1 -> 0). BN is already folded into w/b.

static struct ggml_tensor * conv_core(struct ggml_context * g, struct ggml_context * wc,
                                      struct ggml_tensor * x, const std::string & name,
                                      int stride) {
    struct ggml_tensor * w = w_get(wc, name + ".weight");
    struct ggml_tensor * b = w_get(wc, name + ".bias");
    if (!w || !b) return nullptr;
    const int pad = (int) (w->ne[0] / 2);  // ne[0] = KW
    struct ggml_tensor * y = ggml_conv_2d(g, w, x, stride, stride, pad, pad, 1, 1);
    // bias broadcast over [OW, OH, OC, N]
    y = ggml_add(g, y, ggml_reshape_4d(g, b, 1, 1, b->ne[0], 1));
    return y;
}

static struct ggml_tensor * conv_bn(struct ggml_context * g, struct ggml_context * wc,
                                    struct ggml_tensor * x, const std::string & name,
                                    int stride) {
    struct ggml_tensor * y = conv_core(g, wc, x, name, stride);
    if (!y) return nullptr;
    return ggml_silu(g, y);
}

static struct ggml_tensor * conv_plain(struct ggml_context * g, struct ggml_context * wc,
                                       struct ggml_tensor * x, const std::string & name,
                                       int stride) {
    return conv_core(g, wc, x, name, stride);  // no activation (head stage-2)
}

static struct ggml_tensor * bottleneck(struct ggml_context * g, struct ggml_context * wc,
                                       struct ggml_tensor * x, const std::string & prefix,
                                       bool add) {
    struct ggml_tensor * h = conv_bn(g, wc, x, prefix + ".cv1", 1);  // 3x3
    h = conv_bn(g, wc, h, prefix + ".cv2", 1);                       // 3x3
    if (!h) return nullptr;
    if (add) h = ggml_add(g, x, h);
    return h;
}

static struct ggml_tensor * c2f(struct ggml_context * g, struct ggml_context * wc,
                                struct ggml_tensor * x, const std::string & prefix,
                                int n, bool add) {
    struct ggml_tensor * y = conv_bn(g, wc, x, prefix + ".cv1", 1);  // 1x1 -> 2*hidden
    if (!y) return nullptr;
    const int64_t W = y->ne[0], H = y->ne[1];
    const int64_t hid = y->ne[2] / 2;

    // split channels into two halves; cont() so each is a clean conv input.
    struct ggml_tensor * y0 =
        ggml_cont(g, ggml_view_3d(g, y, W, H, hid, y->nb[1], y->nb[2], 0));
    struct ggml_tensor * y1 =
        ggml_cont(g, ggml_view_3d(g, y, W, H, hid, y->nb[1], y->nb[2], (size_t) hid * y->nb[2]));

    std::vector<struct ggml_tensor *> outs;
    outs.push_back(y0);
    outs.push_back(y1);
    struct ggml_tensor * prev = y1;
    for (int j = 0; j < n; j++) {
        prev = bottleneck(g, wc, prev, prefix + ".m." + std::to_string(j), add);
        if (!prev) return nullptr;
        outs.push_back(prev);
    }
    struct ggml_tensor * acc = outs[0];
    for (size_t k = 1; k < outs.size(); k++) {
        acc = ggml_concat(g, acc, outs[k], 2);  // concat on channels
    }
    return conv_bn(g, wc, acc, prefix + ".cv2", 1);  // 1x1 fuse -> c_out
}

static struct ggml_tensor * sppf(struct ggml_context * g, struct ggml_context * wc,
                                 struct ggml_tensor * x, const std::string & prefix) {
    struct ggml_tensor * c = conv_bn(g, wc, x, prefix + ".cv1", 1);  // 1x1 -> c_
    if (!c) return nullptr;
    struct ggml_tensor * m1 = ggml_pool_2d(g, c, GGML_OP_POOL_MAX, 5, 5, 1, 1, 2.0f, 2.0f);
    struct ggml_tensor * m2 = ggml_pool_2d(g, m1, GGML_OP_POOL_MAX, 5, 5, 1, 1, 2.0f, 2.0f);
    struct ggml_tensor * m3 = ggml_pool_2d(g, m2, GGML_OP_POOL_MAX, 5, 5, 1, 1, 2.0f, 2.0f);
    struct ggml_tensor * cat = ggml_concat(g, ggml_concat(g, ggml_concat(g, c, m1, 2), m2, 2), m3, 2);
    return conv_bn(g, wc, cat, prefix + ".cv2", 1);  // 1x1 -> c2
}

// Build the full YOLOv8n graph; fills box[3] + cls[3] head outputs (P3,P4,P5).
static bool build_yolov8n(struct ggml_context * g, struct ggml_context * wc,
                          struct ggml_tensor * inp,
                          struct ggml_tensor * box[3], struct ggml_tensor * cls[3]) {
    // backbone
    struct ggml_tensor * x = conv_bn(g, wc, inp, "model.0", 2);     // 16, 320
    x = conv_bn(g, wc, x, "model.1", 2);                            // 32, 160
    x = c2f(g, wc, x, "model.2", 1, true);                          // 32, 160
    x = conv_bn(g, wc, x, "model.3", 2);                            // 64, 80
    struct ggml_tensor * p3 = c2f(g, wc, x, "model.4", 2, true);    // 64, 80   (P3 src)
    x = conv_bn(g, wc, p3, "model.5", 2);                           // 128, 40
    struct ggml_tensor * p4 = c2f(g, wc, x, "model.6", 2, true);    // 128, 40  (P4 src)
    x = conv_bn(g, wc, p4, "model.7", 2);                           // 256, 20
    x = c2f(g, wc, x, "model.8", 1, true);                          // 256, 20
    struct ggml_tensor * p5 = sppf(g, wc, x, "model.9");            // 256, 20  (P5 src)
    if (!p3 || !p4 || !p5) return false;

    // neck (PAN-FPN)
    struct ggml_tensor * u = ggml_upscale(g, p5, 2, GGML_SCALE_MODE_NEAREST);  // 256, 40
    x = ggml_concat(g, u, p4, 2);                                   // 384, 40
    struct ggml_tensor * n12 = c2f(g, wc, x, "model.12", 1, false); // 128, 40
    u = ggml_upscale(g, n12, 2, GGML_SCALE_MODE_NEAREST);           // 128, 80
    x = ggml_concat(g, u, p3, 2);                                   // 192, 80
    struct ggml_tensor * n15 = c2f(g, wc, x, "model.15", 1, false); // 64, 80   (head P3)
    x = conv_bn(g, wc, n15, "model.16", 2);                         // 64, 40
    x = ggml_concat(g, x, n12, 2);                                  // 192, 40
    struct ggml_tensor * n18 = c2f(g, wc, x, "model.18", 1, false); // 128, 40  (head P4)
    x = conv_bn(g, wc, n18, "model.19", 2);                         // 128, 20
    x = ggml_concat(g, x, p5, 2);                                   // 384, 20
    struct ggml_tensor * n21 = c2f(g, wc, x, "model.21", 1, false); // 256, 20  (head P5)
    if (!n12 || !n15 || !n18 || !n21) return false;

    struct ggml_tensor * feats[3] = { n15, n18, n21 };
    for (int s = 0; s < 3; s++) {
        const std::string cv2 = "model.22.cv2." + std::to_string(s);
        const std::string cv3 = "model.22.cv3." + std::to_string(s);
        struct ggml_tensor * b = conv_bn(g, wc, feats[s], cv2 + ".0", 1);
        b = conv_bn(g, wc, b, cv2 + ".1", 1);
        b = conv_plain(g, wc, b, cv2 + ".2", 1);  // 64 ch (4*reg_max)
        struct ggml_tensor * c = conv_bn(g, wc, feats[s], cv3 + ".0", 1);
        c = conv_bn(g, wc, c, cv3 + ".1", 1);
        c = conv_plain(g, wc, c, cv3 + ".2", 1);  // 80 ch (nc)
        if (!b || !c) return false;
        box[s] = b;
        cls[s] = c;
    }
    return true;
}

// CPU-side DFL + decode + sigmoid → out_logits [84, 8400] (channel-major).
static void decode_head(const std::vector<float> & box, const std::vector<float> & cls,
                        int W, int H, int stride, int base, int nc, int anchors,
                        float * out) {
    const int reg = 16;       // reg_max
    const int WH = W * H;
    for (int gy = 0; gy < H; gy++) {
        for (int gx = 0; gx < W; gx++) {
            const int cell = gy * W + gx;
            float dist[4];
            for (int side = 0; side < 4; side++) {
                float mx = -1e30f;
                for (int j = 0; j < reg; j++) {
                    float z = box[(size_t) (side * reg + j) * WH + cell];
                    if (z > mx) mx = z;
                }
                float sum = 0.0f, acc = 0.0f;
                for (int j = 0; j < reg; j++) {
                    float e = expf(box[(size_t) (side * reg + j) * WH + cell] - mx);
                    sum += e;
                    acc += e * j;
                }
                dist[side] = acc / sum;  // expected distance in grid cells
            }
            const float ax = gx + 0.5f, ay = gy + 0.5f;
            const float x1 = ax - dist[0], y1 = ay - dist[1];
            const float x2 = ax + dist[2], y2 = ay + dist[3];
            const int a = base + cell;  // global anchor index
            out[0 * anchors + a] = (x1 + x2) * 0.5f * stride;  // cx
            out[1 * anchors + a] = (y1 + y2) * 0.5f * stride;  // cy
            out[2 * anchors + a] = (x2 - x1) * stride;         // w
            out[3 * anchors + a] = (y2 - y1) * stride;         // h
            for (int cc = 0; cc < nc; cc++) {
                float v = cls[(size_t) cc * WH + cell];
                out[(4 + cc) * anchors + a] = 1.0f / (1.0f + expf(-v));
            }
        }
    }
}

#endif  // YOLO_HAVE_GGML

// ---------------------------------------------------------------------------
//  C ABI
// ---------------------------------------------------------------------------

extern "C" yolo_ctx * yolo_init(const char * gguf_path) {
    if (!gguf_path) return nullptr;

#if defined(YOLO_HAVE_GGML)
    yolo_ctx * ctx = new (std::nothrow) yolo_ctx();
    if (!ctx) return nullptr;
    ctx->gguf_path = gguf_path;

    ctx->backend = ggml_backend_cpu_init();
    if (!ctx->backend) { delete ctx; return nullptr; }
    {
        // YOLOv8n is ~250 small conv ops; ggml's per-op thread barrier means
        // too many threads spin-waits and gets *slower* (hyperthread
        // oversubscription is catastrophic here). Default to ~physical cores
        // (logical/2), capped at 8; allow override via ELIZA_YOLO_THREADS.
        int nth = 4;
        unsigned hw = std::thread::hardware_concurrency();
        if (hw > 0) {
            nth = (int) (hw / 2);
            if (nth < 1) nth = 1;
            if (nth > 8) nth = 8;
        }
        if (const char * env = std::getenv("ELIZA_YOLO_THREADS")) {
            int v = std::atoi(env);
            if (v > 0 && v <= 128) nth = v;
        }
        ggml_backend_cpu_set_n_threads(ctx->backend, nth);
    }

    // 1. load the gguf into a throwaway ctx with data (no_alloc=false).
    struct ggml_context * tmp = nullptr;
    struct gguf_init_params gp = { /*no_alloc=*/false, /*ctx=*/&tmp };
    struct gguf_context * gguf = gguf_init_from_file(gguf_path, gp);
    if (!gguf || !tmp) {
        fprintf(stderr, "[yolo] failed to open gguf %s\n", gguf_path);
        if (gguf) gguf_free(gguf);
        ggml_backend_free(ctx->backend);
        delete ctx;
        return nullptr;
    }

    // metadata: class names (string) + input dims (fall back to 640).
    int64_t kc = gguf_find_key(gguf, "yolo.classes");
    if (kc >= 0 && gguf_get_kv_type(gguf, kc) == GGUF_TYPE_STRING) {
        ctx->classes = gguf_get_val_str(gguf, kc);
    }
    ctx->input_h = 640;
    ctx->input_w = 640;

    // 2. metadata-only duplicate into the weights ctx (no_alloc), then back it
    //    with a CPU buffer and upload each tensor's bytes.
    const int64_t n = gguf_get_n_tensors(gguf);
    struct ggml_init_params ip = {
        /*mem_size=*/ ggml_tensor_overhead() * (size_t) (n + 8),
        /*mem_buffer=*/ nullptr,
        /*no_alloc=*/ true,
    };
    ctx->wctx = ggml_init(ip);
    if (!ctx->wctx) {
        gguf_free(gguf); ggml_free(tmp); ggml_backend_free(ctx->backend);
        delete ctx; return nullptr;
    }
    for (int64_t i = 0; i < n; i++) {
        const char * name = gguf_get_tensor_name(gguf, i);
        struct ggml_tensor * src = ggml_get_tensor(tmp, name);
        struct ggml_tensor * dst = ggml_dup_tensor(ctx->wctx, src);
        ggml_set_name(dst, name);
    }
    ctx->wbuf = ggml_backend_alloc_ctx_tensors(ctx->wctx, ctx->backend);
    if (!ctx->wbuf) {
        gguf_free(gguf); ggml_free(tmp); ggml_free(ctx->wctx);
        ggml_backend_free(ctx->backend); delete ctx; return nullptr;
    }
    for (struct ggml_tensor * cur = ggml_get_first_tensor(ctx->wctx); cur;
         cur = ggml_get_next_tensor(ctx->wctx, cur)) {
        struct ggml_tensor * src = ggml_get_tensor(tmp, ggml_get_name(cur));
        ggml_backend_tensor_set(cur, ggml_get_data(src), 0, ggml_nbytes(src));
    }

    gguf_free(gguf);
    ggml_free(tmp);

    fprintf(stderr, "[yolo] initialized %s (%lld tensors, backend=%s)\n",
            gguf_path, (long long) n, ggml_backend_name(ctx->backend));
    return ctx;
#else
    fprintf(stderr, "[yolo] built without YOLO_HAVE_GGML — weights cannot load.\n");
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
    const int nc = 80;
    const int anchors = 8400;

    // compute-graph context (no_alloc; gallocr assigns activation buffers).
    size_t cmem = ggml_tensor_overhead() * GGML_DEFAULT_GRAPH_SIZE + ggml_graph_overhead();
    struct ggml_context * g = ggml_init({ cmem, nullptr, /*no_alloc=*/true });
    if (!g) return YOLO_ERR_OOM;

    struct ggml_tensor * inp = ggml_new_tensor_4d(g, GGML_TYPE_F32, w, h, 3, 1);  // [W,H,C,N]
    ggml_set_name(inp, "input");
    ggml_set_input(inp);

    struct ggml_tensor * box[3] = { nullptr, nullptr, nullptr };
    struct ggml_tensor * cls[3] = { nullptr, nullptr, nullptr };
    if (!build_yolov8n(g, ctx->wctx, inp, box, cls)) {
        ggml_free(g);
        return YOLO_ERR_FORMAT;
    }
    for (int s = 0; s < 3; s++) { ggml_set_output(box[s]); ggml_set_output(cls[s]); }

    struct ggml_cgraph * gf = ggml_new_graph(g);
    for (int s = 0; s < 3; s++) {
        ggml_build_forward_expand(gf, box[s]);
        ggml_build_forward_expand(gf, cls[s]);
    }

    ggml_gallocr_t alloc = ggml_gallocr_new(ggml_backend_cpu_buffer_type());
    if (!alloc || !ggml_gallocr_alloc_graph(alloc, gf)) {
        if (alloc) ggml_gallocr_free(alloc);
        ggml_free(g);
        return YOLO_ERR_OOM;
    }

    // upload preprocessed CHW image, run.
    ggml_backend_tensor_set(inp, rgb_chw, 0, ggml_nbytes(inp));
    if (ggml_backend_graph_compute(ctx->backend, gf) != GGML_STATUS_SUCCESS) {
        ggml_gallocr_free(alloc);
        ggml_free(g);
        return YOLO_ERR_BACKEND;
    }

    // pull head tensors to host and decode.
    std::memset(out_logits, 0, sizeof(float) * (size_t) (4 + nc) * anchors);
    const int strides[3] = { 8, 16, 32 };
    const int bases[3]   = { 0, 6400, 8000 };
    for (int s = 0; s < 3; s++) {
        const int W = (int) box[s]->ne[0];
        const int H = (int) box[s]->ne[1];
        std::vector<float> boxbuf(ggml_nelements(box[s]));
        std::vector<float> clsbuf(ggml_nelements(cls[s]));
        ggml_backend_tensor_get(box[s], boxbuf.data(), 0, ggml_nbytes(box[s]));
        ggml_backend_tensor_get(cls[s], clsbuf.data(), 0, ggml_nbytes(cls[s]));
        decode_head(boxbuf, clsbuf, W, H, strides[s], bases[s], nc, anchors, out_logits);
    }

    *out_channels = 4 + nc;  // 84
    *out_anchors  = anchors; // 8400

    ggml_gallocr_free(alloc);
    ggml_free(g);
    return YOLO_OK;
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
    if (ctx->wbuf)    ggml_backend_buffer_free(ctx->wbuf);
    if (ctx->wctx)    ggml_free(ctx->wctx);
    if (ctx->backend) ggml_backend_free(ctx->backend);
#endif
    delete ctx;
}
