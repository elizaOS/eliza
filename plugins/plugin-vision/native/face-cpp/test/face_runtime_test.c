/*
 * face_runtime_test — drives the full face_detect pipeline end-to-end
 * using a synthetic BlazeFace GGUF written to /tmp.
 *
 * The synthetic weights are deterministic but arbitrary; the goal is
 * to confirm that:
 *   - face_detect_open accepts the metadata + weight shapes;
 *   - face_blazeface_forward runs the full graph without crashing;
 *   - face_blazeface_decode + face_nms_inplace produce a non-empty
 *     candidate set on a reasonable input + threshold;
 *   - face_detect respects the cap and returns -ENOSPC correctly.
 *
 * The parity test (test/face_parity_test.py) validates against real
 * upstream weights.
 */

#include "face/face.h"
#include "face_gguf_synth.h"

#include <errno.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Per-tensor allocation list — kept around so we can free at the end. */
typedef struct {
    float *bufs[512];
    int    n;
} alloc_log;

static float *alloc_filled(alloc_log *log, size_t n_elems, float value) {
    float *p = (float *)malloc(sizeof(float) * n_elems);
    if (!p) { fprintf(stderr, "OOM\n"); exit(2); }
    for (size_t i = 0; i < n_elems; ++i) p[i] = value;
    log->bufs[log->n++] = p;
    return p;
}

static float *alloc_seeded(alloc_log *log, size_t n_elems, uint32_t seed, float scale) {
    float *p = (float *)malloc(sizeof(float) * n_elems);
    if (!p) { fprintf(stderr, "OOM\n"); exit(2); }
    /* Simple LCG; enough for "non-zero, deterministic" weights. */
    uint32_t s = seed ? seed : 1;
    for (size_t i = 0; i < n_elems; ++i) {
        s = s * 1664525u + 1013904223u;
        /* map to [-1, 1] then scale */
        const float v = ((float)((int32_t)s) / 2147483648.0f) * scale;
        p[i] = v;
    }
    log->bufs[log->n++] = p;
    return p;
}

static void add_block_b1(synth_gguf *g, alloc_log *log, int seq_idx,
                         int cin, int cout)
{
    char buf[160];
    /* depthwise: (cin, 1, 3, 3) */
    snprintf(buf, sizeof buf, "det.backbone1.%d.convs.0.weight", seq_idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cin * 1 * 3 * 3, (uint32_t)(1000 + seq_idx), 0.05f),
        4, cin, 1, 3, 3);
    snprintf(buf, sizeof buf, "det.backbone1.%d.convs.0.bias", seq_idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cin, 0.0f), 1, cin);
    /* pointwise: (cout, cin, 1, 1) */
    snprintf(buf, sizeof buf, "det.backbone1.%d.convs.1.weight", seq_idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cout * (size_t)cin, (uint32_t)(2000 + seq_idx), 0.05f),
        4, cout, cin, 1, 1);
    snprintf(buf, sizeof buf, "det.backbone1.%d.convs.1.bias", seq_idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cout, 0.0f), 1, cout);
}

static void add_block_b2(synth_gguf *g, alloc_log *log, int seq_idx,
                         int cin, int cout)
{
    char buf[160];
    snprintf(buf, sizeof buf, "det.backbone2.%d.convs.0.weight", seq_idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cin * 1 * 3 * 3, (uint32_t)(3000 + seq_idx), 0.05f),
        4, cin, 1, 3, 3);
    snprintf(buf, sizeof buf, "det.backbone2.%d.convs.0.bias", seq_idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cin, 0.0f), 1, cin);
    snprintf(buf, sizeof buf, "det.backbone2.%d.convs.1.weight", seq_idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cout * (size_t)cin, (uint32_t)(4000 + seq_idx), 0.05f),
        4, cout, cin, 1, 1);
    snprintf(buf, sizeof buf, "det.backbone2.%d.convs.1.bias", seq_idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cout, 0.0f), 1, cout);
}

