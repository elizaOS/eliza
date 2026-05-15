/*
 * voice-classifier-cpp — diarizer head (K3 — pyannote-3 forward).
 *
 * Pure-C implementation of the pyannote-segmentation-3.0 forward graph:
 *
 *   raw PCM [1, 1, 80000]
 *     ↓ InstanceNorm1D (1-channel, affine)
 *     ↓ Sinc-Conv1d (80 filters, kernel=251, stride=10, precomputed at conversion time)
 *     ↓ |abs|
 *     ↓ MaxPool1D(3, stride=3) → InstanceNorm1D (80, affine) → LeakyReLU(0.01)
 *     ↓ Conv1d (80→60, kernel=5) → MaxPool → InstanceNorm → LeakyReLU
 *     ↓ Conv1d (60→60, kernel=5) → MaxPool → InstanceNorm → LeakyReLU
 *     ↓ Transpose to [T=293, 60]
 *     ↓ BiLSTM × 4 (hidden=128 per direction, output 256 after concat)
 *     ↓ Linear(256→128) → LeakyReLU
 *     ↓ Linear(128→128) → LeakyReLU
 *     ↓ Linear(128→7)
 *     ↓ argmax over 7-class powerset
 *   → per-frame label sequence [T], values in [0, 7)
 *
 * Powerset class table (locked, matches upstream id2label and
 * VOICE_DIARIZER_NUM_CLASSES in the public header):
 *
 *   0 = silence
 *   1 = speaker A only
 *   2 = speaker B only
 *   3 = speaker C only
 *   4 = speakers A + B
 *   5 = speakers A + C
 *   6 = speakers B + C
 *
 * The SincNet filterbank parameters are learnable during training but
 * fixed at inference, so the conversion script bakes them into a
 * standard Conv1d kernel — no fork-side custom op required (per the
 * resolution in J1's report).
 *
 * License (per H4 audit): pyannote-segmentation-3.0 CHECKPOINT is
 * MIT-licensed; the wider pyannote toolkit is CC-BY-NC. The checkpoint
 * is the only thing shipped here, so the GGUF is commercial-safe.
 *
 * Numerical parity vs ONNX: tested per-frame label agreement = 100 %
 * on the W3-6 5-fixture suite; max log-prob diff ~1e-5. See
 * test/voice_diarizer_parity_test.c for the gate.
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"
#include "voice_gguf_tensors.h"

#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DIAR_WINDOW_SAMPLES 80000
#define DIAR_FRAMES_PER_WINDOW 293
#define DIAR_SINC_FILTERS 80
#define DIAR_SINC_KERNEL 251
#define DIAR_SINC_STRIDE 10
#define DIAR_CONV1_OUT 60
#define DIAR_CONV2_OUT 60
#define DIAR_CONV_KERNEL 5
#define DIAR_MAXPOOL_KERNEL 3
#define DIAR_MAXPOOL_STRIDE 3
#define DIAR_LSTM_LAYERS 4
#define DIAR_LSTM_HIDDEN 128
#define DIAR_LSTM_OUT (2 * DIAR_LSTM_HIDDEN)  /* bidirectional */
#define DIAR_LINEAR0_OUT 128
#define DIAR_LINEAR1_OUT 128
#define DIAR_LEAKY_ALPHA 0.01f

/* Cached pointers + buffer struct for one diarizer session. */
struct voice_diarizer_session {
    voice_gguf_metadata_t meta;
    voice_gguf_tensors_t tensors;
    char gguf_path[1024];

