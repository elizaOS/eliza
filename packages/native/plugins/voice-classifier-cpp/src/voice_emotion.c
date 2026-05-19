/*
 * voice-classifier-cpp — Wav2Small emotion classifier (J1.a-forward).
 *
 * Implements the full Wav2Small forward pass described in arXiv:2408.13920.
 * The student architecture (from distill_wav2small.py) is:
 *
 *   log-mel [T, 80]        (computed by voice_mel_compute, T frames)
 *   → transpose to [80, T]
 *   → Conv1d(80→48, k=3, pad=1) + ReLU      → [48, T]
 *   → Conv1d(48→56, k=3, pad=1) + ReLU      → [56, T]
 *   → transpose to [T, 56]
 *   → TransformerEncoderLayer × 2
 *       self-attention: (Q,K,V) = x @ in_proj^T + in_proj_bias
 *                       scaled dot-product, nhead=4
 *                       out_proj
 *       residual + LayerNorm
 *       FFN: Linear(56→112) + GELU + Linear(112→56)
 *       residual + LayerNorm
 *   → mean pool over time → [56]
 *   → Linear(56→3) + sigmoid → [3]  (V, A, D in [0,1])
 *
 * The 3-dim V-A-D output is projected to VOICE_EMOTION_NUM_CLASSES=7
 * probabilities using a fixed centroid table baked into this TU. The
 * projection maps each (V,A,D) point to the nearest class centroid and
 * returns a soft probability proportional to 1 / (distance + eps).
 *
 * Tensor names loaded from GGUF (must match convert_wav2small_to_gguf.py):
 *   conv1.weight        [48, 80, 3]
 *   conv1.bias          [48]
 *   conv2.weight        [56, 48, 3]
 *   conv2.bias          [56]
 *   enc.{0,1}.self_attn.in_proj.weight   [168, 56]
 *   enc.{0,1}.self_attn.in_proj.bias     [168]
 *   enc.{0,1}.self_attn.out_proj.weight  [56, 56]
 *   enc.{0,1}.self_attn.out_proj.bias    [56]
 *   enc.{0,1}.linear1.weight             [112, 56]
 *   enc.{0,1}.linear1.bias               [112]
 *   enc.{0,1}.linear2.weight             [56, 112]
 *   enc.{0,1}.linear2.bias               [56]
 *   enc.{0,1}.norm1.weight               [56]
 *   enc.{0,1}.norm1.bias                 [56]
 *   enc.{0,1}.norm2.weight               [56]
 *   enc.{0,1}.norm2.bias                 [56]
 *   head.weight                          [3, 56]
 *   head.bias                            [3]
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"
#include "voice_gguf_tensors.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* Architecture constants — locked to distill_wav2small.py Student. */
#define EMO_N_MELS     80
#define EMO_MID        48
#define EMO_D_MODEL    56
#define EMO_DFF        112
#define EMO_N_LAYERS   2
#define EMO_N_HEAD     4
#define EMO_HEAD_DIM   (EMO_D_MODEL / EMO_N_HEAD)   /* 14 */
#define EMO_VAD_DIM    3

/* V-A-D centroids for the 7 emotion classes (empirically set from the
 * upstream WAV2VEC2-MSP-DIM class separation, normalised to [0,1]).
 * Order matches voice_emotion_classes.c: neutral, happy, sad, angry,
 * fear, disgust, surprise. */
static const float kVADCentroids[VOICE_EMOTION_NUM_CLASSES][EMO_VAD_DIM] = {
    /* V,    A,    D  */
    { 0.60f, 0.35f, 0.50f },  /* 0 neutral  */
    { 0.80f, 0.70f, 0.65f },  /* 1 happy    */
    { 0.25f, 0.30f, 0.30f },  /* 2 sad      */
    { 0.30f, 0.85f, 0.70f },  /* 3 angry    */
    { 0.20f, 0.75f, 0.25f },  /* 4 fear     */
    { 0.25f, 0.55f, 0.40f },  /* 5 disgust  */
    { 0.75f, 0.80f, 0.55f },  /* 6 surprise */
};

