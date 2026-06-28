/*
 * driver.c — per-kernel measurement driver for the RVV 1.0 vector evidence
 * harness (scripts/run_e1_rvv_vector.sh).
 *
 * One kernel is selected at compile time via -DKERNEL_<name>=1. The driver
 * fills deterministic input buffers, then calls the kernel exactly once with
 * the problem size declared in kernels.json. The kernel itself lives in
 * kernels.c; this file only sets up data and a checksum so the optimizer
 * cannot delete the call.
 *
 * The kernel function is wrapped between two named symbols so the QEMU
 * execlog post-processor can isolate the kernel's dynamic instruction
 * stream by program-counter range (kernel_region_begin .. kernel_region_end)
 * without depending on libc symbol sizes. The kernel call sits between them
 * and is marked noinline so it cannot be hoisted out of the region.
 *
 * Exit code carries a one-byte checksum of the result so a mismatch between
 * the scalar (rv64gc) and vector (rv64gcv) builds is observable from QEMU's
 * process exit status.
 */
#include <stdint.h>
#include <stddef.h>
#include <math.h>

/* Kernel prototypes (definitions in kernels.c). */
void  saxpy(size_t n, float a, const float *x, float *y);
void  daxpy(size_t n, double a, const double *x, double *y);
float dot_product(size_t n, const float *a, const float *b);
float l2_norm(size_t n, const float *a);
void  cond_mask_add(size_t n, const float *x, float *y);
void  cond_mask_mul(size_t n, const float *x, float *y);
float strided_load_2(size_t n, const float *x);
float strided_load_4(size_t n, const float *x);
float sum_reduction(size_t n, const float *x);
float max_reduction(size_t n, const float *x);
size_t argmax(size_t n, const float *x);
void  int8_quantize(size_t n, const float *x, int8_t *y, float scale);
void  int8_dequantize(size_t n, const int8_t *x, float *y, float scale);
void  bit_reverse_byte(size_t n, uint8_t *x);
void  packed_uint8_to_uint16(size_t n, const uint8_t *x, uint16_t *y);
void  softmax_inplace(size_t n, float *x);
void  memcpy_byte(size_t n, const uint8_t *src, uint8_t *dst);
size_t strlen_simple(const char *s);
float dot_product_f32_unrolled4(size_t n, const float *a, const float *b);
void  layernorm_f32(size_t n, float *x, const float *gamma, const float *beta, float eps);
void  gelu_tanh_f32(size_t n, float *x);
void  silu_f32(size_t n, float *x);
void  saxpy_i8(size_t n, int8_t a, const int8_t *x, int8_t *y);
int32_t sum_i16(size_t n, const int16_t *x);
float gather_sum_f32(size_t n, const float *x, const int32_t *idx);
void  memset_byte(size_t n, uint8_t v, uint8_t *dst);

/*
 * Region markers. These two no-op functions bound the kernel call so the
 * execlog post-processor can find the dynamic instruction window by the
 * addresses of these symbols rather than by libc symbol metadata. They are
 * noinline and use inline asm with a memory clobber so the compiler keeps
 * them, in order, around the kernel call.
 */
__attribute__((noinline)) void kernel_region_begin(void) { __asm__ volatile("" ::: "memory"); }
__attribute__((noinline)) void kernel_region_end(void)   { __asm__ volatile("" ::: "memory"); }

/* Deterministic LCG so scalar and vector builds see identical inputs. */
static uint32_t lcg_state = 0x12345678u;
static uint32_t lcg(void) { lcg_state = lcg_state * 1664525u + 1013904223u; return lcg_state; }
static float    randf(void) { return (float)(int32_t)(lcg() >> 8) / (float)(1 << 23); }

/* Buffers large enough for the biggest kernel (n = 65536). */
#define MAXN 65536
static float    fa[MAXN], fb[MAXN], fc[MAXN];
static double   da[MAXN], db[MAXN];
static int8_t   ia[MAXN], ib[MAXN];
static uint8_t  ua[MAXN], ub[MAXN];
static uint16_t u16[MAXN];
static int16_t  i16[MAXN];
static int32_t  i32[MAXN];

static volatile float    sink_f;
static volatile double   sink_d;
static volatile size_t   sink_z;
static volatile int32_t  sink_i;

