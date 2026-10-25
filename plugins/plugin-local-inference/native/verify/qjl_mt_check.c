/* Multithread-vs-singlethread correctness gate for the patched
 * GGML_OP_ATTN_SCORE_QJL + GGML_OP_FUSED_ATTN_QJL_TBQ ops.
 *
 * Builds a tiny ggml graph that uses each op and runs it with
 * n_threads=1 then n_threads=24; the outputs must be bit-identical (the
 * thread split is over disjoint output rows / heads — no reduction, so
 * no floating-point reassociation, so the result is exactly equal). */
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* QK_QJL = 256 (sketch dim), head_dim = 128, block_qjl1_256 = 34 bytes. */
#define QK_QJL_LOCAL    256
#define HEAD_DIM_LOCAL  128

static uint32_t xs = 0x12345678u;
static uint32_t xr(void){ xs^=xs<<13; xs^=xs>>17; xs^=xs<<5; return xs; }
static float frand(void){ return (float)((double)xr()/(double)0xffffffffu) * 2.0f - 1.0f; }

/* Pull data out of a tensor into a malloc'd float buffer. */
static float * dup_floats(struct ggml_tensor * t) {
    size_t n = ggml_nelements(t);
    float * out = malloc(n * sizeof(float));
    memcpy(out, t->data, n * sizeof(float));
    return out;
}

