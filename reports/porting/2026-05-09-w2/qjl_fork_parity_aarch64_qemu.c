#include <stdio.h>
#include <dlfcn.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
#include <unistd.h>
#include "qjl/qjl.h"
typedef void (*fork_quantize_fn)(const float *x, void *out, int64_t k);
static uint64_t splitmix64(uint64_t *state) {
    uint64_t z = (*state += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}
static double u01(uint64_t *state) {
    uint64_t v = splitmix64(state);
    return (double)((v >> 11) | 1ULL) * (1.0 / 9007199254740992.0);
}
static float gauss(uint64_t *state) {
    double u1 = u01(state), u2 = u01(state);
    if (u1 < 1e-9) u1 = 1e-9;
    return (float)(sqrt(-2.0 * log(u1)) * cos(6.28318530717958647692 * u2));
}
#define HEAD_DIM 128
#define N_VECTORS 100
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!h) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    fork_quantize_fn fork_quant = (fork_quantize_fn)dlsym(h, "quantize_row_qjl1_256");
    if (!fork_quant) return 1;
    float *prj = malloc((size_t)HEAD_DIM * QJL_PROJECTION_DIM * sizeof(float));
    qjl_make_projection_mt(prj, HEAD_DIM, QJL_PROJECTION_DIM, 42ULL);
    static float keys[N_VECTORS][HEAD_DIM];
    uint64_t st = 0x12345678ABCDEF01ULL;
    for (int i = 0; i < N_VECTORS; i++)
        for (int j = 0; j < HEAD_DIM; j++)
            keys[i][j] = gauss(&st);

    int sign_match=0, norm_match=0, full_match=0;
    int dump_budget=3;
    for (int i = 0; i < N_VECTORS; i++) {
        qjl_block_qjl1_256 local;
        qjl_quantize_row_ref(keys[i], prj, &local);
        struct fork_block { uint8_t signs[QJL_PACKED_BYTES]; uint16_t d; } fork_blk;
        fork_quant(keys[i], &fork_blk, HEAD_DIM);
        int signs_ok = (memcmp(local.qs, fork_blk.signs, QJL_PACKED_BYTES) == 0);
        int norm_ok = (local.norm_bf16 == fork_blk.d);
        if (signs_ok) sign_match++;
        if (norm_ok) norm_match++;
        if (signs_ok && norm_ok) full_match++;
        if ((!signs_ok || !norm_ok) && dump_budget-- > 0) {
            fprintf(stderr, "row %d: signs %s norm %s (got 0x%04x exp 0x%04x)\n",
                i, signs_ok?"OK":"DIFF", norm_ok?"OK":"DIFF", fork_blk.d, local.norm_bf16);
        }
    }
    printf("[fork-parity-aarch64-qemu] %d/%d signs match, %d/%d norms match, %d/%d full match\n",
        sign_match, N_VECTORS, norm_match, N_VECTORS, full_match, N_VECTORS);
    int ok = (full_match == N_VECTORS);
    printf("[fork-parity-aarch64-qemu] %s\n", ok ? "PASS" : "FAIL");
    fflush(stdout);
    /* Skip dlclose+free — qemu-user has known TLS-cleanup faults with
     * dlopen()ed glibc shared libs. Use _exit() to avoid atexit handlers. */
    _exit(ok ? 0 : 1);
}
