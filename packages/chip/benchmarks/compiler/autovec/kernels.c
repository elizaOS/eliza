/*
 * autovec kernels for the e1 LLVM-trunk pin regression suite.
 *
 * Compile per-kernel with the e1 default flags. The runner script
 * (scripts/run_rva23_autovec_suite.py) builds each kernel through the
 * pinned LLVM stage-2 clang, counts vector instructions via
 * `llvm-objdump -d`, and runs the resulting binary under QEMU-user.
 */
#include <math.h>
#include <stdint.h>
#include <stddef.h>

void saxpy(size_t n, float a, const float *x, float *y) {
    for (size_t i = 0; i < n; ++i) y[i] = a * x[i] + y[i];
}

void daxpy(size_t n, double a, const double *x, double *y) {
    for (size_t i = 0; i < n; ++i) y[i] = a * x[i] + y[i];
}

float dot_product(size_t n, const float *a, const float *b) {
    float s = 0.0f;
    for (size_t i = 0; i < n; ++i) s += a[i] * b[i];
    return s;
}

float l2_norm(size_t n, const float *a) {
    float s = 0.0f;
    for (size_t i = 0; i < n; ++i) s += a[i] * a[i];
    return sqrtf(s);
}

void cond_mask_add(size_t n, const float *x, float *y) {
    for (size_t i = 0; i < n; ++i) if (x[i] > 0.0f) y[i] += x[i];
}

void cond_mask_mul(size_t n, const float *x, float *y) {
    for (size_t i = 0; i < n; ++i) if (x[i] != 0.0f) y[i] *= x[i];
}

float strided_load_2(size_t n, const float *x) {
    float s = 0.0f;
    for (size_t i = 0; i < n; i += 2) s += x[i];
    return s;
}

float strided_load_4(size_t n, const float *x) {
    float s = 0.0f;
    for (size_t i = 0; i < n; i += 4) s += x[i];
    return s;
}

float sum_reduction(size_t n, const float *x) {
    float s = 0.0f;
    for (size_t i = 0; i < n; ++i) s += x[i];
    return s;
}

float max_reduction(size_t n, const float *x) {
    float m = x[0];
    for (size_t i = 1; i < n; ++i) if (x[i] > m) m = x[i];
    return m;
}

size_t argmax(size_t n, const float *x) {
    size_t arg = 0;
    float m = x[0];
    for (size_t i = 1; i < n; ++i) if (x[i] > m) { m = x[i]; arg = i; }
    return arg;
}

void int8_quantize(size_t n, const float *x, int8_t *y, float scale) {
    for (size_t i = 0; i < n; ++i) {
        float v = x[i] / scale;
        if (v > 127.0f) v = 127.0f;
        if (v < -128.0f) v = -128.0f;
        y[i] = (int8_t)v;
    }
}

void int8_dequantize(size_t n, const int8_t *x, float *y, float scale) {
    for (size_t i = 0; i < n; ++i) y[i] = (float)x[i] * scale;
}

void bit_reverse_byte(size_t n, uint8_t *x) {
    for (size_t i = 0; i < n; ++i) {
        uint8_t v = x[i];
        v = (v & 0xF0) >> 4 | (v & 0x0F) << 4;
        v = (v & 0xCC) >> 2 | (v & 0x33) << 2;
        v = (v & 0xAA) >> 1 | (v & 0x55) << 1;
        x[i] = v;
    }
}

void packed_uint8_to_uint16(size_t n, const uint8_t *x, uint16_t *y) {
    for (size_t i = 0; i < n; ++i) y[i] = (uint16_t)x[i];
}

void softmax_inplace(size_t n, float *x) {
    float m = x[0];
    for (size_t i = 1; i < n; ++i) if (x[i] > m) m = x[i];
    float s = 0.0f;
    for (size_t i = 0; i < n; ++i) { x[i] = expf(x[i] - m); s += x[i]; }
    float inv_s = 1.0f / s;
    for (size_t i = 0; i < n; ++i) x[i] *= inv_s;
}

/* ===== expansion set (added for LLVM-trunk vs LLVM-stock comparison) ===== */

void memcpy_byte(size_t n, const uint8_t *src, uint8_t *dst) {
    for (size_t i = 0; i < n; ++i) dst[i] = src[i];
}

size_t strlen_simple(const char *s) {
    size_t n = 0;
    while (s[n] != '\0') ++n;
    return n;
}

float dot_product_f32_unrolled4(size_t n, const float *a, const float *b) {
    float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f, s3 = 0.0f;
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        s0 += a[i + 0] * b[i + 0];
        s1 += a[i + 1] * b[i + 1];
        s2 += a[i + 2] * b[i + 2];
        s3 += a[i + 3] * b[i + 3];
    }
    float s = (s0 + s1) + (s2 + s3);
    for (; i < n; ++i) s += a[i] * b[i];
    return s;
}