int main(void) {
    for (size_t i = 0; i < MAXN; ++i) {
        fa[i] = randf();
        fb[i] = randf();
        fc[i] = randf();
        da[i] = (double)randf();
        db[i] = (double)randf();
        ia[i] = (int8_t)(lcg() & 0xff);
        ib[i] = (int8_t)(lcg() & 0xff);
        ua[i] = (uint8_t)(lcg() & 0xff);
        i16[i] = (int16_t)(lcg() & 0xffff);
        i32[i] = (int32_t)(lcg() % 4096);
    }

    kernel_region_begin();
#if defined(KERNEL_saxpy)
    saxpy(8192, 2.5f, fa, fb); sink_f = fb[7];
#elif defined(KERNEL_daxpy)
    daxpy(4096, 2.5, da, db); sink_d = db[7];
#elif defined(KERNEL_dot_product)
    sink_f = dot_product(8192, fa, fb);
#elif defined(KERNEL_l2_norm)
    sink_f = l2_norm(8192, fa);
#elif defined(KERNEL_cond_mask_add)
    cond_mask_add(8192, fa, fb); sink_f = fb[7];
#elif defined(KERNEL_cond_mask_mul)
    cond_mask_mul(8192, fa, fb); sink_f = fb[7];
#elif defined(KERNEL_strided_load_2)
    sink_f = strided_load_2(8192, fa);
#elif defined(KERNEL_strided_load_4)
    sink_f = strided_load_4(8192, fa);
#elif defined(KERNEL_sum_reduction)
    sink_f = sum_reduction(8192, fa);
#elif defined(KERNEL_max_reduction)
    sink_f = max_reduction(8192, fa);
#elif defined(KERNEL_argmax)
    sink_z = argmax(8192, fa);
#elif defined(KERNEL_int8_quantize)
    int8_quantize(16384, fa, ia, 0.5f); sink_i = ia[7];
#elif defined(KERNEL_int8_dequantize)
    int8_dequantize(16384, ia, fa, 0.5f); sink_f = fa[7];
#elif defined(KERNEL_bit_reverse_byte)
    bit_reverse_byte(16384, ua); sink_i = ua[7];
#elif defined(KERNEL_packed_uint8_to_uint16)
    packed_uint8_to_uint16(16384, ua, u16); sink_i = u16[7];
#elif defined(KERNEL_softmax_inplace)
    softmax_inplace(1024, fa); sink_f = fa[7];
#elif defined(KERNEL_memcpy_byte)
    memcpy_byte(65536, ua, ub); sink_i = ub[7];
#elif defined(KERNEL_strlen_simple)
    ua[4095] = 0; for (size_t i = 0; i < 4095; ++i) if (ua[i] == 0) ua[i] = 1;
    sink_z = strlen_simple((const char *)ua);
#elif defined(KERNEL_dot_product_f32_unrolled4)
    sink_f = dot_product_f32_unrolled4(8192, fa, fb);
#elif defined(KERNEL_layernorm_f32)
    layernorm_f32(4096, fa, fb, fc, 1e-5f); sink_f = fa[7];
#elif defined(KERNEL_gelu_tanh_f32)
    gelu_tanh_f32(4096, fa); sink_f = fa[7];
#elif defined(KERNEL_silu_f32)
    silu_f32(4096, fa); sink_f = fa[7];
#elif defined(KERNEL_saxpy_i8)
    saxpy_i8(16384, 3, ia, ib); sink_i = ib[7];
#elif defined(KERNEL_sum_i16)
    sink_i = sum_i16(16384, i16);
#elif defined(KERNEL_gather_sum_f32)
    sink_f = gather_sum_f32(4096, fa, i32);
#elif defined(KERNEL_memset_byte)
    memset_byte(65536, 0xab, ub); sink_i = ub[7];
#else
#error "no KERNEL_<name> selected"
#endif
    kernel_region_end();

    /* Fold every sink into the exit code so the call cannot be elided and a
     * scalar/vector divergence in the result shows up in the exit status. */
    uint32_t cs = (uint32_t)sink_i;
    cs ^= (uint32_t)(int32_t)(sink_f * 1024.0f);
    cs ^= (uint32_t)(int32_t)(sink_d * 1024.0);
    cs ^= (uint32_t)sink_z;
    return (int)(cs & 0x7f);
}
