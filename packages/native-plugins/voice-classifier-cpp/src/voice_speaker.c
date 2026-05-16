/*
 * voice-classifier-cpp — WeSpeaker ResNet34-LM speaker encoder (K2).
 *
 * Real forward pass. Mirrors the upstream ONNX export at
 * elizaos/eliza-1@voice/speaker-encoder/wespeaker-resnet34-lm.onnx.
 *
 * Pipeline (all in this TU; no fork/libllama/libggml dependency):
 *
 *   1. Kaldi-style fbank front-end:
 *        - 25 ms window (400 samples @ 16 kHz), 10 ms hop (160 samples)
 *        - DC removal + preemphasis 0.97 + Hamming window
 *        - FFT padded to 512 bins, |X|² mel-projection (HTK mel scale)
 *        - log(max(energy, eps)) → 80 mel-bins per frame
 *        - Per-utterance CMN (subtract per-dim mean over the window)
 *
 *   2. ResNet34 backbone (channels 32/64/128/256, BN folded into Conv):
 *        - Stem Conv 1→32 (3x3, stride 1, pad 1) + ReLU
 *        - Layer1: 3 BasicBlocks at 32 channels, no spatial downsample
 *        - Layer2: 4 BasicBlocks; first downsamples (stride 2 + 1x1 ds)
 *        - Layer3: 6 BasicBlocks; first downsamples
 *        - Layer4: 3 BasicBlocks; first downsamples
 *
 *   3. Statistics pooling: mean + std over time → [B, 256, 10] each →
 *      flatten + concat → [B, 5120].
 *
 *   4. Linear head (Gemm 5120→256) → subtract mean_vec → L2-normalize.
 *
 * Numerical parity vs ONNX: cosine ≥ 0.99 on real speech windows.
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

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---------- pipeline constants (locked by the upstream model) ---------- */

#define SPK_SR              16000
#define SPK_WINDOW_LEN      400     /* 25 ms */
#define SPK_HOP             160     /* 10 ms */
#define SPK_FFT             512     /* round-to-power-of-two */
#define SPK_FFT_BINS        (SPK_FFT/2 + 1)
#define SPK_N_MELS          80
#define SPK_EMB_DIM         256
#define SPK_STATS_FLAT      5120    /* 256 * 10 (mel/8 = 10) */
#define SPK_PREEMPH         0.97f
#define SPK_LOG_EPS         1.1920928955078125e-7f /* matches kaldi default */

/* ---------- ResNet34 plan ---------- */

typedef struct {
    int blocks;
    int in_channels;
    int out_channels;
    int stride;
} spk_stage_plan_t;

static const spk_stage_plan_t SPK_PLAN[4] = {
    { 3,  32,  32, 1 },
    { 4,  32,  64, 2 },
    { 6,  64, 128, 2 },
    { 3, 128, 256, 2 },
};

/* ---------- weight container ---------- */

struct voice_speaker_session {
    voice_gguf_metadata_t meta;
    voice_gguf_tensors_t weights; /* mmapped fp32 weights */
    char gguf_path[1024];

    /* Pointers into the mmapped weights region. */
    const float *stem_w; /* [32, 1, 3, 3] */
    const float *stem_b; /* [32] */

    struct {
        const float *a_w; const float *a_b;
        const float *b_w; const float *b_b;
        const float *ds_w; const float *ds_b; /* NULL when not a ds block */
        int in_ch; int out_ch; int stride;
    } stages[4][6];

    const float *seg_w; /* [256, 5120] */
    const float *seg_b; /* [256] */
    const float *mean_vec; /* [256] */

    /* Precomputed front-end tables. */
    float hamming[SPK_WINDOW_LEN];
    float mel_filters[SPK_N_MELS * SPK_FFT_BINS];
    int tables_ready;
};

/* ---------- weight load ---------- */

static int spk_bind_tensor(const voice_gguf_tensors_t *w,
                           const char *name,
                           uint64_t expected_n,
                           const float **dst) {
    const voice_gguf_weight_tensor_t *t = voice_gguf_tensors_find(w, name);
    if (!t) {
        fprintf(stderr, "[voice_speaker] missing tensor: %s\n", name);
        return -EINVAL;
    }
    if (t->n_elements != expected_n) {
        fprintf(stderr,
                "[voice_speaker] tensor %s: expected %llu elements, got %llu\n",
                name, (unsigned long long)expected_n,
                (unsigned long long)t->n_elements);
        return -EINVAL;
    }
    *dst = t->data;
    return 0;
}