/* 3x3 valid convolution (no padding). out has dims (h-2) x (w-2). */
void conv2d_3x3_f32(size_t h, size_t w, const float *in, const float *k, float *out) {
    size_t oh = h - 2;
    size_t ow = w - 2;
    for (size_t i = 0; i < oh; ++i) {
        for (size_t j = 0; j < ow; ++j) {
            float s = 0.0f;
            for (size_t ki = 0; ki < 3; ++ki) {
                for (size_t kj = 0; kj < 3; ++kj) {
                    s += in[(i + ki) * w + (j + kj)] * k[ki * 3 + kj];
                }
            }
            out[i * ow + j] = s;
        }
    }
}

/* LayerNorm: mean, variance, normalise, scale + shift. */
void layernorm_f32(size_t n, float *x, const float *gamma, const float *beta, float eps) {
    float mean = 0.0f;
    for (size_t i = 0; i < n; ++i) mean += x[i];
    mean /= (float)n;
    float var = 0.0f;
    for (size_t i = 0; i < n; ++i) { float d = x[i] - mean; var += d * d; }
    var /= (float)n;
    float inv_std = 1.0f / sqrtf(var + eps);
    for (size_t i = 0; i < n; ++i) {
        x[i] = (x[i] - mean) * inv_std * gamma[i] + beta[i];
    }
}

/* GELU activation (tanh approximation). */
void gelu_tanh_f32(size_t n, float *x) {
    const float c0 = 0.7978845608f;   /* sqrt(2/pi) */
    const float c1 = 0.044715f;
    for (size_t i = 0; i < n; ++i) {
        float v = x[i];
        float v3 = v * v * v;
        float t = c0 * (v + c1 * v3);
        float th = tanhf(t);
        x[i] = 0.5f * v * (1.0f + th);
    }
}

/* SiLU/Swish activation. */
void silu_f32(size_t n, float *x) {
    for (size_t i = 0; i < n; ++i) {
        float v = x[i];
        x[i] = v / (1.0f + expf(-v));
    }
}

/* Elementwise FP32 RoPE (rotary position embedding) for one head.
 * x is [seq, dim], even/odd interleaved channels rotated by cos/sin tables.
 * dim must be even. */
void rope_f32(size_t seq, size_t dim, float *x, const float *cos_tab, const float *sin_tab) {
    for (size_t s = 0; s < seq; ++s) {
        for (size_t d = 0; d < dim; d += 2) {
            float xr = x[s * dim + d + 0];
            float xi = x[s * dim + d + 1];
            float c = cos_tab[s * (dim / 2) + d / 2];
            float si = sin_tab[s * (dim / 2) + d / 2];
            x[s * dim + d + 0] = xr * c - xi * si;
            x[s * dim + d + 1] = xr * si + xi * c;
        }
    }
}

/* INT8 SAXPY for quantized inference: y = saturate(a * x + y), all INT8. */
void saxpy_i8(size_t n, int8_t a, const int8_t *x, int8_t *y) {
    for (size_t i = 0; i < n; ++i) {
        int32_t v = (int32_t)a * (int32_t)x[i] + (int32_t)y[i];
        if (v > 127) v = 127;
        if (v < -128) v = -128;
        y[i] = (int8_t)v;
    }
}

/* INT16 horizontal sum reduction. */
int32_t sum_i16(size_t n, const int16_t *x) {
    int32_t s = 0;
    for (size_t i = 0; i < n; ++i) s += (int32_t)x[i];
    return s;
}

/* Indirect (gather) load reduction: scattered indices, requires segment gather. */
float gather_sum_f32(size_t n, const float *x, const int32_t *idx) {
    float s = 0.0f;
    for (size_t i = 0; i < n; ++i) s += x[idx[i]];
    return s;
}

/* Memset uint8: tests vse8.v store-loop. */
void memset_byte(size_t n, uint8_t v, uint8_t *dst) {
    for (size_t i = 0; i < n; ++i) dst[i] = v;
}

/* Histogram with 256 bins, INT32 counters: tests gather-modify-scatter. */
void histogram_u8(size_t n, const uint8_t *x, int32_t *hist) {
    for (size_t i = 0; i < n; ++i) hist[x[i]] += 1;
}

/* Triangular matrix-vector product (lower triangle, transposed). */
void trmv_l_f32(size_t n, const float *A, const float *x, float *y) {
    for (size_t i = 0; i < n; ++i) {
        float s = 0.0f;
        for (size_t j = 0; j <= i; ++j) s += A[i * n + j] * x[j];
        y[i] = s;
    }
}