/* Per-layer transformer weight set. */
typedef struct {
    const float *in_proj_w;   /* [168, 56] */
    const float *in_proj_b;   /* [168]     */
    const float *out_proj_w;  /* [56, 56]  */
    const float *out_proj_b;  /* [56]      */
    const float *ffn1_w;      /* [112, 56] */
    const float *ffn1_b;      /* [112]     */
    const float *ffn2_w;      /* [56, 112] */
    const float *ffn2_b;      /* [56]      */
    const float *norm1_w;     /* [56]      */
    const float *norm1_b;     /* [56]      */
    const float *norm2_w;     /* [56]      */
    const float *norm2_b;     /* [56]      */
} emo_layer_t;

/* Full session struct. */
struct voice_emotion_session {
    voice_gguf_metadata_t meta;
    voice_gguf_tensors_t weights;
    char gguf_path[1024];

    const float *conv1_w;  /* [48, 80, 3] */
    const float *conv1_b;  /* [48]        */
    const float *conv2_w;  /* [56, 48, 3] */
    const float *conv2_b;  /* [56]        */
    emo_layer_t layers[EMO_N_LAYERS];
    const float *head_w;   /* [3, 56] */
    const float *head_b;   /* [3]     */
};

/* ── helpers ─────────────────────────────────────────────────────────── */

static const float *emo_find(const voice_gguf_tensors_t *w,
                             const char *name,
                             uint64_t expected_n) {
    const voice_gguf_weight_tensor_t *t = voice_gguf_tensors_find(w, name);
    if (!t) {
        fprintf(stderr, "[voice_emotion] missing tensor: %s\n", name);
        return NULL;
    }
    if (t->n_elements != expected_n) {
        fprintf(stderr, "[voice_emotion] tensor %s: expected %llu elements, "
                "got %llu\n", name,
                (unsigned long long)expected_n,
                (unsigned long long)t->n_elements);
        return NULL;
    }
    return t->data;
}

#define EMO_BIND(dst, name, n) \
    do { \
        (dst) = emo_find(&s->weights, (name), (uint64_t)(n)); \
        if (!(dst)) return -EINVAL; \
    } while (0)