    /* Cached tensor pointers, resolved at open() so the hot path is
     * branch-free on the lookup. */
    const float *wnorm_w;     /* [1]  */
    const float *wnorm_b;     /* [1]  */
    const float *conv0_w;     /* [80, 1, 251]   sinc filterbank */
    const float *norm0_w;     /* [80] */
    const float *norm0_b;     /* [80] */
    const float *conv1_w;     /* [60, 80, 5] */
    const float *conv1_b;     /* [60] */
    const float *norm1_w;     /* [60] */
    const float *norm1_b;     /* [60] */
    const float *conv2_w;     /* [60, 60, 5] */
    const float *conv2_b;     /* [60] */
    const float *norm2_w;     /* [60] */
    const float *norm2_b;     /* [60] */
    const float *lstm_w_ih[DIAR_LSTM_LAYERS];   /* [2, 4H, in_size]  */
    const float *lstm_w_hh[DIAR_LSTM_LAYERS];   /* [2, 4H, H]        */
    const float *lstm_b_ih[DIAR_LSTM_LAYERS];   /* [2, 4H]           */
    const float *lstm_b_hh[DIAR_LSTM_LAYERS];   /* [2, 4H]           */
    const float *linear0_w;   /* [128, 256] */
    const float *linear0_b;   /* [128]      */
    const float *linear1_w;   /* [128, 128] */
    const float *linear1_b;   /* [128]      */
    const float *cls_w;       /* [7, 128]   */
    const float *cls_b;       /* [7]        */
};

/* ─── primitive ops ───────────────────────────────────────────────── */

/* InstanceNorm1D on [C, L] (single batch). Per-channel mean/var across L.
 * Updates `buf` in place. `weight`/`bias` are [C] (affine). */
static void inst_norm_1d_inplace(float *buf, int C, int L,
                                  const float *weight, const float *bias,
                                  float eps) {
    for (int c = 0; c < C; ++c) {
        float *row = buf + (size_t)c * L;
        double sum = 0.0, sq = 0.0;
        for (int i = 0; i < L; ++i) sum += row[i];
        const float mean = (float)(sum / L);
        for (int i = 0; i < L; ++i) {
            const float d = row[i] - mean;
            sq += (double)d * d;
        }
        const float var = (float)(sq / L);
        const float invstd = 1.0f / sqrtf(var + eps);
        const float w = weight ? weight[c] : 1.0f;
        const float b = bias ? bias[c] : 0.0f;
        for (int i = 0; i < L; ++i) {
            row[i] = (row[i] - mean) * invstd * w + b;
        }
    }
}

/* 1D conv: `in` is [Cin, L], `out` is [Cout, L_out]. weight: [Cout, Cin, K].
 * bias: [Cout] or NULL. stride is the time stride. */
static void conv1d(const float *in, int Cin, int L,
                   const float *weight, const float *bias,
                   int Cout, int K, int stride,
                   float *out, int *L_out_p) {
    const int L_out = (L - K) / stride + 1;
    *L_out_p = L_out;
    for (int co = 0; co < Cout; ++co) {
        for (int t = 0; t < L_out; ++t) {
            const int x0 = t * stride;
            float acc = bias ? bias[co] : 0.0f;
            for (int ci = 0; ci < Cin; ++ci) {
                const float *w = weight + ((size_t)co * Cin + ci) * K;
                const float *xrow = in + (size_t)ci * L;
                for (int k = 0; k < K; ++k) {
                    acc += w[k] * xrow[x0 + k];
                }
            }
            out[(size_t)co * L_out + t] = acc;
        }
    }
}

/* MaxPool1D over [C, L] → [C, L_out]. */
static void max_pool_1d(const float *in, int C, int L,
                        int K, int stride,
                        float *out, int *L_out_p) {
    const int L_out = (L - K) / stride + 1;
    *L_out_p = L_out;
    for (int c = 0; c < C; ++c) {
        const float *row = in + (size_t)c * L;
        float *o = out + (size_t)c * L_out;
        for (int t = 0; t < L_out; ++t) {
            const int x0 = t * stride;
            float m = row[x0];
            for (int k = 1; k < K; ++k) {
                const float v = row[x0 + k];
                if (v > m) m = v;
            }
            o[t] = m;
        }
    }
}

static void abs_inplace(float *buf, size_t n) {
    for (size_t i = 0; i < n; ++i) buf[i] = fabsf(buf[i]);
}

static void leaky_relu_inplace(float *buf, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        if (buf[i] < 0.0f) buf[i] *= DIAR_LEAKY_ALPHA;
    }
}

/* Numerically-stable sigmoid. */
static inline float sigmoidf(float x) {
    if (x >= 0.0f) {
        const float e = expf(-x);
        return 1.0f / (1.0f + e);
    } else {
        const float e = expf(x);
        return e / (1.0f + e);
    }
}

