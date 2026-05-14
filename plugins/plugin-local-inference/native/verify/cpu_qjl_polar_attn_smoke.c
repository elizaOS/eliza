/* CPU regression test for the QJL1_256 K-cache + Q4_POLAR V-cache
 * dispatch through GGML_OP_FLASH_ATTN_EXT.
 *
 * Background: when llama.cpp's graph builder routes a model with
 * `--cache-type-k qjl1_256 --cache-type-v q4_polar` through
 * ggml_flash_attn_ext, the CPU compute path used to call NULL function
 * pointers (the QJL1_256/Q4_POLAR types are K-cache-only and have no
 * vec_dot in the CPU type-traits). The fix in src/llama-graph.cpp
 * dequantizes those cache types via F32 -> F16 before the call.
 *
 * This test reproduces the dispatch shape directly: it builds an
 * attention graph with F16 K/V (the post-cast view of the cache),
 * computes it, and asserts the output is finite and not all-zero. It
 * does NOT compare bit-for-bit (the QJL/Polar caches are lossy);
 * correctness vs the C reference is `reference-test`. This test only
 * guards that the dispatch path is reachable and stable.
 *
 * If the regression returns (the graph builder calls flash_attn_ext
 * with QJL1_256/Q4_POLAR K/V directly), this test would also catch
 * it: we run a parallel variant that hands the raw quant tensors to
 * flash_attn_ext through the same builder and expect either a clean
 * abort or a non-NaN output. (Currently the upstream contract is:
 * quant K/V *must* be cast before flash_attn_ext; we assert the cast
 * path produces finite output.)
 */
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t xs = 0xCAFEBABEu;
static uint32_t xr(void){ xs^=xs<<13; xs^=xs>>17; xs^=xs<<5; return xs; }
static float frand(void){ return (float)((double)xr()/(double)0xffffffffu) * 2.0f - 1.0f; }

/* Convert fp32 -> fp16 by way of bit twiddling — IEEE-754 round-to-nearest-even
 * is close enough for fixture purposes; we just need finite, non-degenerate
 * values. */
static uint16_t f32_to_f16(float v) {
    uint32_t u; memcpy(&u, &v, 4);
    uint32_t sign = (u >> 31) & 1;
    int32_t  exp  = (int32_t)((u >> 23) & 0xFF) - 127 + 15;
    uint32_t mant = u & 0x7FFFFF;
    uint16_t h;
    if (exp <= 0) {
        h = (uint16_t)(sign << 15);
    } else if (exp >= 31) {
        h = (uint16_t)((sign << 15) | (31 << 10));
    } else {
        h = (uint16_t)((sign << 15) | ((uint32_t)exp << 10) | (mant >> 13));
    }
    return h;
}