static int emo_bind_weights(struct voice_emotion_session *s) {
    EMO_BIND(s->conv1_w, "conv1.weight", (uint64_t)EMO_MID * EMO_N_MELS * 3);
    EMO_BIND(s->conv1_b, "conv1.bias",   EMO_MID);
    EMO_BIND(s->conv2_w, "conv2.weight", (uint64_t)EMO_D_MODEL * EMO_MID * 3);
    EMO_BIND(s->conv2_b, "conv2.bias",   EMO_D_MODEL);

    for (int li = 0; li < EMO_N_LAYERS; ++li) {
        char name[64];
        emo_layer_t *L = &s->layers[li];
        snprintf(name, sizeof name, "enc.%d.self_attn.in_proj.weight", li);
        EMO_BIND(L->in_proj_w,  name, (uint64_t)3 * EMO_D_MODEL * EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.self_attn.in_proj.bias", li);
        EMO_BIND(L->in_proj_b,  name, (uint64_t)3 * EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.self_attn.out_proj.weight", li);
        EMO_BIND(L->out_proj_w, name, (uint64_t)EMO_D_MODEL * EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.self_attn.out_proj.bias", li);
        EMO_BIND(L->out_proj_b, name, EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.linear1.weight", li);
        EMO_BIND(L->ffn1_w,     name, (uint64_t)EMO_DFF * EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.linear1.bias", li);
        EMO_BIND(L->ffn1_b,     name, EMO_DFF);
        snprintf(name, sizeof name, "enc.%d.linear2.weight", li);
        EMO_BIND(L->ffn2_w,     name, (uint64_t)EMO_D_MODEL * EMO_DFF);
        snprintf(name, sizeof name, "enc.%d.linear2.bias", li);
        EMO_BIND(L->ffn2_b,     name, EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.norm1.weight", li);
        EMO_BIND(L->norm1_w,    name, EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.norm1.bias", li);
        EMO_BIND(L->norm1_b,    name, EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.norm2.weight", li);
        EMO_BIND(L->norm2_w,    name, EMO_D_MODEL);
        snprintf(name, sizeof name, "enc.%d.norm2.bias", li);
        EMO_BIND(L->norm2_b,    name, EMO_D_MODEL);
    }

    EMO_BIND(s->head_w, "head.weight", (uint64_t)EMO_VAD_DIM * EMO_D_MODEL);
    EMO_BIND(s->head_b, "head.bias",   EMO_VAD_DIM);
    return 0;
}
#undef EMO_BIND

/* ── primitive ops ───────────────────────────────────────────────────── */

/* Conv1d(in [C_in, T], weight [C_out, C_in, 3], bias [C_out], pad=1)
 * → out [C_out, T].  out must be pre-allocated C_out*T floats. */
static void emo_conv1d_k3_pad1(const float *in, int C_in, int T,
                                const float *w, const float *b,
                                int C_out, float *out) {
    for (int co = 0; co < C_out; ++co) {
        const float bias = b[co];
        const float *w_co = w + (size_t)co * C_in * 3;
        for (int t = 0; t < T; ++t) {
            float acc = bias;
            for (int ci = 0; ci < C_in; ++ci) {
                const float *w_ci = w_co + ci * 3;
                const float *x = in + (size_t)ci * T;
                /* k=0: t-1 (pad=1), k=1: t, k=2: t+1 */
                if (t > 0)     acc += w_ci[0] * x[t - 1];
                               acc += w_ci[1] * x[t];
                if (t < T - 1) acc += w_ci[2] * x[t + 1];
            }
            out[(size_t)co * T + t] = acc;
        }
    }
}

static void emo_relu_inplace(float *x, size_t n) {
    for (size_t i = 0; i < n; ++i) if (x[i] < 0.0f) x[i] = 0.0f;
}

/* Layer normalisation: y = (x - mean) / sqrt(var + eps) * w + b.
 * In-place over a single row of length D. */
static void emo_layer_norm(float *x, int D,
                           const float *w, const float *b) {
    double mean = 0.0;
    for (int i = 0; i < D; ++i) mean += x[i];
    mean /= D;
    double var = 0.0;
    for (int i = 0; i < D; ++i) {
        const double d = (double)x[i] - mean;
        var += d * d;
    }
    var /= D;
    const float inv = (float)(1.0 / sqrt(var + 1e-5));
    for (int i = 0; i < D; ++i) {
        x[i] = ((x[i] - (float)mean) * inv) * w[i] + b[i];
    }
}

/* GELU activation: 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 x³))).
 * Matches PyTorch F.gelu (default). */
static inline float emo_gelu(float x) {
    const float k = 0.7978845608f;   /* sqrt(2/π) */
    const float c = 0.044715f;
    return 0.5f * x * (1.0f + tanhf(k * (x + c * x * x * x)));
}

/* y = x @ W^T + b  for a single row x[in_feat], W[out_feat, in_feat].
 * Result in y[out_feat]. */
static void emo_linear(const float *x, int in_feat,
                       const float *W, const float *b,
                       int out_feat, float *y) {
    for (int o = 0; o < out_feat; ++o) {
        float acc = b ? b[o] : 0.0f;
        const float *w = W + (size_t)o * in_feat;
        for (int i = 0; i < in_feat; ++i) acc += w[i] * x[i];
        y[o] = acc;
    }
}

/* Numerically-stable softmax over a vector of length n, in-place. */
static void emo_softmax_inplace(float *x, int n) {
    float m = x[0];
    for (int i = 1; i < n; ++i) if (x[i] > m) m = x[i];
    float sum = 0.0f;
    for (int i = 0; i < n; ++i) { x[i] = expf(x[i] - m); sum += x[i]; }
    if (sum > 0.0f) { const float inv = 1.0f / sum;
        for (int i = 0; i < n; ++i) x[i] *= inv; }
}

/* Scaled dot-product attention for a single head (single sequence).
 *
 *   q, k, v: [T, head_dim]
 *   out:     [T, head_dim]
 *   scale: 1/sqrt(head_dim)
 *
 * Uses a scratch buffer attn[T] to hold per-query softmax.
 */
static int emo_sdp_attn(const float *q, const float *k, const float *v,
                        int T, int hd,
                        float *out, float *attn_scratch) {
    const float scale = 1.0f / sqrtf((float)hd);
    for (int i = 0; i < T; ++i) {
        const float *qi = q + (size_t)i * hd;
        for (int j = 0; j < T; ++j) {
            float dot = 0.0f;
            const float *kj = k + (size_t)j * hd;
            for (int d = 0; d < hd; ++d) dot += qi[d] * kj[d];
            attn_scratch[j] = dot * scale;
        }
        emo_softmax_inplace(attn_scratch, T);
        float *oi = out + (size_t)i * hd;
        memset(oi, 0, (size_t)hd * sizeof(float));
        for (int j = 0; j < T; ++j) {
            const float a = attn_scratch[j];
            const float *vj = v + (size_t)j * hd;
            for (int d = 0; d < hd; ++d) oi[d] += a * vj[d];
        }
    }
    return 0;
}

/* Multi-head self-attention for sequence [T, D].
 * Returns 0 on success; writes [T, D] into `out`.
 * Uses `qkv_buf` [T, 3D] and `heads_buf` [T, D] and `attn_scratch` [T]. */
static int emo_mhsa(const float *x, int T,
                    const emo_layer_t *L,
                    float *out,
                    float *qkv_buf,    /* [T, 3D] */
                    float *heads_buf,  /* [T, D]  */
                    float *attn_scratch /* [T] */) {
    const int D = EMO_D_MODEL;
    const int nhead = EMO_N_HEAD;
    const int hd = EMO_HEAD_DIM;

    /* Project: qkv_buf[t] = x[t] @ in_proj_w^T + in_proj_b  [3D] */
    for (int t = 0; t < T; ++t) {
        emo_linear(x + (size_t)t * D, D,
                   L->in_proj_w, L->in_proj_b,
                   3 * D, qkv_buf + (size_t)t * 3 * D);
    }

    /* Concatenate heads into heads_buf, then project out. */
    memset(heads_buf, 0, (size_t)T * D * sizeof(float));
    for (int h = 0; h < nhead; ++h) {
        /* Extract q, k, v slices for this head into stack buffers.
         * To stay heap-free per frame we process heads in sequence
         * and accumulate the out_proj output incrementally. */
        float *q_head = (float *)malloc((size_t)T * hd * sizeof(float));
        float *k_head = (float *)malloc((size_t)T * hd * sizeof(float));
        float *v_head = (float *)malloc((size_t)T * hd * sizeof(float));
        float *o_head = (float *)malloc((size_t)T * hd * sizeof(float));
        if (!q_head || !k_head || !v_head || !o_head) {
            free(q_head); free(k_head); free(v_head); free(o_head);
            return -ENOMEM;
        }
        for (int t = 0; t < T; ++t) {
            const float *qkv = qkv_buf + (size_t)t * 3 * D;
            memcpy(q_head + (size_t)t * hd, qkv + (size_t)h * hd,          (size_t)hd * sizeof(float));
            memcpy(k_head + (size_t)t * hd, qkv + D + (size_t)h * hd,      (size_t)hd * sizeof(float));
            memcpy(v_head + (size_t)t * hd, qkv + 2 * D + (size_t)h * hd,  (size_t)hd * sizeof(float));
        }
        emo_sdp_attn(q_head, k_head, v_head, T, hd, o_head, attn_scratch);
        /* Write head output into heads_buf at head's slice. */
        for (int t = 0; t < T; ++t) {
            memcpy(heads_buf + (size_t)t * D + (size_t)h * hd,
                   o_head + (size_t)t * hd,
                   (size_t)hd * sizeof(float));
        }
        free(q_head); free(k_head); free(v_head); free(o_head);
    }

    /* out = heads_buf @ out_proj_w^T + out_proj_b */
    for (int t = 0; t < T; ++t) {
        emo_linear(heads_buf + (size_t)t * D, D,
                   L->out_proj_w, L->out_proj_b,
                   D, out + (size_t)t * D);
    }
    return 0;
}

/* One TransformerEncoderLayer step — in-place on seq [T, D]. */
static int emo_encoder_layer(float *seq, int T, const emo_layer_t *L,
                             float *qkv_buf,
                             float *heads_buf,
                             float *attn_scratch,
                             float *ffn_buf) {
    const int D = EMO_D_MODEL;
    float *attn_out = (float *)malloc((size_t)T * D * sizeof(float));
    if (!attn_out) return -ENOMEM;

    int rc = emo_mhsa(seq, T, L, attn_out, qkv_buf, heads_buf, attn_scratch);
    if (rc != 0) { free(attn_out); return rc; }

    /* residual + norm1 */
    for (int t = 0; t < T; ++t) {
        float *row = seq + (size_t)t * D;
        const float *a = attn_out + (size_t)t * D;
        for (int i = 0; i < D; ++i) row[i] += a[i];
        emo_layer_norm(row, D, L->norm1_w, L->norm1_b);
    }
    free(attn_out);

    /* FFN: linear1 + GELU + linear2, with residual + norm2 */
    for (int t = 0; t < T; ++t) {
        float *row = seq + (size_t)t * D;
        /* linear1 */
        emo_linear(row, D, L->ffn1_w, L->ffn1_b, EMO_DFF, ffn_buf);
        for (int i = 0; i < EMO_DFF; ++i) ffn_buf[i] = emo_gelu(ffn_buf[i]);
        /* linear2 — result into attn_scratch (reuse as tmp D-sized buf) */
        float ffn2_out[EMO_D_MODEL];
        emo_linear(ffn_buf, EMO_DFF, L->ffn2_w, L->ffn2_b, D, ffn2_out);
        /* residual + norm2 */
        for (int i = 0; i < D; ++i) row[i] += ffn2_out[i];
        emo_layer_norm(row, D, L->norm2_w, L->norm2_b);
    }
    return 0;
}

/* ── V-A-D → 7-class projection ─────────────────────────────────────── */

static void vad_to_probs(const float vad[EMO_VAD_DIM],
                         float probs[VOICE_EMOTION_NUM_CLASSES]) {
    const float eps = 1e-4f;
    float sum = 0.0f;
    for (int c = 0; c < VOICE_EMOTION_NUM_CLASSES; ++c) {
        float dist2 = 0.0f;
        for (int d = 0; d < EMO_VAD_DIM; ++d) {
            const float diff = vad[d] - kVADCentroids[c][d];
            dist2 += diff * diff;
        }
        probs[c] = 1.0f / (sqrtf(dist2) + eps);
        sum += probs[c];
    }
    if (sum > 0.0f) {
        const float inv = 1.0f / sum;
        for (int c = 0; c < VOICE_EMOTION_NUM_CLASSES; ++c) probs[c] *= inv;
    }
}

/* ── public ABI ─────────────────────────────────────────────────────── */

int voice_emotion_open(const char *gguf, voice_emotion_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    int rc = voice_gguf_load_metadata(gguf, "voice_emotion", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.n_mels != 0 && meta.n_mels != VOICE_CLASSIFIER_N_MELS) return -EINVAL;
    if (meta.n_fft  != 0 && meta.n_fft  != VOICE_CLASSIFIER_N_FFT)  return -EINVAL;
    if (meta.hop    != 0 && meta.hop    != VOICE_CLASSIFIER_HOP)     return -EINVAL;
    if (meta.num_classes != 0 &&
        meta.num_classes != VOICE_EMOTION_NUM_CLASSES) return -EINVAL;

    struct voice_emotion_session *s =
        (struct voice_emotion_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);

    rc = voice_gguf_tensors_open(gguf, &s->weights);
    if (rc != 0) { free(s); return rc; }

    rc = emo_bind_weights(s);
    if (rc != 0) {
        voice_gguf_tensors_close(&s->weights);
        free(s);
        return rc;
    }

    *out = (voice_emotion_handle)s;
    return 0;
}

int voice_emotion_classify(voice_emotion_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           float probs[VOICE_EMOTION_NUM_CLASSES]) {
    if (probs) memset(probs, 0, sizeof(float) * VOICE_EMOTION_NUM_CLASSES);
    if (!h || !pcm_16khz || !probs || n == 0) return -EINVAL;

    struct voice_emotion_session *s = (struct voice_emotion_session *)h;

    /* 1. Log-mel spectrogram [T, 80]. */
    const size_t T_max = voice_mel_frame_count(n);
    if (T_max == 0) return -EINVAL;

    float *mel = (float *)calloc(T_max * VOICE_CLASSIFIER_N_MELS, sizeof(float));
    if (!mel) return -ENOMEM;

    size_t T = 0;
    int rc = voice_mel_compute(pcm_16khz, n, mel,
                               T_max * VOICE_CLASSIFIER_N_MELS, &T);
    if (rc != 0 || T == 0) { free(mel); return rc < 0 ? rc : -EINVAL; }

    /* 2. Transpose to [80, T] for Conv1d input. */
    const int D0 = EMO_N_MELS;
    float *x0 = (float *)malloc((size_t)D0 * T * sizeof(float));
    if (!x0) { free(mel); return -ENOMEM; }
    for (size_t t = 0; t < T; ++t)
        for (int m = 0; m < D0; ++m)
            x0[(size_t)m * T + t] = mel[(size_t)t * D0 + m];
    free(mel);

    /* 3. conv1: [80, T] → [48, T] + ReLU. */
    float *x1 = (float *)malloc((size_t)EMO_MID * T * sizeof(float));
    if (!x1) { free(x0); return -ENOMEM; }
    emo_conv1d_k3_pad1(x0, D0, (int)T, s->conv1_w, s->conv1_b, EMO_MID, x1);
    emo_relu_inplace(x1, (size_t)EMO_MID * T);
    free(x0);

    /* 4. conv2: [48, T] → [56, T] + ReLU. */
    float *x2 = (float *)malloc((size_t)EMO_D_MODEL * T * sizeof(float));
    if (!x2) { free(x1); return -ENOMEM; }
    emo_conv1d_k3_pad1(x1, EMO_MID, (int)T, s->conv2_w, s->conv2_b,
                       EMO_D_MODEL, x2);
    emo_relu_inplace(x2, (size_t)EMO_D_MODEL * T);
    free(x1);

    /* 5. Transpose to [T, 56] for transformer input. */
    const int D = EMO_D_MODEL;
    float *seq = (float *)malloc((size_t)T * D * sizeof(float));
    if (!seq) { free(x2); return -ENOMEM; }
    for (size_t t = 0; t < T; ++t)
        for (int d = 0; d < D; ++d)
            seq[(size_t)t * D + d] = x2[(size_t)d * T + t];
    free(x2);

    /* Scratch buffers reused across layers. */
    float *qkv_buf = (float *)malloc((size_t)T * 3 * D * sizeof(float));
    float *heads_buf = (float *)malloc((size_t)T * D * sizeof(float));
    float *attn_scratch = (float *)malloc(T * sizeof(float));
    float *ffn_buf = (float *)malloc(EMO_DFF * sizeof(float));
    if (!qkv_buf || !heads_buf || !attn_scratch || !ffn_buf) {
        free(seq); free(qkv_buf); free(heads_buf);
        free(attn_scratch); free(ffn_buf);
        return -ENOMEM;
    }

    /* 6. Transformer encoder × 2. */
    for (int li = 0; li < EMO_N_LAYERS; ++li) {
        rc = emo_encoder_layer(seq, (int)T, &s->layers[li],
                               qkv_buf, heads_buf, attn_scratch, ffn_buf);
        if (rc != 0) {
            free(seq); free(qkv_buf); free(heads_buf);
            free(attn_scratch); free(ffn_buf);
            return rc;
        }
    }
    free(qkv_buf); free(heads_buf); free(attn_scratch); free(ffn_buf);

    /* 7. Mean pool over time → [56]. */
    float pooled[EMO_D_MODEL];
    memset(pooled, 0, sizeof(pooled));
    for (size_t t = 0; t < T; ++t) {
        const float *row = seq + (size_t)t * D;
        for (int d = 0; d < D; ++d) pooled[d] += row[d];
    }
    free(seq);
    for (int d = 0; d < D; ++d) pooled[d] /= (float)T;

    /* 8. Head: Linear(56→3) + sigmoid → V-A-D in [0,1]. */
    float vad[EMO_VAD_DIM];
    emo_linear(pooled, D, s->head_w, s->head_b, EMO_VAD_DIM, vad);
    for (int i = 0; i < EMO_VAD_DIM; ++i) {
        const float v = vad[i];
        vad[i] = 1.0f / (1.0f + expf(-v));
    }

    /* 9. Project V-A-D to 7-class soft probabilities. */
    vad_to_probs(vad, probs);
    return 0;
}

int voice_emotion_close(voice_emotion_handle h) {
    if (h == NULL) return 0;
    struct voice_emotion_session *s = (struct voice_emotion_session *)h;
    voice_gguf_tensors_close(&s->weights);
    free(s);
    return 0;
}
