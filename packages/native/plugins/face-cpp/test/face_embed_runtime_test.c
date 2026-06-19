/*
 * face_embed_runtime_test — drives the face_embed pipeline end-to-end
 * using a synthetic embedding GGUF.
 *
 * Asserts that:
 *   - face_embed_open accepts the metadata + weight shapes;
 *   - face_embed runs the full forward graph without crashing;
 *   - the output embedding is L2-normalized to within [0.99, 1.01].
 *
 * Real-weight parity is in test/face_parity_test.py.
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

typedef struct { float *bufs[256]; int n; } alloc_log;

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
    uint32_t s = seed ? seed : 1;
    for (size_t i = 0; i < n_elems; ++i) {
        s = s * 1664525u + 1013904223u;
        const float v = ((float)((int32_t)s) / 2147483648.0f) * scale;
        p[i] = v;
    }
    log->bufs[log->n++] = p;
    return p;
}

static void add_emb_block(synth_gguf *g, alloc_log *log, int idx,
                          int cin, int cout)
{
    char buf[160];
    snprintf(buf, sizeof buf, "emb.block%d.dw.weight", idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cin * 1 * 3 * 3, (uint32_t)(5000 + idx), 0.1f),
        4, cin, 1, 3, 3);
    snprintf(buf, sizeof buf, "emb.block%d.dw.bias", idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cin, 0.05f), 1, cin);
    snprintf(buf, sizeof buf, "emb.block%d.pw.weight", idx);
    synth_add_tensor_f32(g, buf,
        alloc_seeded(log, (size_t)cout * (size_t)cin, (uint32_t)(6000 + idx), 0.1f),
        4, cout, cin, 1, 1);
    snprintf(buf, sizeof buf, "emb.block%d.pw.bias", idx);
    synth_add_tensor_f32(g, buf, alloc_filled(log, (size_t)cout, 0.05f), 1, cout);
}

static int build_embed_gguf(const char *path) {
    static synth_gguf g;
    static alloc_log log;
    g.n_kvs = 0;
    g.n_tensors = 0;
    log.n = 0;

    synth_add_kv_str(&g, "general.architecture", "face");
    synth_add_kv_str(&g, "face.embedder", FACE_EMBEDDER_FACENET_128);
    synth_add_kv_u32(&g, "face.embedder_input_size", FACE_EMBED_CROP_SIZE);
    synth_add_kv_u32(&g, "face.embedder_dim", FACE_EMBED_DIM);
    synth_add_kv_str(&g, "face.upstream_commit", "synthetic");

    /* stem (32, 3, 3, 3) + bias 32 */
    synth_add_tensor_f32(&g, "emb.stem.weight",
        alloc_seeded(&log, 32 * 3 * 3 * 3, 99u, 0.1f), 4, 32, 3, 3, 3);
    synth_add_tensor_f32(&g, "emb.stem.bias",
        alloc_filled(&log, 32, 0.1f), 1, 32);

    /* 5 blocks: (32,64,1) (64,128,2) (128,128,1) (128,256,2) (256,256,2) */
    add_emb_block(&g, &log, 1,  32,  64);
    add_emb_block(&g, &log, 2,  64, 128);
    add_emb_block(&g, &log, 3, 128, 128);
    add_emb_block(&g, &log, 4, 128, 256);
    add_emb_block(&g, &log, 5, 256, 256);

    /* projection (128, 256) + bias 128 */
    synth_add_tensor_f32(&g, "emb.proj.weight",
        alloc_seeded(&log, 128 * 256, 9999u, 0.05f), 2, 128, 256);
    synth_add_tensor_f32(&g, "emb.proj.bias",
        alloc_filled(&log, 128, 0.0f), 1, 128);

    int rc = synth_write(&g, path);
    for (int i = 0; i < log.n; ++i) free(log.bufs[i]);
    log.n = 0;
    return rc;
}

int main(void) {
    const char *path = "/tmp/face_embed_runtime_test.gguf";

    if (build_embed_gguf(path) != 0) {
        fprintf(stderr, "[face-embed-runtime] failed to write synth GGUF\n");
        return 2;
    }

    face_embed_handle h = NULL;
    int rc = face_embed_open(path, &h);
    if (rc != 0 || !h) {
        fprintf(stderr, "[face-embed-runtime] face_embed_open failed: %d\n", rc);
        return 1;
    }

    /* Build a synthetic 256x256 RGB image + a face_detection record
     * with reasonable keypoints inside the canvas (so face_align_5pt
     * has something to warp). */
    const int W = 256, H = 256;
    uint8_t *img = (uint8_t *)malloc((size_t)W * H * 3);
    if (!img) { face_embed_close(h); return 2; }
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            img[(y * W + x) * 3 + 0] = (uint8_t)((x + y) & 0xFF);
            img[(y * W + x) * 3 + 1] = (uint8_t)(x & 0xFF);
            img[(y * W + x) * 3 + 2] = (uint8_t)(y & 0xFF);
        }
    }

    face_detection crop = {0};
    crop.x = 64; crop.y = 64; crop.w = 128; crop.h = 128;
    crop.confidence = 0.9f;
    /* BlazeFace landmark order: left eye, right eye, nose, mouth,
     * left ear, right ear. Plausible positions inside [64..192]. */
    crop.landmarks[0]  = 96;  crop.landmarks[1]  = 120; /* left eye */
    crop.landmarks[2]  = 160; crop.landmarks[3]  = 120; /* right eye */
    crop.landmarks[4]  = 128; crop.landmarks[5]  = 150; /* nose */
    crop.landmarks[6]  = 128; crop.landmarks[7]  = 180; /* mouth */
    crop.landmarks[8]  = 80;  crop.landmarks[9]  = 130; /* left ear */
    crop.landmarks[10] = 176; crop.landmarks[11] = 130; /* right ear */

    float emb[FACE_EMBED_DIM] = {0};
    rc = face_embed(h, img, W, H, W * 3, &crop, emb);
    free(img);
    if (rc != 0) {
        fprintf(stderr, "[face-embed-runtime] face_embed failed: %d\n", rc);
        face_embed_close(h);
        return 1;
    }

    double s = 0.0;
    for (int i = 0; i < FACE_EMBED_DIM; ++i) s += (double)emb[i] * (double)emb[i];
    const double norm = sqrt(s);
    printf("[face-embed-runtime] ||v||_2 = %.6f\n", norm);
    if (norm < 0.99 || norm > 1.01) {
        fprintf(stderr,
                "[face-embed-runtime] embedding L2 norm %.6f outside [0.99, 1.01]\n",
                norm);
        face_embed_close(h);
        return 1;
    }

    face_embed_close(h);
    return 0;
}
