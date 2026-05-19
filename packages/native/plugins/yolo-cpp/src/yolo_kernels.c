/*
 * Pure-C scalar NN kernels for yolo-cpp Phase 2.
 *
 * No SIMD, no OpenMP — slow, obvious, verifiable. Phase 3 will swap
 * Conv2d (the hot loop) for an im2col + AVX2/NEON GEMM, mirroring
 * qjl-cpu's dispatcher.
 *
 * Layout convention everywhere: NCHW for activations (C major within
 * each H×W plane). Conv weights are OIhw (out_ch, in_ch, kh, kw),
 * matching PyTorch's default and the GGUF emitted by
 * scripts/yolo_to_gguf.py.
 *
 * BN folding: a BatchNorm with parameters (gamma, beta, mean, var, eps)
 * is mathematically y = gamma * (x - mean) / sqrt(var + eps) + beta.
 * That's a per-channel affine, so we precompute (scale, shift) at
 * session-open time and apply it in one fused pass after Conv2d.
 *
 * SiLU activation: y = x * sigmoid(x). Ultralytics uses SiLU
 * everywhere in v8/v11.
 */

#include "yolo_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ── Conv2D + bias + (optional) BN-folded affine + (optional) SiLU ────── */

/* Forward Conv2D, batch-of-1.
 *   x:   (cin, hin, win)
 *   w:   (cout, cin, kh, kw)
 *   b:   (cout) or NULL
 *   out: (cout, hout, wout) where
 *     hout = (hin + 2*padh - kh) / strideh + 1
 *     wout = (win + 2*padw - kw) / stridew + 1
 *
 * Caller sizes `out` correctly. Naive im2col-free triple loop; Phase 3
 * replaces with SIMD GEMM. */
void yolo_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out)
{
    const int hout = (hin + 2 * padh - kh) / strideh + 1;
    const int wout = (win + 2 * padw - kw) / stridew + 1;

    for (int oc = 0; oc < cout; ++oc) {
        const float bias = b ? b[oc] : 0.0f;
        float *out_plane = out + (size_t)oc * hout * wout;
        for (int oy = 0; oy < hout; ++oy) {
            for (int ox = 0; ox < wout; ++ox) {
                float acc = bias;
                for (int ic = 0; ic < cin; ++ic) {
                    const float *x_plane = x + (size_t)ic * hin * win;
                    const float *w_kern  = w + (((size_t)oc * cin + ic) * kh) * kw;
                    for (int ky = 0; ky < kh; ++ky) {
                        const int iy = oy * strideh - padh + ky;
                        if (iy < 0 || iy >= hin) continue;
                        for (int kx = 0; kx < kw; ++kx) {
                            const int ix = ox * stridew - padw + kx;
                            if (ix < 0 || ix >= win) continue;
                            acc += x_plane[iy * win + ix] * w_kern[ky * kw + kx];
                        }
                    }
                }
                out_plane[oy * wout + ox] = acc;
            }
        }
    }
}

/* Apply a precomputed BN-folded affine (scale, shift) channel-wise.
 * scale/shift come from yolo_bn_fold(). */
void yolo_apply_affine(
    float *x, int channels, int hw,
    const float *scale, const float *shift)
{
    for (int c = 0; c < channels; ++c) {
        float *plane = x + (size_t)c * hw;
        const float s = scale[c];
        const float t = shift[c];
        for (int i = 0; i < hw; ++i) {
            plane[i] = plane[i] * s + t;
        }
    }
}

void yolo_bn_fold(
    const float *gamma, const float *beta,
    const float *mean, const float *var,
    float eps, int channels,
    float *scale_out, float *shift_out)
{
    for (int c = 0; c < channels; ++c) {
        float inv = 1.0f / sqrtf(var[c] + eps);
        scale_out[c] = gamma[c] * inv;
        shift_out[c] = beta[c]  - mean[c] * gamma[c] * inv;
    }
}

/* SiLU: y = x * sigmoid(x). In-place. */
void yolo_silu_inplace(float *x, int n) {
    for (int i = 0; i < n; ++i) {
        const float v = x[i];
        x[i] = v / (1.0f + expf(-v));
    }
}

/* In-place sigmoid on `n` floats. */
void yolo_sigmoid_inplace(float *x, int n) {
    for (int i = 0; i < n; ++i) {
        x[i] = 1.0f / (1.0f + expf(-x[i]));
    }
}

/* Concatenate along the channel axis: out = [a; b].
 *   a: (ca, h, w),  b: (cb, h, w) → out: (ca+cb, h, w). */
void yolo_concat_channels(
    const float *a, int ca,
    const float *b, int cb,
    int h, int w, float *out)
{
    const size_t plane = (size_t)h * w;
    memcpy(out,                         a, plane * (size_t)ca * sizeof(float));
    memcpy(out + (size_t)ca * plane,    b, plane * (size_t)cb * sizeof(float));
}

/* Nearest-neighbor 2x upsample. NCHW in, NCHW out (channels, h*2, w*2).
 * Matches torch.nn.Upsample(scale_factor=2, mode='nearest'). */
void yolo_upsample2_nearest(
    const float *x, int channels, int hin, int win, float *out)
{
    const int hout = hin * 2;
    const int wout = win * 2;
    for (int c = 0; c < channels; ++c) {
        const float *plane_in  = x   + (size_t)c * hin  * win;
        float       *plane_out = out + (size_t)c * hout * wout;
        for (int y = 0; y < hout; ++y) {
            const int sy = y / 2;
            for (int x_ = 0; x_ < wout; ++x_) {
                const int sx = x_ / 2;
                plane_out[y * wout + x_] = plane_in[sy * win + sx];
            }
        }
    }
}

/* MaxPool2D used by SPPF. kernel kh, stride 1, padding (kh-1)/2 (symmetric). */
void yolo_maxpool2d_same(
    const float *x, int channels, int hin, int win,
    int k, float *out)
{
    const int pad = (k - 1) / 2;
    for (int c = 0; c < channels; ++c) {
        const float *plane_in  = x   + (size_t)c * hin * win;
        float       *plane_out = out + (size_t)c * hin * win;
        for (int oy = 0; oy < hin; ++oy) {
            for (int ox = 0; ox < win; ++ox) {
                float m = -INFINITY;
                for (int ky = 0; ky < k; ++ky) {
                    const int iy = oy - pad + ky;
                    if (iy < 0 || iy >= hin) continue;
                    for (int kx = 0; kx < k; ++kx) {
                        const int ix = ox - pad + kx;
                        if (ix < 0 || ix >= win) continue;
                        const float v = plane_in[iy * win + ix];
                        if (v > m) m = v;
                    }
                }
                plane_out[oy * win + ox] = (m == -INFINITY) ? 0.0f : m;
            }
        }
    }
}

/* Per-row softmax over a (rows, cols) row-major matrix. In-place. */
void yolo_softmax_rows(float *x, int rows, int cols) {
    for (int r = 0; r < rows; ++r) {
        float *row = x + (size_t)r * cols;
        float m = row[0];
        for (int i = 1; i < cols; ++i) if (row[i] > m) m = row[i];
        float sum = 0.0f;
        for (int i = 0; i < cols; ++i) {
            row[i] = expf(row[i] - m);
            sum += row[i];
        }
        const float inv = sum > 0.0f ? 1.0f / sum : 0.0f;
        for (int i = 0; i < cols; ++i) row[i] *= inv;
    }
}
