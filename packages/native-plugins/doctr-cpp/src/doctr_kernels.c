/*
 * Pure-C reference NN kernels for doctr-cpp Phase 2.
 *
 * No SIMD, no OpenMP, no allocator gymnastics — just slow, obvious,
 * verifiable code. Phase 3 swaps each of these out for a SIMD path
 * behind a runtime dispatcher (see packages/native-plugins/qjl-cpu's
 * pattern). Until then the goal is correctness against PyTorch
 * reference outputs.
 *
 * Tensor layout: NCHW for activations (channel-major within an HxW
 * plane). Conv weights are OIhw. This matches both PyTorch's default
 * and the GGUF emitted by scripts/doctr_to_gguf.py.
 */

#include "doctr_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

void doctr_conv2d_ref(
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

void doctr_apply_affine_relu(
    float *x, int channels, int hw,
    const float *scale, const float *shift, bool relu)
{
    for (int c = 0; c < channels; ++c) {
        float *plane = x + (size_t)c * hw;
        const float s = scale[c];
        const float t = shift[c];
        for (int i = 0; i < hw; ++i) {
            float v = plane[i] * s + t;
            if (relu && v < 0.0f) v = 0.0f;
            plane[i] = v;
        }
    }
}

void doctr_bn_fold(
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

void doctr_maxpool2d_ref(
    const float *x, int channels, int hin, int win,
    int kh, int kw, int strideh, int stridew, int padh, int padw,
    float *out)
{
    const int hout = (hin + 2 * padh - kh) / strideh + 1;
    const int wout = (win + 2 * padw - kw) / stridew + 1;

    for (int c = 0; c < channels; ++c) {
        const float *plane_in = x + (size_t)c * hin * win;
        float *plane_out = out + (size_t)c * hout * wout;
        for (int oy = 0; oy < hout; ++oy) {
            for (int ox = 0; ox < wout; ++ox) {
                float m = -INFINITY;
                for (int ky = 0; ky < kh; ++ky) {
                    const int iy = oy * strideh - padh + ky;
                    if (iy < 0 || iy >= hin) continue;
                    for (int kx = 0; kx < kw; ++kx) {
                        const int ix = ox * stridew - padw + kx;
                        if (ix < 0 || ix >= win) continue;
                        float v = plane_in[iy * win + ix];
                        if (v > m) m = v;
                    }
                }
                plane_out[oy * wout + ox] = (m == -INFINITY) ? 0.0f : m;
            }
        }
    }
}

void doctr_upsample_bilinear_ref(
    const float *x, int channels, int hin, int win,
    int factor, float *out)
{
    const int hout = hin * factor;
    const int wout = win * factor;
    /* PyTorch align_corners=False scale: src = (dst + 0.5) / factor - 0.5. */
    for (int c = 0; c < channels; ++c) {
        const float *plane_in = x + (size_t)c * hin * win;
        float *plane_out = out + (size_t)c * hout * wout;
        for (int oy = 0; oy < hout; ++oy) {
            float sy = ((float)oy + 0.5f) / (float)factor - 0.5f;
            if (sy < 0.0f) sy = 0.0f;
            if (sy > (float)(hin - 1)) sy = (float)(hin - 1);
            int y0 = (int)floorf(sy);
            int y1 = y0 + 1 < hin ? y0 + 1 : y0;
            float fy = sy - (float)y0;
            for (int ox = 0; ox < wout; ++ox) {
                float sx = ((float)ox + 0.5f) / (float)factor - 0.5f;
                if (sx < 0.0f) sx = 0.0f;
                if (sx > (float)(win - 1)) sx = (float)(win - 1);
                int x0 = (int)floorf(sx);
                int x1 = x0 + 1 < win ? x0 + 1 : x0;
                float fx = sx - (float)x0;
                float v00 = plane_in[y0 * win + x0];
                float v01 = plane_in[y0 * win + x1];
                float v10 = plane_in[y1 * win + x0];
                float v11 = plane_in[y1 * win + x1];
                float a = v00 * (1.0f - fx) + v01 * fx;
                float b = v10 * (1.0f - fx) + v11 * fx;
                plane_out[oy * wout + ox] = a * (1.0f - fy) + b * fy;
            }
        }
    }
}

void doctr_conv_transpose_2x2_s2_ref(
    const float *x, int cin, int hin, int win,
    const float *w, int cout,
    const float *b, float *out)
{
    const int hout = hin * 2;
    const int wout = win * 2;
    /* Initialize output with bias (or zero). */
    for (int oc = 0; oc < cout; ++oc) {
        float v = b ? b[oc] : 0.0f;
        float *plane = out + (size_t)oc * hout * wout;
        for (int i = 0; i < hout * wout; ++i) plane[i] = v;
    }

    /* Scatter: out[oc, oy*2+ky, ox*2+kx] += sum_ic x[ic, oy, ox] * w[ic, oc, ky, kx]
     * (PyTorch ConvTranspose2d weight layout is (in_channels, out_channels, kh, kw).) */
    for (int ic = 0; ic < cin; ++ic) {
        const float *x_plane = x + (size_t)ic * hin * win;
        for (int oc = 0; oc < cout; ++oc) {
            float *out_plane = out + (size_t)oc * hout * wout;
            const float *kern = w + (((size_t)ic * cout + oc) * 2) * 2;
            for (int iy = 0; iy < hin; ++iy) {
                for (int ix = 0; ix < win; ++ix) {
                    float v = x_plane[iy * win + ix];
                    out_plane[(iy * 2 + 0) * wout + (ix * 2 + 0)] += v * kern[0 * 2 + 0];
                    out_plane[(iy * 2 + 0) * wout + (ix * 2 + 1)] += v * kern[0 * 2 + 1];
                    out_plane[(iy * 2 + 1) * wout + (ix * 2 + 0)] += v * kern[1 * 2 + 0];
                    out_plane[(iy * 2 + 1) * wout + (ix * 2 + 1)] += v * kern[1 * 2 + 1];
                }
            }
        }
    }
}

void doctr_sigmoid_inplace(float *x, int n) {
    for (int i = 0; i < n; ++i) {
        x[i] = 1.0f / (1.0f + expf(-x[i]));
    }
}

void doctr_linear_ref(
    const float *x, int m, int k,
    const float *w, int n,
    const float *b, float *out)
{
    /* out[i, j] = sum_l x[i, l] * w[j, l] + b[j] */
    for (int i = 0; i < m; ++i) {
        const float *xi = x + (size_t)i * k;
        float *oi = out + (size_t)i * n;
        for (int j = 0; j < n; ++j) {
            const float *wj = w + (size_t)j * k;
            float acc = b ? b[j] : 0.0f;
            for (int l = 0; l < k; ++l) acc += xi[l] * wj[l];
            oi[j] = acc;
        }
    }
}

static inline float sigmoidf(float x) { return 1.0f / (1.0f + expf(-x)); }

void doctr_lstm_step_ref(
    const float *x, int input_dim,
    float *h, float *c, int hidden_dim,
    const float *w_ih, const float *w_hh,
    const float *b_ih, const float *b_hh)
{
    /* Compute gates = w_ih @ x + b_ih + w_hh @ h + b_hh.
     * w_ih layout: (4*hidden_dim, input_dim), rows in i,f,g,o order. */
    const int H = hidden_dim;
    /* Use a small heap scratch to avoid VLA-on-stack blow-ups. */
    float *gates = (float *)malloc(sizeof(float) * 4 * H);
    if (!gates) return;
    for (int g = 0; g < 4 * H; ++g) {
        float v = (b_ih ? b_ih[g] : 0.0f) + (b_hh ? b_hh[g] : 0.0f);
        const float *wr_ih = w_ih + (size_t)g * input_dim;
        const float *wr_hh = w_hh + (size_t)g * H;
        for (int l = 0; l < input_dim; ++l) v += wr_ih[l] * x[l];
        for (int l = 0; l < H; ++l)         v += wr_hh[l] * h[l];
        gates[g] = v;
    }
    for (int n = 0; n < H; ++n) {
        float i = sigmoidf(gates[0 * H + n]);
        float f = sigmoidf(gates[1 * H + n]);
        float g = tanhf(gates[2 * H + n]);
        float o = sigmoidf(gates[3 * H + n]);
        c[n] = f * c[n] + i * g;
        h[n] = o * tanhf(c[n]);
    }
    free(gates);
}