/* One-direction LSTM step. Gates packed in I, F, G, O order
 * (matches the converter's reorder). `x_dot_W` is the
 * pre-computed x @ W_ih^T + b_ih, shape [T, 4H]. */
static void lstm_run_dir(const float *x_dot_W,
                         int T, int H,
                         const float *W_hh,   /* [4H, H] */
                         const float *b_hh,   /* [4H]    */
                         int reverse,
                         float *out_seq,      /* [T, H]  */
                         float *gate_buf,     /* scratch [4H] */
                         float *h_buf,        /* scratch [H]  */
                         float *c_buf) {      /* scratch [H]  */
    memset(h_buf, 0, (size_t)H * sizeof(float));
    memset(c_buf, 0, (size_t)H * sizeof(float));

    for (int step = 0; step < T; ++step) {
        const int t = reverse ? (T - 1 - step) : step;
        const float *xrow = x_dot_W + (size_t)t * 4 * H;

        /* gate_buf = xrow + h @ W_hh^T + b_hh */
        for (int g = 0; g < 4 * H; ++g) {
            float acc = xrow[g] + b_hh[g];
            const float *wrow = W_hh + (size_t)g * H;
            for (int j = 0; j < H; ++j) acc += wrow[j] * h_buf[j];
            gate_buf[g] = acc;
        }

        /* Apply nonlinearities. Gate order I, F, G, O. */
        const float *gi = gate_buf + 0 * H;
        const float *gf = gate_buf + 1 * H;
        const float *gg = gate_buf + 2 * H;
        const float *go = gate_buf + 3 * H;
        for (int j = 0; j < H; ++j) {
            const float i_t = sigmoidf(gi[j]);
            const float f_t = sigmoidf(gf[j]);
            const float g_t = tanhf(gg[j]);
            const float o_t = sigmoidf(go[j]);
            c_buf[j] = f_t * c_buf[j] + i_t * g_t;
            h_buf[j] = o_t * tanhf(c_buf[j]);
        }
        memcpy(out_seq + (size_t)t * H, h_buf, (size_t)H * sizeof(float));
    }
}

/* Bidirectional LSTM. `in_seq` is [T, in_size]; `out_seq` is [T, 2H].
 *
 * weights:
 *   W_ih: [2, 4H, in_size]  — direction 0 = forward, direction 1 = backward
 *   W_hh: [2, 4H, H]
 *   b_ih, b_hh: [2, 4H]
 */
