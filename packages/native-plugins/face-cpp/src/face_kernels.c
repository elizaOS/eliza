/*
 * face_kernels.c — small NN kernel set used by both BlazeFace detection
 * and the face-embed forward path. Pure C, scalar, batch-of-1.
 *
 * Tensor convention: NCHW activations, OIhw conv weights. See
 * `face_internal.h` for the per-op contract.
 */

#include "face_internal.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

void face_relu_inplace(float *x, int n) {
    for (int i = 0; i < n; ++i) {
        if (x[i] < 0.0f) x[i] = 0.0f;
    }
}

void face_l2_normalize_inplace(float *x, int dim) {
    double s = 0.0;
    for (int i = 0; i < dim; ++i) s += (double)x[i] * (double)x[i];
    if (s <= 0.0) return;
    const float inv = 1.0f / (float)sqrt(s);
    for (int i = 0; i < dim; ++i) x[i] *= inv;
}

void face_bn_fold(
    const float *gamma, const float *beta,
    const float *mean, const float *var,
    float eps, int channels,
    float *scale_out, float *shift_out)
{
    for (int c = 0; c < channels; ++c) {
        const float inv = 1.0f / sqrtf(var[c] + eps);
        scale_out[c] = gamma[c] * inv;
        shift_out[c] = beta[c] - gamma[c] * mean[c] * inv;
    }
}

void face_apply_bn_relu_inplace(
    float *x, int channels, int hw,
    const float *scale, const float *shift,
    bool relu)
{
    for (int c = 0; c < channels; ++c) {
        const float s = scale[c];
        const float t = shift[c];
        float *p = x + (size_t)c * (size_t)hw;
        if (relu) {
            for (int i = 0; i < hw; ++i) {
                float v = p[i] * s + t;
                p[i] = v < 0.0f ? 0.0f : v;
            }
        } else {
            for (int i = 0; i < hw; ++i) {
                p[i] = p[i] * s + t;
            }
        }
    }
}

void face_conv2d_ref(
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
        for (int oy = 0; oy < hout; ++oy) {
            for (int ox = 0; ox < wout; ++ox) {
                float acc = bias;
                const int iy0 = oy * strideh - padh;
                const int ix0 = ox * stridew - padw;
                for (int ic = 0; ic < cin; ++ic) {
                    const float *xp = x + (size_t)ic * (size_t)hin * (size_t)win;
                    const float *wp = w + (((size_t)oc * (size_t)cin + (size_t)ic) * (size_t)kh) * (size_t)kw;
                    for (int ky = 0; ky < kh; ++ky) {
                        const int iy = iy0 + ky;
                        if (iy < 0 || iy >= hin) continue;
                        for (int kx = 0; kx < kw; ++kx) {
                            const int ix = ix0 + kx;
                            if (ix < 0 || ix >= win) continue;
                            acc += xp[(size_t)iy * (size_t)win + (size_t)ix]
                                 * wp[(size_t)ky * (size_t)kw + (size_t)kx];
                        }
                    }
                }
                out[((size_t)oc * (size_t)hout + (size_t)oy) * (size_t)wout + (size_t)ox] = acc;
            }
        }
    }
}

void face_depthwise_conv2d_ref(
    const float *x, int channels, int hin, int win,
    const float *w, int kh, int kw,
    const float *b,
    int strideh, int stridew, int padh, int padw,
    float *out)
{
    const int hout = (hin + 2 * padh - kh) / strideh + 1;
    const int wout = (win + 2 * padw - kw) / stridew + 1;

    for (int c = 0; c < channels; ++c) {
        const float bias = b ? b[c] : 0.0f;
        const float *xp = x + (size_t)c * (size_t)hin * (size_t)win;
        const float *wp = w + (size_t)c * (size_t)kh * (size_t)kw;
        for (int oy = 0; oy < hout; ++oy) {
            for (int ox = 0; ox < wout; ++ox) {
                float acc = bias;
                const int iy0 = oy * strideh - padh;
                const int ix0 = ox * stridew - padw;
                for (int ky = 0; ky < kh; ++ky) {
                    const int iy = iy0 + ky;
                    if (iy < 0 || iy >= hin) continue;
                    for (int kx = 0; kx < kw; ++kx) {
                        const int ix = ix0 + kx;
                        if (ix < 0 || ix >= win) continue;
                        acc += xp[(size_t)iy * (size_t)win + (size_t)ix]
                             * wp[(size_t)ky * (size_t)kw + (size_t)kx];
                    }
                }
                out[((size_t)c * (size_t)hout + (size_t)oy) * (size_t)wout + (size_t)ox] = acc;
            }
        }
    }
}

void face_pointwise_conv2d_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout,
    const float *b, float *out)
{
    const int hw = hin * win;
    for (int oc = 0; oc < cout; ++oc) {
        const float bias = b ? b[oc] : 0.0f;
        const float *wp = w + (size_t)oc * (size_t)cin;
        float *op = out + (size_t)oc * (size_t)hw;
        for (int p = 0; p < hw; ++p) op[p] = bias;
        for (int ic = 0; ic < cin; ++ic) {
            const float wv = wp[ic];
            const float *xp = x + (size_t)ic * (size_t)hw;
            for (int p = 0; p < hw; ++p) {
                op[p] += wv * xp[p];
            }
        }
    }
}

void face_maxpool2d_ref(
    const float *x, int channels, int hin, int win,
    int kh, int kw, int strideh, int stridew, int padh, int padw,
    float *out)
{
    const int hout = (hin + 2 * padh - kh) / strideh + 1;
    const int wout = (win + 2 * padw - kw) / stridew + 1;

    for (int c = 0; c < channels; ++c) {
        const float *xp = x + (size_t)c * (size_t)hin * (size_t)win;
        for (int oy = 0; oy < hout; ++oy) {
            for (int ox = 0; ox < wout; ++ox) {
                float best = -INFINITY;
                const int iy0 = oy * strideh - padh;
                const int ix0 = ox * stridew - padw;
                for (int ky = 0; ky < kh; ++ky) {
                    const int iy = iy0 + ky;
                    if (iy < 0 || iy >= hin) continue;
                    for (int kx = 0; kx < kw; ++kx) {
                        const int ix = ix0 + kx;
                        if (ix < 0 || ix >= win) continue;
                        const float v = xp[(size_t)iy * (size_t)win + (size_t)ix];
                        if (v > best) best = v;
                    }
                }
                if (best == -INFINITY) best = 0.0f;
                out[((size_t)c * (size_t)hout + (size_t)oy) * (size_t)wout + (size_t)ox] = best;
            }
        }
    }
}

void face_linear_ref(
    const float *x, int m, int k,
    const float *w, int n,
    const float *b, float *out)
{
    for (int i = 0; i < m; ++i) {
        for (int j = 0; j < n; ++j) {
            float acc = b ? b[j] : 0.0f;
            const float *wp = w + (size_t)j * (size_t)k;
            const float *xp = x + (size_t)i * (size_t)k;
            for (int t = 0; t < k; ++t) acc += xp[t] * wp[t];
            out[(size_t)i * (size_t)n + (size_t)j] = acc;
        }
    }
}