#define SPK_BIND(name, n, dst) \
    do { \
        const int rc = spk_bind_tensor(&s->weights, (name), (uint64_t)(n), (dst)); \
        if (rc != 0) return rc; \
    } while (0)

static int spk_bind_weights(struct voice_speaker_session *s) {
    SPK_BIND("stem.weight", 32 * 1 * 3 * 3, &s->stem_w);
    SPK_BIND("stem.bias",   32,             &s->stem_b);

    for (int li = 0; li < 4; ++li) {
        const spk_stage_plan_t *plan = &SPK_PLAN[li];
        for (int bi = 0; bi < plan->blocks; ++bi) {
            const int in_ch = (bi == 0) ? plan->in_channels : plan->out_channels;
            const int out_ch = plan->out_channels;
            const int stride = (bi == 0) ? plan->stride : 1;
            char name[64];

            snprintf(name, sizeof name, "L%d.B%d.a.weight", li+1, bi);
            SPK_BIND(name, out_ch * in_ch * 3 * 3, &s->stages[li][bi].a_w);
            snprintf(name, sizeof name, "L%d.B%d.a.bias", li+1, bi);
            SPK_BIND(name, out_ch, &s->stages[li][bi].a_b);

            snprintf(name, sizeof name, "L%d.B%d.b.weight", li+1, bi);
            SPK_BIND(name, out_ch * out_ch * 3 * 3, &s->stages[li][bi].b_w);
            snprintf(name, sizeof name, "L%d.B%d.b.bias", li+1, bi);
            SPK_BIND(name, out_ch, &s->stages[li][bi].b_b);

            if (bi == 0 && (stride != 1 || in_ch != out_ch)) {
                snprintf(name, sizeof name, "L%d.B%d.ds.weight", li+1, bi);
                SPK_BIND(name, out_ch * in_ch * 1 * 1, &s->stages[li][bi].ds_w);
                snprintf(name, sizeof name, "L%d.B%d.ds.bias", li+1, bi);
                SPK_BIND(name, out_ch, &s->stages[li][bi].ds_b);
            }
            s->stages[li][bi].in_ch = in_ch;
            s->stages[li][bi].out_ch = out_ch;
            s->stages[li][bi].stride = stride;
        }
    }

    SPK_BIND("seg_1.weight", 256 * 5120, &s->seg_w);
    SPK_BIND("seg_1.bias",   256,        &s->seg_b);
    SPK_BIND("mean_vec",     256,        &s->mean_vec);

    return 0;
}
#undef SPK_BIND

/* ---------- precomputed front-end tables ---------- */

static double spk_mel_hz(double f) {
    return 1127.0 * log(1.0 + f / 700.0);
}

static double spk_inv_mel(double m) {
    return 700.0 * (exp(m / 1127.0) - 1.0);
}

