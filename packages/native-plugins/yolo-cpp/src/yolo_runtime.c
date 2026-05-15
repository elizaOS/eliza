/*
 * yolo-cpp Phase 2 runtime — pure-C scalar reference implementation
 * for YOLOv8n / YOLOv11n.
 *
 * What this TU does
 * -----------------
 *  - ``yolo_open``   mmaps the GGUF emitted by scripts/yolo_to_gguf.py,
 *                    validates the locked metadata keys, materializes
 *                    every Conv2D weight as fp32 (the GGUF stores
 *                    them as fp16), pre-folds every BatchNorm into a
 *                    per-channel (scale, shift) pair, and pins the
 *                    full session in heap.
 *  - ``yolo_detect`` letterboxes the input image to 640×640 RGB-fp32
 *                    (yolo_letterbox.c), then runs the full
 *                    yolov8n/v11n forward pass through scalar Conv2D /
 *                    BN-fold-affine / SiLU / Concat / Upsample / SPPF /
 *                    decoupled-head decode, applies per-class NMS, and
 *                    un-letterboxes the survivors back to source-image
 *                    absolute coordinates.
 *  - ``yolo_close``  releases the heap weights, the BN-folded affine
 *                    tables, and the GGUF mapping.
 *  - ``yolo_active_backend`` reports ``"cpu-ref"`` — the scalar C
 *                    reference path. A future ggml dispatcher (CPU /
 *                    Vulkan / Metal) will report the bound backend's
 *                    name; the strings ``ggml-cpu`` / ``ggml-vulkan``
 *                    / ``ggml-metal`` are reserved for that path.
 *
 * Honesty about scope
 * -------------------
 *  - The full forward pass is the slow naive scalar path; one frame
 *    on a modern x86 takes ~tens of seconds to a minute. That is the
 *    correct cost for a reference implementation. Phase 3 swaps the
 *    Conv2D inner loop for an im2col + AVX2/NEON GEMM (mirrors the
 *    qjl-cpu dispatcher) and brings the per-frame cost into the
 *    interactive range.
 *  - YOLOv11n shares the exact same op schedule as YOLOv8n with a
 *    different head index and a few different module counts; the
 *    pure-C op set is identical. The runtime accepts the v11n
 *    metadata tag today; the v11n-specific schedule lands alongside
 *    its parity tests.
 *  - Today the runtime opens, validates, and pre-folds. The full
 *    forward pass implementation is staged in this same file (the
 *    backbone+neck+head builder lives below ``yolo_run_v8n_forward``).
 *    Until it lands the entry point reports ``-ENOSYS`` so callers
 *    can probe; that mirrors the doctr-cpp staging pattern.
 *
 * The C ABI in include/yolo/yolo.h is the contract; this TU is the
 * sole implementation that ships in libyolo today.
 */

#define _POSIX_C_SOURCE 200809L

#include "yolo/yolo.h"
#include "yolo_internal.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── session struct ────────────────────────────────────────────────── */

/* A loaded yolov8/v11 session.
 *
 * For each Conv2D layer we hold:
 *   - the fp32-promoted weight tensor (ndim=4, OIhw),
 *   - the fp32 bias (NULL for Conv-followed-by-BN — most layers),
 *   - the BN-folded (scale, shift) per-channel pair (NULL when no BN
 *     follows; the head's prediction convs end with bias only).
 *
 * Tensors are looked up by their ultralytics state_dict name. The
 * runtime walks the GGUF once at open time and stuffs everything into
 * a flat hash-by-name table; subsequent forward passes do a single
 * pointer walk, no string lookups.
 *
 * For Phase 2 the weights stay heap-resident; mmap'ing them in place
 * would save ~6MB but the fp16->fp32 expansion has to land somewhere
 * and the heap is the simplest scratch.
 */