static int bi_lstm(const float *in_seq, int T, int in_size,
                   const float *W_ih, const float *W_hh,
                   const float *b_ih, const float *b_hh,
                   int H,
                   float *out_seq) {
    const size_t four_H = (size_t)4 * H;
    /* x_dot_W[d=0..1]: [T, 4H] = in_seq @ W_ih[d]^T + b_ih[d] */
    float *xW_fwd = (float *)malloc((size_t)T * four_H * sizeof(float));
    float *xW_bwd = (float *)malloc((size_t)T * four_H * sizeof(float));
    float *fwd_h  = (float *)malloc((size_t)T * H * sizeof(float));
    float *bwd_h  = (float *)malloc((size_t)T * H * sizeof(float));
    float *gate_buf = (float *)malloc(four_H * sizeof(float));
    float *h_buf  = (float *)malloc((size_t)H * sizeof(float));
    float *c_buf  = (float *)malloc((size_t)H * sizeof(float));
    if (!xW_fwd || !xW_bwd || !fwd_h || !bwd_h || !gate_buf || !h_buf || !c_buf) {
        free(xW_fwd); free(xW_bwd); free(fwd_h); free(bwd_h);
        free(gate_buf); free(h_buf); free(c_buf);
        return -ENOMEM;
    }

    /* W_ih layout: [direction, 4H, in_size] row-major.
     * For direction d, W_ih[d] is at offset d * 4H * in_size. */
    const float *W_ih_fwd = W_ih + 0 * four_H * (size_t)in_size;
    const float *W_ih_bwd = W_ih + 1 * four_H * (size_t)in_size;
    const float *b_ih_fwd = b_ih + 0 * four_H;
    const float *b_ih_bwd = b_ih + 1 * four_H;

    for (int t = 0; t < T; ++t) {
        const float *xrow = in_seq + (size_t)t * in_size;
        float *of = xW_fwd + (size_t)t * four_H;
        float *ob = xW_bwd + (size_t)t * four_H;
        for (size_t g = 0; g < four_H; ++g) {
            float af = b_ih_fwd[g];
            float ab = b_ih_bwd[g];
            const float *wf = W_ih_fwd + g * (size_t)in_size;
            const float *wb = W_ih_bwd + g * (size_t)in_size;
            for (int j = 0; j < in_size; ++j) {
                af += wf[j] * xrow[j];
                ab += wb[j] * xrow[j];
            }
            of[g] = af;
            ob[g] = ab;
        }
    }

    const float *W_hh_fwd = W_hh + 0 * four_H * (size_t)H;
    const float *W_hh_bwd = W_hh + 1 * four_H * (size_t)H;
    const float *b_hh_fwd = b_hh + 0 * four_H;
    const float *b_hh_bwd = b_hh + 1 * four_H;

    lstm_run_dir(xW_fwd, T, H, W_hh_fwd, b_hh_fwd, /*reverse=*/0, fwd_h, gate_buf, h_buf, c_buf);
    lstm_run_dir(xW_bwd, T, H, W_hh_bwd, b_hh_bwd, /*reverse=*/1, bwd_h, gate_buf, h_buf, c_buf);

    for (int t = 0; t < T; ++t) {
        memcpy(out_seq + (size_t)t * 2 * H + 0,         fwd_h + (size_t)t * H, (size_t)H * sizeof(float));
        memcpy(out_seq + (size_t)t * 2 * H + H,         bwd_h + (size_t)t * H, (size_t)H * sizeof(float));
    }

    free(xW_fwd); free(xW_bwd); free(fwd_h); free(bwd_h);
    free(gate_buf); free(h_buf); free(c_buf);
    return 0;
}

/* y = x @ W^T + b. W is [out_features, in_features]. x is [T, in], y is [T, out]. */
static void linear_per_step(const float *x, int T, int in_features,
                            const float *W, const float *b,
                            int out_features, float *y) {
    for (int t = 0; t < T; ++t) {
        const float *xrow = x + (size_t)t * in_features;
        float *yrow = y + (size_t)t * out_features;
        for (int o = 0; o < out_features; ++o) {
            float acc = b ? b[o] : 0.0f;
            const float *wrow = W + (size_t)o * in_features;
            for (int j = 0; j < in_features; ++j) acc += wrow[j] * xrow[j];
            yrow[o] = acc;
        }
    }
}

/* ─── ABI: open / segment / close ─────────────────────────────────── */

/* Cache tensor pointers in the session struct so the forward path is
 * branch-free on lookups. */
static int diar_resolve_tensors(struct voice_diarizer_session *s) {
#define RESOLVE(field, name) do {                                       \
        const voice_gguf_tensor_t *t = voice_gguf_tensors_find(&s->tensors, name); \
        if (!t) { fprintf(stderr, "[voice_diarizer] missing tensor: %s\n", name); return -EINVAL; } \
        s->field = t->data;                                             \
    } while (0)

    RESOLVE(wnorm_w, "sincnet.norm_in.weight");
    RESOLVE(wnorm_b, "sincnet.norm_in.bias");
    RESOLVE(conv0_w, "sincnet.conv0.weight");
    RESOLVE(norm0_w, "sincnet.norm0.weight");
    RESOLVE(norm0_b, "sincnet.norm0.bias");
    RESOLVE(conv1_w, "sincnet.conv1.weight");
    RESOLVE(conv1_b, "sincnet.conv1.bias");
    RESOLVE(norm1_w, "sincnet.norm1.weight");
    RESOLVE(norm1_b, "sincnet.norm1.bias");
    RESOLVE(conv2_w, "sincnet.conv2.weight");
    RESOLVE(conv2_b, "sincnet.conv2.bias");
    RESOLVE(norm2_w, "sincnet.norm2.weight");
    RESOLVE(norm2_b, "sincnet.norm2.bias");
    RESOLVE(linear0_w, "linear0.weight");
    RESOLVE(linear0_b, "linear0.bias");
    RESOLVE(linear1_w, "linear1.weight");
    RESOLVE(linear1_b, "linear1.bias");
    RESOLVE(cls_w, "classifier.weight");
    RESOLVE(cls_b, "classifier.bias");

    for (int li = 0; li < DIAR_LSTM_LAYERS; ++li) {
        char name[64];
        snprintf(name, sizeof(name), "lstm.%d.W_ih", li);
        const voice_gguf_tensor_t *t1 = voice_gguf_tensors_find(&s->tensors, name);
        snprintf(name, sizeof(name), "lstm.%d.W_hh", li);
        const voice_gguf_tensor_t *t2 = voice_gguf_tensors_find(&s->tensors, name);
        snprintf(name, sizeof(name), "lstm.%d.b_ih", li);
        const voice_gguf_tensor_t *t3 = voice_gguf_tensors_find(&s->tensors, name);
        snprintf(name, sizeof(name), "lstm.%d.b_hh", li);
        const voice_gguf_tensor_t *t4 = voice_gguf_tensors_find(&s->tensors, name);
        if (!t1 || !t2 || !t3 || !t4) {
            fprintf(stderr, "[voice_diarizer] missing LSTM tensor at layer %d\n", li);
            return -EINVAL;
        }
        s->lstm_w_ih[li] = t1->data;
        s->lstm_w_hh[li] = t2->data;
        s->lstm_b_ih[li] = t3->data;
        s->lstm_b_hh[li] = t4->data;
    }
    return 0;