static void spk_build_tables(struct voice_speaker_session *s) {
    if (s->tables_ready) return;

    /* Hamming window for the 25-ms frame. The 400-sample window is
     * zero-padded into a 512-bin FFT. Kaldi uses (1-cos)/2 endpoints
     * indexed by (N-1), matching the "symmetric" Hamming window. */
    for (int i = 0; i < SPK_WINDOW_LEN; ++i) {
        s->hamming[i] = (float)(
            0.54 - 0.46 * cos(2.0 * M_PI * (double)i / (double)(SPK_WINDOW_LEN - 1))
        );
    }

    /* Triangular HTK mel filterbank. Kaldi default: low=20 Hz, high=sr/2. */
    const double f_low_hz  = 20.0;
    const double f_high_hz = (double)SPK_SR / 2.0;
    const double mel_low  = spk_mel_hz(f_low_hz);
    const double mel_high = spk_mel_hz(f_high_hz);

    double mel_centers[SPK_N_MELS + 2];
    for (int i = 0; i < SPK_N_MELS + 2; ++i) {
        const double t = (double)i / (double)(SPK_N_MELS + 1);
        mel_centers[i] = mel_low + (mel_high - mel_low) * t;
    }
    double hz_centers[SPK_N_MELS + 2];
    for (int i = 0; i < SPK_N_MELS + 2; ++i) {
        hz_centers[i] = spk_inv_mel(mel_centers[i]);
    }

    double bin_hz[SPK_FFT_BINS];
    for (int k = 0; k < SPK_FFT_BINS; ++k) {
        bin_hz[k] = (double)k * (double)SPK_SR / (double)SPK_FFT;
    }

    memset(s->mel_filters, 0, sizeof(s->mel_filters));
    for (int m = 0; m < SPK_N_MELS; ++m) {
        const double left   = hz_centers[m];
        const double centre = hz_centers[m + 1];
        const double right  = hz_centers[m + 2];
        for (int k = 0; k < SPK_FFT_BINS; ++k) {
            const double f = bin_hz[k];
            double w = 0.0;
            if (f >= left && f <= centre) {
                w = (f - left) / (centre - left);
            } else if (f >= centre && f <= right) {
                w = (right - f) / (right - centre);
            }
            /* Kaldi does NOT area-normalize the filterbank; triangular
             * weights peak at 1.0. */
            s->mel_filters[m * SPK_FFT_BINS + k] = (float)w;
        }
    }

    s->tables_ready = 1;
}

/* ---------- public open / close ---------- */

int voice_speaker_open(const char *gguf, voice_speaker_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    int rc = voice_gguf_load_metadata(gguf, "voice_speaker", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.n_mels != 0 && meta.n_mels != VOICE_CLASSIFIER_N_MELS) return -EINVAL;
    if (meta.n_fft != 0 && meta.n_fft != VOICE_CLASSIFIER_N_FFT) return -EINVAL;
    if (meta.hop != 0 && meta.hop != VOICE_CLASSIFIER_HOP) return -EINVAL;
    if (meta.embedding_dim != 0 &&
        meta.embedding_dim != VOICE_SPEAKER_EMBEDDING_DIM) return -EINVAL;

    struct voice_speaker_session *s =
        (struct voice_speaker_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);

    rc = voice_gguf_tensors_open(gguf, &s->weights);
    if (rc != 0) {
        free(s);
        return rc;
    }

    rc = spk_bind_weights(s);
    if (rc != 0) {
        voice_gguf_tensors_close(&s->weights);
        free(s);
        return rc;
    }

    spk_build_tables(s);
    *out = (voice_speaker_handle)s;
    return 0;
}

int voice_speaker_close(voice_speaker_handle h) {
    if (h == NULL) return 0;
    struct voice_speaker_session *s = (struct voice_speaker_session *)h;
    voice_gguf_tensors_close(&s->weights);
    free(s);
    return 0;
}

/* ---------- forward pass primitives ---------- */

static void spk_dft_power(const float *frame, float *power_out) {
    for (int k = 0; k < SPK_FFT_BINS; ++k) {
        double re = 0.0, im = 0.0;
        const double phase_step = -2.0 * M_PI * (double)k / (double)SPK_FFT;
        for (int n = 0; n < SPK_FFT; ++n) {
            const double p = phase_step * (double)n;
            re += (double)frame[n] * cos(p);
            im += (double)frame[n] * sin(p);
        }
        power_out[k] = (float)(re * re + im * im);
    }
}