static int run_op_check(const char * name,
                        struct ggml_tensor * (*build)(struct ggml_context *,
                                                      struct ggml_tensor *,   /* q */
                                                      struct ggml_tensor *,   /* k */
                                                      struct ggml_tensor *),  /* v (may be NULL) */
                        int with_v) {
    /* shapes: a few heads + tokens + batch so the thread split actually
     * fans out across our 24 cores. */
    const int proj_dim    = QK_QJL_LOCAL;
    const int head_dim    = HEAD_DIM_LOCAL;
    const int n_heads     = 32;
    const int n_kv_heads  = 8;
    const int n_kv_tokens = 96;
    const int n_batch     = 4;
    const int ne3         = 2;

    size_t mem = (size_t)512 * 1024 * 1024;
    struct ggml_init_params ip = { .mem_size = mem, .mem_buffer = NULL, .no_alloc = false };
    struct ggml_context * ctx = ggml_init(ip);
    if (!ctx) { fprintf(stderr, "ggml_init failed\n"); return 1; }

    struct ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, proj_dim, n_heads, n_batch, ne3);
    /* packed_k is QJL1_256: ne[0] = head_dim (per the kernel's assert), and
     * the row size math uses blck_size=256 -> 34 bytes/row. The kernel just
     * reads bytes; fill with noise. */
    struct ggml_tensor * pk = ggml_new_tensor_4d(ctx, GGML_TYPE_QJL1_256, head_dim, n_kv_tokens, n_kv_heads, ne3);
    struct ggml_tensor * pv = NULL;
    if (with_v) {
        pv = ggml_new_tensor_4d(ctx, GGML_TYPE_TBQ3_0, head_dim, n_kv_tokens, n_kv_heads, ne3);
    }

    /* deterministic fill. q: small floats. packed_k: random sign bytes
     * per block, but a SANE bf16 norm in the last 2 bytes of each 34-byte
     * block (otherwise random bytes -> NaN/Inf norms -> NaN scores; that
     * would still be bit-identical MT vs ST, but a NaN-free fixture is a
     * cleaner gate). packed_v: tbq3_0 blocks (14 B = 2-byte fp16 d + 12
     * code bytes); give the fp16 d a sane value too. */
    xs = 0xC0FFEEu;
    { float * d = (float *)q->data; size_t n = ggml_nelements(q); for (size_t i=0;i<n;i++) d[i] = frand() * 0.1f; }
    {
        uint8_t * d = (uint8_t *)pk->data; size_t nb = ggml_nbytes(pk);
        size_t blk = 34; size_t nblocks = nb / blk;
        for (size_t b=0;b<nblocks;b++) {
            for (int j=0;j<32;j++) d[b*blk+j] = (uint8_t)xr();
            /* bf16 norm in [0.25, 1.0): exponent 0x3E..0x3F, random mantissa */
            uint16_t e = (uint16_t)(0x3E80u + (xr() & 0x0100u)); /* 0x3E80 or 0x3F80 */
            uint16_t m = (uint16_t)(xr() & 0x007Fu);
            uint16_t bf = e | m;
            memcpy(d + b*blk + 32, &bf, 2);
        }
    }
    if (with_v) {
        uint8_t * d = (uint8_t *)pv->data; size_t nb = ggml_nbytes(pv);
        size_t blk = 14; size_t nblocks = nb / blk;
        for (size_t b=0;b<nblocks;b++) {
            /* fp16 d ~ [0.1, 0.5): use a fixed exponent, random mantissa */
            uint16_t h = (uint16_t)(0x2E00u | (xr() & 0x03FFu)); /* ~0.09..0.18 */
            memcpy(d + b*blk, &h, 2);
            for (int j=2;j<14;j++) d[b*blk+j] = (uint8_t)xr();
        }
    }

    struct ggml_tensor * out = build(ctx, q, pk, pv);
    if (!out) { fprintf(stderr, "%s: builder returned NULL\n", name); ggml_free(ctx); return 1; }

    struct ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, out);

    ggml_backend_t be = ggml_backend_cpu_init();
    if (!be) { fprintf(stderr, "ggml_backend_cpu_init failed\n"); ggml_free(ctx); return 1; }

    /* n_threads = 1 */
    ggml_backend_cpu_set_n_threads(be, 1);
    if (ggml_backend_graph_compute(be, gf) != GGML_STATUS_SUCCESS) {
        fprintf(stderr, "%s: graph compute (t=1) failed\n", name);
        ggml_backend_free(be); ggml_free(ctx); return 1;
    }
    float * ref = dup_floats(out);

    /* zero the output to be sure the t=24 run actually rewrites it */
    memset(out->data, 0, ggml_nbytes(out));

    /* n_threads = 24 */
    ggml_backend_cpu_set_n_threads(be, 24);
    if (ggml_backend_graph_compute(be, gf) != GGML_STATUS_SUCCESS) {
        fprintf(stderr, "%s: graph compute (t=24) failed\n", name);
        free(ref); ggml_backend_free(be); ggml_free(ctx); return 1;
    }
    float * mt = dup_floats(out);

    size_t n = ggml_nelements(out);
    size_t mism = 0; float maxd = 0.0f; float anynan = 0.0f;
    for (size_t i=0;i<n;i++) {
        if (isnan(ref[i]) || isnan(mt[i])) anynan = 1.0f;
        if (memcmp(&ref[i], &mt[i], sizeof(float)) != 0) {
            mism++;
            float d = fabsf(ref[i] - mt[i]);
            if (d > maxd) maxd = d;
        }
    }
    /* sanity: the t=1 output must not be all-zero (op actually ran). */
    int allzero = 1; for (size_t i=0;i<n;i++) if (ref[i]!=0.0f){allzero=0;break;}

    printf("[%s] n_out=%zu  bit-mismatches=%zu  max_abs_diff=%.3g  any_nan=%s  ref_all_zero=%s\n",
           name, n, mism, (double)maxd, anynan!=0.0f?"YES":"no", allzero?"YES(BAD)":"no");

    int ok = (mism == 0) && (anynan == 0.0f) && !allzero;
    free(ref); free(mt); ggml_backend_free(be); ggml_free(ctx);
    return ok ? 0 : 1;
}

static struct ggml_tensor * build_score(struct ggml_context * c, struct ggml_tensor * q, struct ggml_tensor * k, struct ggml_tensor * v) {
    (void)v; return ggml_attn_score_qjl(c, q, k, 8 /* n_kv_heads */);
}
static struct ggml_tensor * build_fused(struct ggml_context * c, struct ggml_tensor * q, struct ggml_tensor * k, struct ggml_tensor * v) {
    return ggml_fused_attn_qjl_tbq(c, q, k, v, 8 /* n_kv_heads */, 1.0f/sqrtf(128.0f));
}

int main(void) {
    int rc = 0;
    rc |= run_op_check("ATTN_SCORE_QJL", build_score, 0);
    rc |= run_op_check("FUSED_ATTN_QJL_TBQ", build_fused, 1);
    if (rc == 0) printf("MT-VS-ST: PASS (bit-identical, no NaN)\n");
    else         printf("MT-VS-ST: FAIL\n");
    return rc;
}