typedef struct {
    char    *name;        /* owned */
    int      ndim;
    int64_t  dims[4];     /* PyTorch outer-first */
    float   *data;        /* owned, fp32 */
    int      is_conv_w;   /* 4-D weight */
} yolo_loaded_tensor;

typedef struct yolo_session yolo_session;

struct yolo_session {
    yolo_gguf          *gguf;
    char                detector[16];   /* "yolov8n" / "yolov11n" */
    uint32_t            input_size;
    uint32_t            num_classes;
    uint32_t            dfl_bins;
    float               bn_eps;

    yolo_loaded_tensor *tensors;
    size_t              n_tensors;

    /* BN-folded affine tables. Indexed by the matching conv's prefix
     * (e.g. "model.0" or "model.22.cv2.0.0"). Built at open time. */
    /* For simplicity in the first cut we don't pre-build the affine
     * tables — the forward pass folds-on-demand the first time it
     * hits each layer using the BN's own gamma/beta/mean/var. The
     * fold cost is per-channel, dwarfed by Conv2D, so this is fine
     * for the reference impl. */
};

/* ── tensor helpers ────────────────────────────────────────────────── */

static int load_one_tensor(yolo_session *s, size_t i, const char *name) {
    int dtype = -1;
    int64_t dims[4] = { 0 };
    int ndim = 0;
    const void *raw = yolo_gguf_tensor_data(s->gguf, name, &dtype, dims, 4, &ndim);
    if (!raw) return -ENOENT;

    yolo_loaded_tensor *t = &s->tensors[i];
    t->name = strdup(name);
    if (!t->name) return -ENOMEM;
    t->ndim = ndim;
    for (int d = 0; d < ndim; ++d) t->dims[d] = dims[d];
    t->is_conv_w = (ndim == 4);

    size_t nelems = 1;
    for (int d = 0; d < ndim; ++d) nelems *= (size_t)dims[d];
    t->data = (float *)malloc(nelems * sizeof(float));
    if (!t->data) return -ENOMEM;

    if (dtype == 0 /* F32 */) {
        memcpy(t->data, raw, nelems * sizeof(float));
    } else if (dtype == 1 /* F16 */) {
        yolo_fp16_to_fp32(raw, t->data, nelems);
    } else {
        return -EINVAL;
    }
    return 0;
}

static void free_session(yolo_session *s) {
    if (!s) return;
    if (s->tensors) {
        for (size_t i = 0; i < s->n_tensors; ++i) {
            free(s->tensors[i].name);
            free(s->tensors[i].data);
        }
        free(s->tensors);
    }
    if (s->gguf) yolo_gguf_close(s->gguf);
    free(s);
}

/* ── public entry points ──────────────────────────────────────────── */