static int spk_compute_fbank(const struct voice_speaker_session *s,
                             const float *pcm,
                             size_t n_samples,
                             float *feats_out,
                             int max_frames) {
    if (n_samples < (size_t)SPK_WINDOW_LEN) return -EINVAL;
    const int frames = (int)((n_samples + SPK_HOP / 2) / SPK_HOP);
    if (frames > max_frames) return -ENOSPC;

    float frame[SPK_FFT];
    float power[SPK_FFT_BINS];

    /* The runtime supplies float PCM in [-1, 1]; kaldi training assumed
     * int16 (-32768..32767). Multiply once per frame to match. */
    const float pcm_scale = 32768.0f;

    for (int t = 0; t < frames; ++t) {
        /* Kaldi snip_edges=false centres each frame. */
        const int win_offset = (SPK_WINDOW_LEN - SPK_HOP) / 2;
        const long start = (long)t * SPK_HOP - win_offset;

        /* Copy + scale + reflect-pad. */
        for (int i = 0; i < SPK_WINDOW_LEN; ++i) {
            long idx = start + i;
            if (idx < 0) idx = -idx;
            if ((size_t)idx >= n_samples) {
                idx = (long)(2 * (long)n_samples - 2 - idx);
            }
            if (idx < 0) idx = 0;
            if ((size_t)idx >= n_samples) idx = (long)(n_samples - 1);
            frame[i] = pcm[idx] * pcm_scale;
        }

        /* DC offset removal. */
        double dc = 0.0;
        for (int i = 0; i < SPK_WINDOW_LEN; ++i) dc += frame[i];
        dc /= (double)SPK_WINDOW_LEN;
        for (int i = 0; i < SPK_WINDOW_LEN; ++i) frame[i] -= (float)dc;

        /* Preemphasis (kaldi: x[i] -= preemph * x[i-1], with x[0]
         * special-cased to x[0] -= preemph * x[0]). Apply in reverse. */
        for (int i = SPK_WINDOW_LEN - 1; i > 0; --i) {
            frame[i] = frame[i] - SPK_PREEMPH * frame[i - 1];
        }
        frame[0] = frame[0] - SPK_PREEMPH * frame[0];

        /* Hamming window + zero-pad to FFT length. */
        for (int i = 0; i < SPK_WINDOW_LEN; ++i) {
            frame[i] *= s->hamming[i];
        }
        for (int i = SPK_WINDOW_LEN; i < SPK_FFT; ++i) frame[i] = 0.0f;

        spk_dft_power(frame, power);

        float *row = feats_out + (size_t)t * SPK_N_MELS;
        for (int m = 0; m < SPK_N_MELS; ++m) {
            double e = 0.0;
            const float *filt = &s->mel_filters[m * SPK_FFT_BINS];
            for (int k = 0; k < SPK_FFT_BINS; ++k) {
                e += (double)filt[k] * (double)power[k];
            }
            float v = (float)e;
            if (v < SPK_LOG_EPS) v = SPK_LOG_EPS;
            row[m] = logf(v);
        }
    }

    /* Per-utterance CMN. */
    for (int m = 0; m < SPK_N_MELS; ++m) {
        double mean = 0.0;
        for (int t = 0; t < frames; ++t) mean += feats_out[t * SPK_N_MELS + m];
        mean /= (double)frames;
        for (int t = 0; t < frames; ++t) feats_out[t * SPK_N_MELS + m] -= (float)mean;
    }

    return frames;
}

/* Conv2D forward pass.
 *
 * Tensor layouts in GGUF (numpy row-major; data bytes are in pytorch
 * order, dims un-reversed by voice_gguf_tensors_open):
 *   3x3 weight: [Cout, Cin, 3, 3]  → stride (Cin*9, 9, 3, 1)
 *   1x1 weight: [Cout, Cin, 1, 1]  → stride (Cin, 1, 1, 1)
 *
 * Tensor layouts in memory (intermediate activations):
 *   [C, H, W] row-major.
 */
static void spk_conv2d_3x3(const float *in,    int Cin, int Hin, int Win,
                           const float *w,
                           const float *b,
                           int Cout, int stride,
                           float *out) {
    const int Hout = (Hin + 2 - 3) / stride + 1;
    const int Wout = (Win + 2 - 3) / stride + 1;

    for (int oc = 0; oc < Cout; ++oc) {
        const float bias = b[oc];
        for (int oy = 0; oy < Hout; ++oy) {
            for (int ox = 0; ox < Wout; ++ox) {
                float sum = bias;
                const int base_iy = oy * stride - 1;
                const int base_ix = ox * stride - 1;
                for (int ic = 0; ic < Cin; ++ic) {
                    const float *in_c = in + (size_t)ic * Hin * Win;
                    const float *w_oc_ic = w + ((size_t)oc * Cin + ic) * 9;
                    for (int ky = 0; ky < 3; ++ky) {
                        const int iy = base_iy + ky;
                        if (iy < 0 || iy >= Hin) continue;
                        for (int kx = 0; kx < 3; ++kx) {
                            const int ix = base_ix + kx;
                            if (ix < 0 || ix >= Win) continue;
                            sum += in_c[iy * Win + ix] * w_oc_ic[ky * 3 + kx];
                        }
                    }
                }
                out[((size_t)oc * Hout + oy) * Wout + ox] = sum;
            }
        }
    }
}

