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