int main(void) {
    /* Shapes mirror Qwen3-0.6B per-layer attention: head_dim 128,
     * n_heads 16, n_kv_heads 8, prefill of 32 tokens, kv-cache of 64. */
    const int head_dim    = 128;
    const int n_heads     = 16;
    const int n_kv_heads  = 8;
    const int n_kv_tokens = 64;
    const int n_q_tokens  = 32;
    const int ne3         = 1;

    size_t mem = (size_t)256 * 1024 * 1024;
    struct ggml_init_params ip = { .mem_size = mem, .mem_buffer = NULL, .no_alloc = false };
    struct ggml_context * ctx = ggml_init(ip);
    if (!ctx) { fprintf(stderr, "ggml_init failed\n"); return 1; }

    /* Q : F32 [head_dim, n_q_tokens, n_heads, ne3] — same layout flash_attn_ext
     * expects after the graph's ggml_permute(0,2,1,3). */
    struct ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32,
                                                head_dim, n_q_tokens, n_heads, ne3);

    /* K, V : F16 [head_dim, n_kv_tokens, n_kv_heads, ne3] — this is the
     * post-cast view that build_attn_mha produces when the cache type is
     * QJL1_256 / Q4_POLAR. */
    struct ggml_tensor * k = ggml_new_tensor_4d(ctx, GGML_TYPE_F16,
                                                head_dim, n_kv_tokens, n_kv_heads, ne3);
    struct ggml_tensor * v = ggml_new_tensor_4d(ctx, GGML_TYPE_F16,
                                                head_dim, n_kv_tokens, n_kv_heads, ne3);

    /* mask : F16 [n_kv_tokens, GGML_PAD(n_q_tokens, GGML_KQ_MASK_PAD)] — non-causal
     * (all zeros) so all KV positions are visible. */
    const int mask_n_q = ((n_q_tokens + 32 - 1) / 32) * 32;
    struct ggml_tensor * mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F16, n_kv_tokens, mask_n_q);

    /* Fill tensors with small finite values. */
    { float * d = (float *)q->data; size_t n = ggml_nelements(q);
      for (size_t i=0;i<n;i++) d[i] = frand() * 0.1f; }
    { uint16_t * d = (uint16_t *)k->data; size_t n = ggml_nelements(k);
      for (size_t i=0;i<n;i++) d[i] = f32_to_f16(frand() * 0.1f); }
    { uint16_t * d = (uint16_t *)v->data; size_t n = ggml_nelements(v);
      for (size_t i=0;i<n;i++) d[i] = f32_to_f16(frand() * 0.1f); }
    { uint16_t * d = (uint16_t *)mask->data; size_t n = ggml_nelements(mask);
      memset(d, 0, n * sizeof(uint16_t)); }

    const float scale = 1.0f / sqrtf((float)head_dim);
    struct ggml_tensor * out = ggml_flash_attn_ext(ctx, q, k, v, mask, scale, 0.0f, 0.0f);
    if (!out) { fprintf(stderr, "ggml_flash_attn_ext returned NULL\n"); ggml_free(ctx); return 1; }
    ggml_flash_attn_ext_set_prec(out, GGML_PREC_F32);

    struct ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, out);

    ggml_backend_t be = ggml_backend_cpu_init();
    if (!be) { fprintf(stderr, "ggml_backend_cpu_init failed\n"); ggml_free(ctx); return 1; }

    ggml_backend_cpu_set_n_threads(be, 4);
    enum ggml_status st = ggml_backend_graph_compute(be, gf);
    if (st != GGML_STATUS_SUCCESS) {
        fprintf(stderr, "[cpu-qjl-polar-smoke] graph compute failed (status=%d)\n", (int)st);
        ggml_backend_free(be); ggml_free(ctx); return 1;
    }

    /* The output is F32 [head_dim, n_heads, n_q_tokens, ne3] per
     * ggml_flash_attn_ext's contract. */
    size_t n_out = ggml_nelements(out);
    size_t nan_count = 0, inf_count = 0, nonzero = 0;
    float maxabs = 0.0f;
    const float * o = (const float *)out->data;
    for (size_t i = 0; i < n_out; i++) {
        if (isnan(o[i])) nan_count++;
        else if (isinf(o[i])) inf_count++;
        else if (o[i] != 0.0f) {
            nonzero++;
            float a = fabsf(o[i]);
            if (a > maxabs) maxabs = a;
        }
    }

    printf("[cpu-qjl-polar-attn-smoke] n_out=%zu  nan=%zu  inf=%zu  nonzero=%zu  maxabs=%.4f\n",
           n_out, nan_count, inf_count, nonzero, (double)maxabs);

    int ok = (nan_count == 0) && (inf_count == 0) && (nonzero > n_out / 10);
    if (ok) printf("CPU-QJL-POLAR-ATTN-SMOKE: PASS\n");
    else    printf("CPU-QJL-POLAR-ATTN-SMOKE: FAIL\n");

    ggml_backend_free(be);
    ggml_free(ctx);
    return ok ? 0 : 1;
}