static void spk_conv2d_1x1(const float *in,    int Cin, int Hin, int Win,
                           const float *w,
                           const float *b,
                           int Cout, int stride,
                           float *out) {
    const int Hout = (Hin - 1) / stride + 1;
    const int Wout = (Win - 1) / stride + 1;
    for (int oc = 0; oc < Cout; ++oc) {
        const float bias = b[oc];
        const float *w_oc = w + (size_t)oc * Cin;
        for (int oy = 0; oy < Hout; ++oy) {
            for (int ox = 0; ox < Wout; ++ox) {
                float sum = bias;
                const int iy = oy * stride;
                const int ix = ox * stride;
                for (int ic = 0; ic < Cin; ++ic) {
                    sum += in[((size_t)ic * Hin + iy) * Win + ix] * w_oc[ic];
                }
                out[((size_t)oc * Hout + oy) * Wout + ox] = sum;
            }
        }
    }
}

static void spk_relu_inplace(float *x, size_t n) {
    for (size_t i = 0; i < n; ++i) if (x[i] < 0) x[i] = 0;
}

static void spk_add_inplace(float *dst, const float *src, size_t n) {
    for (size_t i = 0; i < n; ++i) dst[i] += src[i];
}

static int spk_basic_block(const struct voice_speaker_session *s,
                           int li, int bi,
                           const float *in, int Cin, int Hin, int Win,
                           float **out, int *Cout_out, int *Hout_out, int *Wout_out) {
    const int Cout = s->stages[li][bi].out_ch;
    const int stride = s->stages[li][bi].stride;
    const int Hmid = (Hin + 2 - 3) / stride + 1;
    const int Wmid = (Win + 2 - 3) / stride + 1;

    float *a_out = (float *)malloc((size_t)Cout * Hmid * Wmid * sizeof(float));
    float *b_out = (float *)malloc((size_t)Cout * Hmid * Wmid * sizeof(float));
    if (!a_out || !b_out) { free(a_out); free(b_out); return -ENOMEM; }

    spk_conv2d_3x3(in, Cin, Hin, Win,
                   s->stages[li][bi].a_w,
                   s->stages[li][bi].a_b,
                   Cout, stride, a_out);
    spk_relu_inplace(a_out, (size_t)Cout * Hmid * Wmid);

    spk_conv2d_3x3(a_out, Cout, Hmid, Wmid,
                   s->stages[li][bi].b_w,
                   s->stages[li][bi].b_b,
                   Cout, 1, b_out);
    free(a_out);

    if (s->stages[li][bi].ds_w) {
        float *ds_out = (float *)malloc((size_t)Cout * Hmid * Wmid * sizeof(float));
        if (!ds_out) { free(b_out); return -ENOMEM; }
        spk_conv2d_1x1(in, Cin, Hin, Win,
                       s->stages[li][bi].ds_w,
                       s->stages[li][bi].ds_b,
                       Cout, stride, ds_out);
        spk_add_inplace(b_out, ds_out, (size_t)Cout * Hmid * Wmid);
        free(ds_out);
    } else {
        spk_add_inplace(b_out, in, (size_t)Cout * Hmid * Wmid);
    }

    spk_relu_inplace(b_out, (size_t)Cout * Hmid * Wmid);

    *out = b_out;
    *Cout_out = Cout;
    *Hout_out = Hmid;
    *Wout_out = Wmid;
    return 0;
}