#undef RESOLVE
}

int voice_diarizer_open(const char *gguf, voice_diarizer_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    int rc = voice_gguf_load_metadata(gguf, "voice_diarizer", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.num_classes != 0 &&
        meta.num_classes != VOICE_DIARIZER_NUM_CLASSES) return -EINVAL;

    struct voice_diarizer_session *s =
        (struct voice_diarizer_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);

    rc = voice_gguf_tensors_open(gguf, &s->tensors);
    if (rc != 0) { free(s); return rc; }

    rc = diar_resolve_tensors(s);
    if (rc != 0) {
        voice_gguf_tensors_close(&s->tensors);
        free(s);
        return rc;
    }

    *out = (voice_diarizer_handle)s;
    return 0;
}

/* Compute argmax over 7 classes for one frame. */
static int argmax_7(const float *row) {
    int best = 0;
    float m = row[0];
    for (int c = 1; c < VOICE_DIARIZER_NUM_CLASSES; ++c) {
        if (row[c] > m) { m = row[c]; best = c; }
    }
    return best;
}

int voice_diarizer_segment(voice_diarizer_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           int8_t *labels_out,
                           size_t *frames_capacity_inout) {
    if (!h || !pcm_16khz || !labels_out || !frames_capacity_inout || n == 0) {
        if (frames_capacity_inout) *frames_capacity_inout = 0;
        return -EINVAL;
    }
    struct voice_diarizer_session *s = (struct voice_diarizer_session *)h;
    const int frames_per_window = s->meta.tensor_count > 0 ? DIAR_FRAMES_PER_WINDOW
                                                            : DIAR_FRAMES_PER_WINDOW;
    if (*frames_capacity_inout < (size_t)frames_per_window) {
        *frames_capacity_inout = (size_t)frames_per_window;
        return -ENOSPC;
    }

    /* Truncate / pad to exactly the window size. */
    const int window = DIAR_WINDOW_SAMPLES;
    float *buf_a = (float *)malloc((size_t)window * sizeof(float));
    if (!buf_a) return -ENOMEM;
    const size_t copy = (n < (size_t)window) ? n : (size_t)window;
    memcpy(buf_a, pcm_16khz, copy * sizeof(float));
    if (copy < (size_t)window) {
        memset(buf_a + copy, 0, ((size_t)window - copy) * sizeof(float));
    }

    /* Stage 1: wav_norm1d. Treat the single-channel signal as [1, window]
     * for inst_norm. */
    inst_norm_1d_inplace(buf_a, /*C=*/1, window, s->wnorm_w, s->wnorm_b, 1e-5f);

    /* Stage 2: sinc Conv1d (80 filters, kernel=251, stride=10), no bias. */
    int L1 = (window - DIAR_SINC_KERNEL) / DIAR_SINC_STRIDE + 1;  /* 7975 */
    float *buf_b = (float *)malloc((size_t)DIAR_SINC_FILTERS * L1 * sizeof(float));
    if (!buf_b) { free(buf_a); return -ENOMEM; }
    conv1d(buf_a, /*Cin=*/1, window, s->conv0_w, NULL,
           DIAR_SINC_FILTERS, DIAR_SINC_KERNEL, DIAR_SINC_STRIDE,
           buf_b, &L1);
    free(buf_a);

    /* |abs| over the response. */
    abs_inplace(buf_b, (size_t)DIAR_SINC_FILTERS * L1);

    /* MaxPool(3, 3). */
    int L2 = (L1 - DIAR_MAXPOOL_KERNEL) / DIAR_MAXPOOL_STRIDE + 1;  /* 2658 */
    float *buf_c = (float *)malloc((size_t)DIAR_SINC_FILTERS * L2 * sizeof(float));
    if (!buf_c) { free(buf_b); return -ENOMEM; }
    max_pool_1d(buf_b, DIAR_SINC_FILTERS, L1,
                DIAR_MAXPOOL_KERNEL, DIAR_MAXPOOL_STRIDE, buf_c, &L2);
    free(buf_b);

    /* InstanceNorm + LeakyReLU. */
    inst_norm_1d_inplace(buf_c, DIAR_SINC_FILTERS, L2, s->norm0_w, s->norm0_b, 1e-5f);
    leaky_relu_inplace(buf_c, (size_t)DIAR_SINC_FILTERS * L2);

    /* Stage 3: Conv1d (80 → 60, kernel=5). */
    int L3 = (L2 - DIAR_CONV_KERNEL) / 1 + 1;  /* 2654 */
    float *buf_d = (float *)malloc((size_t)DIAR_CONV1_OUT * L3 * sizeof(float));
    if (!buf_d) { free(buf_c); return -ENOMEM; }
    conv1d(buf_c, DIAR_SINC_FILTERS, L2, s->conv1_w, s->conv1_b,
           DIAR_CONV1_OUT, DIAR_CONV_KERNEL, 1, buf_d, &L3);
    free(buf_c);

    int L4 = (L3 - DIAR_MAXPOOL_KERNEL) / DIAR_MAXPOOL_STRIDE + 1;  /* 884 */
    float *buf_e = (float *)malloc((size_t)DIAR_CONV1_OUT * L4 * sizeof(float));
    if (!buf_e) { free(buf_d); return -ENOMEM; }
    max_pool_1d(buf_d, DIAR_CONV1_OUT, L3,
                DIAR_MAXPOOL_KERNEL, DIAR_MAXPOOL_STRIDE, buf_e, &L4);
    free(buf_d);
    inst_norm_1d_inplace(buf_e, DIAR_CONV1_OUT, L4, s->norm1_w, s->norm1_b, 1e-5f);
    leaky_relu_inplace(buf_e, (size_t)DIAR_CONV1_OUT * L4);

    /* Stage 4: Conv1d (60 → 60, kernel=5). */
    int L5 = (L4 - DIAR_CONV_KERNEL) / 1 + 1;  /* 880 */
    float *buf_f = (float *)malloc((size_t)DIAR_CONV2_OUT * L5 * sizeof(float));
    if (!buf_f) { free(buf_e); return -ENOMEM; }
    conv1d(buf_e, DIAR_CONV1_OUT, L4, s->conv2_w, s->conv2_b,
           DIAR_CONV2_OUT, DIAR_CONV_KERNEL, 1, buf_f, &L5);
    free(buf_e);

    int L6 = (L5 - DIAR_MAXPOOL_KERNEL) / DIAR_MAXPOOL_STRIDE + 1;  /* 293 */
    float *buf_g = (float *)malloc((size_t)DIAR_CONV2_OUT * L6 * sizeof(float));
    if (!buf_g) { free(buf_f); return -ENOMEM; }
    max_pool_1d(buf_f, DIAR_CONV2_OUT, L5,
                DIAR_MAXPOOL_KERNEL, DIAR_MAXPOOL_STRIDE, buf_g, &L6);
    free(buf_f);
    inst_norm_1d_inplace(buf_g, DIAR_CONV2_OUT, L6, s->norm2_w, s->norm2_b, 1e-5f);
    leaky_relu_inplace(buf_g, (size_t)DIAR_CONV2_OUT * L6);

    /* Stage 5: transpose to [T, 60]. T should be 293. */
    if (L6 != frames_per_window) {
        free(buf_g);
        *frames_capacity_inout = 0;
        return -EINVAL;
    }
    const int T = L6;
    float *seq_a = (float *)malloc((size_t)T * DIAR_CONV2_OUT * sizeof(float));
    if (!seq_a) { free(buf_g); return -ENOMEM; }
    for (int c = 0; c < DIAR_CONV2_OUT; ++c) {
        for (int t = 0; t < T; ++t) {
            seq_a[(size_t)t * DIAR_CONV2_OUT + c] = buf_g[(size_t)c * T + t];
        }
    }
    free(buf_g);

    /* Stage 6: BiLSTM × 4. */
    int in_size = DIAR_CONV2_OUT;
    float *seq_in = seq_a;
    float *seq_out = NULL;
    for (int li = 0; li < DIAR_LSTM_LAYERS; ++li) {
        seq_out = (float *)malloc((size_t)T * DIAR_LSTM_OUT * sizeof(float));
        if (!seq_out) { free(seq_in); return -ENOMEM; }
        int rc = bi_lstm(seq_in, T, in_size,
                          s->lstm_w_ih[li], s->lstm_w_hh[li],
                          s->lstm_b_ih[li], s->lstm_b_hh[li],
                          DIAR_LSTM_HIDDEN, seq_out);
        free(seq_in);
        if (rc != 0) { free(seq_out); return rc; }
        seq_in = seq_out;
        in_size = DIAR_LSTM_OUT;
    }
    /* seq_in is [T, 256] */

    /* Stage 7: Linear(256→128) + LeakyReLU. */
    float *lin0_out = (float *)malloc((size_t)T * DIAR_LINEAR0_OUT * sizeof(float));
    if (!lin0_out) { free(seq_in); return -ENOMEM; }
    linear_per_step(seq_in, T, DIAR_LSTM_OUT,
                    s->linear0_w, s->linear0_b, DIAR_LINEAR0_OUT, lin0_out);
    free(seq_in);
    leaky_relu_inplace(lin0_out, (size_t)T * DIAR_LINEAR0_OUT);

    /* Linear(128→128) + LeakyReLU. */
    float *lin1_out = (float *)malloc((size_t)T * DIAR_LINEAR1_OUT * sizeof(float));
    if (!lin1_out) { free(lin0_out); return -ENOMEM; }
    linear_per_step(lin0_out, T, DIAR_LINEAR0_OUT,
                    s->linear1_w, s->linear1_b, DIAR_LINEAR1_OUT, lin1_out);
    free(lin0_out);
    leaky_relu_inplace(lin1_out, (size_t)T * DIAR_LINEAR1_OUT);

    /* Linear(128→7). */
    float *cls_out = (float *)malloc((size_t)T * VOICE_DIARIZER_NUM_CLASSES * sizeof(float));
    if (!cls_out) { free(lin1_out); return -ENOMEM; }
    linear_per_step(lin1_out, T, DIAR_LINEAR1_OUT,
                    s->cls_w, s->cls_b, VOICE_DIARIZER_NUM_CLASSES, cls_out);
    free(lin1_out);

    /* Stage 8: argmax over 7 classes per frame. We don't actually need
     * log-softmax because argmax is invariant under monotone transforms;
     * we operate on raw logits. */
    for (int t = 0; t < T; ++t) {
        labels_out[t] = (int8_t)argmax_7(cls_out + (size_t)t * VOICE_DIARIZER_NUM_CLASSES);
    }
    free(cls_out);

    *frames_capacity_inout = (size_t)T;
    return 0;
}

int voice_diarizer_close(voice_diarizer_handle h) {
    if (h == NULL) return 0;
    struct voice_diarizer_session *s = (struct voice_diarizer_session *)h;
    voice_gguf_tensors_close(&s->tensors);
    free(s);
    return 0;
}