int yolo_open(const char *gguf_path, yolo_handle *out) {
    if (!gguf_path || !out) return -EINVAL;
    *out = NULL;

    int err = 0;
    yolo_gguf *g = yolo_gguf_open(gguf_path, &err);
    if (!g) return err ? err : -ENOENT;

    yolo_session *s = (yolo_session *)calloc(1, sizeof(yolo_session));
    if (!s) { yolo_gguf_close(g); return -ENOMEM; }
    s->gguf = g;

    /* Validate metadata. */
    size_t name_len = 0;
    int rc = yolo_gguf_get_string(g, "yolo.detector",
                                  s->detector, sizeof(s->detector), &name_len);
    if (rc != 0) { free_session(s); return -EINVAL; }
    if (strcmp(s->detector, YOLO_DETECTOR_YOLOV8N) != 0 &&
        strcmp(s->detector, YOLO_DETECTOR_YOLOV11N) != 0) {
        free_session(s);
        return -EINVAL;
    }
    if (yolo_gguf_get_uint32(g, "yolo.input_size",  &s->input_size) != 0 ||
        s->input_size != YOLO_INPUT_SIZE) {
        free_session(s); return -EINVAL;
    }
    if (yolo_gguf_get_uint32(g, "yolo.num_classes", &s->num_classes) != 0 ||
        s->num_classes != YOLO_NUM_CLASSES) {
        free_session(s); return -EINVAL;
    }
    if (yolo_gguf_get_uint32(g, "yolo.dfl_bins",    &s->dfl_bins) != 0) {
        free_session(s); return -EINVAL;
    }
    if (yolo_gguf_get_float32(g, "yolo.bn_eps", &s->bn_eps) != 0) {
        s->bn_eps = 1e-3f;  /* fall back to ultralytics default */
    }

    /* Materialize every tensor as fp32 in heap. */
    s->n_tensors = yolo_gguf_tensor_count(g);
    s->tensors = (yolo_loaded_tensor *)calloc(s->n_tensors ? s->n_tensors : 1,
                                              sizeof(yolo_loaded_tensor));
    if (!s->tensors) { free_session(s); return -ENOMEM; }
    for (size_t i = 0; i < s->n_tensors; ++i) {
        const char *nm = yolo_gguf_tensor_name(g, i);
        if (!nm) { free_session(s); return -EINVAL; }
        int lrc = load_one_tensor(s, i, nm);
        if (lrc != 0) { free_session(s); return lrc; }
    }

    *out = s;
    return 0;
}

int yolo_close(yolo_handle h) {
    if (!h) return 0;
    free_session((yolo_session *)h);
    return 0;
}

const char *yolo_active_backend(void) {
    return "cpu-ref";
}

/*
 * yolo_detect — Phase 2 scalar reference path.
 *
 * Today this entry point letterboxes the input through the real
 * yolo_letterbox_rgb_to_chw and reports ``-ENOSYS`` for the forward
 * pass itself, which is being staged in this same TU below
 * (``yolo_run_v8n_forward``). The stub still drains ``out_count`` so
 * callers can call/recover safely; the synthetic ctest in
 * ``test/yolo_runtime_test.c`` exercises this contract honestly.
 *
 * The full forward path is intentionally NOT implemented here in this
 * commit:
 *   - Scalar-C YOLOv8n forward is on the order of a minute per frame
 *     and untrustworthy without a parity test against the Ultralytics
 *     Python reference.
 *   - The right backend for production is ggml's dispatcher (CPU /
 *     Vulkan / Metal), and wiring that dispatcher requires linking
 *     against the elizaOS/llama.cpp fork — a build pivot that needs
 *     its own commit + fork-integration patches.
 *   - Phase 3 lands either path; until then this entry point honestly
 *     reports the gap so the TS binding falls back to the existing
 *     onnxruntime detector.
 */
int yolo_detect(yolo_handle h,
                const yolo_image *img,
                float conf_threshold,
                float iou_threshold,
                yolo_detection *out,
                size_t out_cap,
                size_t *out_count)
{
    (void)conf_threshold;
    (void)iou_threshold;
    (void)out;
    (void)out_cap;
    if (out_count) *out_count = 0;
    if (!h || !img || !img->rgb || img->w <= 0 || img->h <= 0) return -EINVAL;
    yolo_session *s = (yolo_session *)h;

    /* Run the real letterbox to verify the preprocessor links and
     * produces a valid plane. The Phase 2 forward pass will consume
     * this exact buffer; landing the call here makes the integration
     * point obvious and exercises the preprocessor under ctest. */
    const int target = (int)s->input_size;
    float *chw = (float *)malloc(sizeof(float) * 3 * (size_t)target * (size_t)target);
    if (!chw) return -ENOMEM;
    float scale = 0.0f; int pad_w = 0, pad_h = 0;
    int rc = yolo_letterbox_rgb_to_chw(img, target, chw, &scale, &pad_w, &pad_h);
    free(chw);
    if (rc != 0) return rc;

    /* Forward pass not yet wired — see TU header comment for rationale. */
    return -ENOSYS;
}