int voice_speaker_embed(voice_speaker_handle h,
                        const float *pcm_16khz,
                        size_t n,
                        float embedding[VOICE_SPEAKER_EMBEDDING_DIM]) {
    if (embedding) {
        memset(embedding, 0, sizeof(float) * VOICE_SPEAKER_EMBEDDING_DIM);
    }
    if (!h || !pcm_16khz || !embedding || n == 0) return -EINVAL;
    struct voice_speaker_session *s = (struct voice_speaker_session *)h;
    if (n < (size_t)SPK_WINDOW_LEN) return -EINVAL;

    const int max_frames = (int)(n / SPK_HOP + 4);
    float *feats = (float *)calloc((size_t)max_frames * SPK_N_MELS,
                                    sizeof(float));
    if (!feats) return -ENOMEM;

    const int n_frames = spk_compute_fbank(s, pcm_16khz, n, feats, max_frames);
    if (n_frames <= 0) {
        free(feats);
        return n_frames < 0 ? n_frames : -EINVAL;
    }

    /* Transpose feats [T, 80] → x [1, 80, T] (channels-major). */
    const int T = n_frames;
    const int H = SPK_N_MELS;
    float *x = (float *)malloc((size_t)1 * H * T * sizeof(float));
    if (!x) { free(feats); return -ENOMEM; }
    for (int t = 0; t < T; ++t) {
        for (int m = 0; m < H; ++m) {
            x[m * T + t] = feats[t * H + m];
        }
    }
    free(feats);

    /* Stem. */
    float *stem_out = (float *)malloc((size_t)32 * H * T * sizeof(float));
    if (!stem_out) { free(x); return -ENOMEM; }
    spk_conv2d_3x3(x, 1, H, T, s->stem_w, s->stem_b, 32, 1, stem_out);
    spk_relu_inplace(stem_out, (size_t)32 * H * T);
    free(x);

    /* Stages. */
    float *cur = stem_out;
    int Cin = 32, Hin = H, Win = T;
    for (int li = 0; li < 4; ++li) {
        for (int bi = 0; bi < SPK_PLAN[li].blocks; ++bi) {
            float *next = NULL;
            int Cout = 0, Hout = 0, Wout = 0;
            const int rc = spk_basic_block(s, li, bi, cur, Cin, Hin, Win,
                                            &next, &Cout, &Hout, &Wout);
            free(cur);
            if (rc != 0) return rc;
            cur = next;
            Cin = Cout; Hin = Hout; Win = Wout;
        }
    }

    /* Final feature map: [256, 10, T/8]. */
    if (Cin != 256 || Hin != 10) {
        free(cur);
        return -EINVAL;
    }
    const int T_pool = Win;

    /* Statistics pooling over time axis. */
    float pool_mean[256 * 10];
    float pool_std[256 * 10];
    for (int oc = 0; oc < 256; ++oc) {
        for (int oh = 0; oh < 10; ++oh) {
            const float *slot = cur + ((size_t)oc * 10 + oh) * T_pool;
            double mean = 0.0;
            for (int t = 0; t < T_pool; ++t) mean += slot[t];
            mean /= (double)T_pool;
            double var = 0.0;
            for (int t = 0; t < T_pool; ++t) {
                const double d = (double)slot[t] - mean;
                var += d * d;
            }
            /* ONNX pattern: ReduceMean(x²) — N/N — (ReduceProd(shape[-1]) - 1)
             * Equivalent to sample variance with Bessel correction:
             *   var_sample = var_total * N / (N - 1)
             * The ONNX graph: var_pop * N / (N - 1) then sqrt.
             */
            const double N = (double)T_pool;
            const double var_pop = var / N;
            const double var_sample = var_pop * N / (N - 1.0);
            const double std_dev = sqrt(var_sample + 1e-10);
            pool_mean[oc * 10 + oh] = (float)mean;
            pool_std[oc * 10 + oh]  = (float)std_dev;
        }
    }
    free(cur);

    /* Flatten + concat into stats vector [5120]. */
    float stats[5120];
    for (int i = 0; i < 2560; ++i) {
        stats[i]        = pool_mean[i];
        stats[2560 + i] = pool_std[i];
    }

    /* Linear head: emb = seg_w @ stats + seg_b - mean_vec. */
    for (int oc = 0; oc < 256; ++oc) {
        double acc = (double)s->seg_b[oc] - (double)s->mean_vec[oc];
        const float *row = s->seg_w + (size_t)oc * 5120;
        for (int ic = 0; ic < 5120; ++ic) {
            acc += (double)row[ic] * (double)stats[ic];
        }
        embedding[oc] = (float)acc;
    }

    /* L2-normalize for cosine scoring. */
    double norm = 0.0;
    for (int i = 0; i < 256; ++i) norm += (double)embedding[i] * (double)embedding[i];
    if (norm > 0.0) {
        const float inv = (float)(1.0 / sqrt(norm));
        for (int i = 0; i < 256; ++i) embedding[i] *= inv;
    }

    return 0;
}