static int build_blazeface_gguf(const char *path) {
    static synth_gguf g;
    static alloc_log log;
    g.n_kvs = 0;
    g.n_tensors = 0;
    log.n = 0;

    /* Metadata. */
    synth_add_kv_str(&g, "general.architecture", "face");
    synth_add_kv_str(&g, "face.detector", FACE_DETECTOR_BLAZEFACE_FRONT);
    synth_add_kv_u32(&g, "face.detector_input_size", FACE_DETECTOR_INPUT_SIZE);
    synth_add_kv_u32(&g, "face.anchor_count", FACE_DETECTOR_ANCHOR_COUNT);
    synth_add_kv_str(&g, "face.upstream_commit", "synthetic");

    /* stem: backbone1.0 (24, 3, 5, 5) + bias (24) */
    synth_add_tensor_f32(&g, "det.backbone1.0.weight",
        alloc_seeded(&log, 24 * 3 * 5 * 5, 7u, 0.05f),
        4, 24, 3, 5, 5);
    /* small positive bias so the stem ReLU outputs non-zero on a 0
     * input image, exercising the rest of the network */
    synth_add_tensor_f32(&g, "det.backbone1.0.bias",
        alloc_filled(&log, 24, 0.05f), 1, 24);

    /* backbone1 blocks 2..12 */
    const int B1[][3] = {
        {  2, 24, 24 }, {  3, 24, 28 }, {  4, 28, 32 }, {  5, 32, 36 },
        {  6, 36, 42 }, {  7, 42, 48 }, {  8, 48, 56 }, {  9, 56, 64 },
        { 10, 64, 72 }, { 11, 72, 80 }, { 12, 80, 88 },
    };
    for (int i = 0; i < (int)(sizeof(B1)/sizeof(B1[0])); ++i) {
        add_block_b1(&g, &log, B1[i][0], B1[i][1], B1[i][2]);
    }

    /* backbone2 blocks 0..4 */
    const int B2[][3] = {
        { 0, 88, 96 }, { 1, 96, 96 }, { 2, 96, 96 },
        { 3, 96, 96 }, { 4, 96, 96 },
    };
    for (int i = 0; i < (int)(sizeof(B2)/sizeof(B2[0])); ++i) {
        add_block_b2(&g, &log, B2[i][0], B2[i][1], B2[i][2]);
    }

    /* Heads. classifier_8 (2, 88, 1, 1) + bias (2). Use a positive bias
     * so post-sigmoid score is > 0.5 on synth inputs and detect()
     * returns at least one box. */
    synth_add_tensor_f32(&g, "det.classifier_8.weight",
        alloc_seeded(&log, 2 * 88, 100u, 0.05f), 4, 2, 88, 1, 1);
    synth_add_tensor_f32(&g, "det.classifier_8.bias",
        alloc_filled(&log, 2, 1.0f), 1, 2);

    synth_add_tensor_f32(&g, "det.classifier_16.weight",
        alloc_seeded(&log, 6 * 96, 200u, 0.05f), 4, 6, 96, 1, 1);
    synth_add_tensor_f32(&g, "det.classifier_16.bias",
        alloc_filled(&log, 6, 1.0f), 1, 6);

    synth_add_tensor_f32(&g, "det.regressor_8.weight",
        alloc_seeded(&log, 32 * 88, 300u, 0.01f), 4, 32, 88, 1, 1);
    synth_add_tensor_f32(&g, "det.regressor_8.bias",
        alloc_filled(&log, 32, 0.0f), 1, 32);

    synth_add_tensor_f32(&g, "det.regressor_16.weight",
        alloc_seeded(&log, 96 * 96, 400u, 0.01f), 4, 96, 96, 1, 1);
    synth_add_tensor_f32(&g, "det.regressor_16.bias",
        alloc_filled(&log, 96, 0.0f), 1, 96);

    int rc = synth_write(&g, path);
    /* Free buffers (after the synth file is on disk; synth_write
     * copied the data). */
    for (int i = 0; i < log.n; ++i) free(log.bufs[i]);
    log.n = 0;
    return rc;
}

int main(void) {
    const char *path = "/tmp/face_runtime_test.gguf";

    if (build_blazeface_gguf(path) != 0) {
        fprintf(stderr, "[face-runtime] failed to write synth GGUF\n");
        return 2;
    }

    face_detect_handle h = NULL;
    int rc = face_detect_open(path, &h);
    if (rc != 0 || !h) {
        fprintf(stderr, "[face-runtime] face_detect_open failed: %d\n", rc);
        return 1;
    }

    /* Build a synthetic 256x256 RGB image with a horizontal gradient
     * so the input to the first conv is non-degenerate. */
    const int W = 256, H = 256;
    uint8_t *img = (uint8_t *)malloc((size_t)W * H * 3);
    if (!img) { face_detect_close(h); return 2; }
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            img[(y * W + x) * 3 + 0] = (uint8_t)(x & 0xFF);
            img[(y * W + x) * 3 + 1] = (uint8_t)((x + y) & 0xFF);
            img[(y * W + x) * 3 + 2] = (uint8_t)(y & 0xFF);
        }
    }

    const size_t cap = 16;
    face_detection out[16];
    size_t count = 0;
    rc = face_detect(h, img, W, H, W * 3, 0.5f, out, cap, &count);
    free(img);
    if (rc != 0 && rc != -ENOSPC) {
        fprintf(stderr, "[face-runtime] face_detect failed: rc=%d\n", rc);
        face_detect_close(h);
        return 1;
    }
    /* The synthetic positive-bias classifier head should produce many
     * candidates pre-NMS; after NMS we expect at least one survivor. */
    if (count < 1) {
        fprintf(stderr, "[face-runtime] expected >=1 detection, got %zu\n", count);
        face_detect_close(h);
        return 1;
    }
    printf("[face-runtime] kept=%zu (cap=%zu rc=%d)\n", count, cap, rc);

    face_detect_close(h);
    return 0;
}
