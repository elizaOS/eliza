/*
 * qjl_fork_parity.c — bit-parity test between the standalone qjl-cpu
 * library (the algorithmic source of truth) and the QJL kernels vendored
 * into the apothic/llama.cpp-1bit-turboquant fork.
 *
 * Loads the fork's libggml-cpu.so via dlopen and compares its
 *   quantize_row_qjl1_256(const float *x, void *out, int64_t k)
 * symbol against the linked-in
 *   qjl_quantize_row_ref(const float *key, const float *prj,
 *                        qjl_block_qjl1_256 *out)
 * for 100 random key vectors of head_dim=128. Since both implementations
 * use the same default seeded projection matrix Π (head_dim=128,
 * proj_dim=256, seed=42 — see quants-qjl.c::qjl_default_projection
 * and the qjl_make_projection_mt helper), the bit-exact contract is:
 *
 *   for every random key k:
 *     fork_out  = quantize_row_qjl1_256(k, ...)
 *     local_out = qjl_quantize_row_ref(k, Π_default, ...)
 *     memcmp(fork_out.qs,  local_out.qs,  32) == 0
 *     fork_out.norm_bf16 == local_out.norm_bf16
 *
 * Run:
 *   1. Build the fork's libggml-cpu.so via
 *      `node packages/app-core/scripts/aosp/compile-libllama.mjs --abi x86_64`
 *      (host-arch build; for arm64 run on a real arm64 host or via
 *      qemu-aarch64).
 *   2. Build this test with the standalone qjl-cpu library:
 *      `cmake -B build -S packages/native-plugins/qjl-cpu && cmake --build build`
 *   3. Run with the path to the fork's libggml-cpu.so:
 *      `build/qjl_fork_parity <abs-path-to-libggml-cpu.so>`
 *
 * Exits 0 on bit-exact match for all 100 vectors, non-zero with a per-row
 * diff dump otherwise.
 */

#define _POSIX_C_SOURCE 200809L
#include "qjl/qjl.h"

#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEAD_DIM 128
#define N_VECTORS 100
#define DEFAULT_SEED 42ULL

/* Forward signature of the fork's symbol. The fork's quantize_row_qjl1_256
 * accepts the total number of input scalars `k` (must be a multiple of
 * QJL_HEAD_DIM = 128) and writes one block per 128-element row. */
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

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
            "usage: %s <path-to-fork-libggml-cpu.so>\n"
            "\n"
            "Verifies the fork's quantize_row_qjl1_256 produces bit-exact\n"
            "output against the standalone qjl-cpu reference for %d random\n"
            "key vectors of head_dim=%d.\n",
            argv[0], N_VECTORS, HEAD_DIM);
        return 2;
    }
    const char *libpath = argv[1];

    /* dlopen the fork's libggml-cpu.so. The library has NEEDED entries on
     * libggml-base.so, libstdc++, etc. — we let the dynamic linker resolve
     * them via the system search path or LD_LIBRARY_PATH the caller sets.
     * We do NOT depend on libllama.so here; only the kernel symbol. */
    void *h = dlopen(libpath, RTLD_NOW | RTLD_LOCAL);
    if (!h) {
        fprintf(stderr, "dlopen %s: %s\n", libpath, dlerror());
        fprintf(stderr,
            "If this fails with 'libggml-base.so: cannot open shared object\n"
            "file', set LD_LIBRARY_PATH to the directory containing the full\n"
            "libggml*.so family (e.g. /tmp/qjl-build-test/assets/x86_64).\n");
        return 1;
    }
    dlerror(); /* clear */
    fork_quantize_fn fork_quant =
        (fork_quantize_fn)dlsym(h, "quantize_row_qjl1_256");
    const char *err = dlerror();
    if (err) {
        fprintf(stderr, "dlsym quantize_row_qjl1_256: %s\n", err);
        dlclose(h);
        return 1;
    }
    if (!fork_quant) {
        fprintf(stderr, "dlsym returned NULL for quantize_row_qjl1_256\n");
        dlclose(h);
        return 1;
    }

    /* Build the same default projection Π that the fork's quants-qjl.c
     * lazily constructs (head_dim=128, proj_dim=256, seed=42). The
     * standalone library exposes qjl_make_projection_mt() with the same
     * splitmix64 + Box-Muller sequence as the fork's vendored copy, so
     * the matrices match byte-for-byte. */
    float *prj = malloc((size_t)HEAD_DIM * QJL_PROJECTION_DIM * sizeof(float));
    if (!prj) { fprintf(stderr, "oom\n"); dlclose(h); return 1; }
    if (qjl_make_projection_mt(prj, HEAD_DIM, QJL_PROJECTION_DIM, DEFAULT_SEED) != 0) {
        fprintf(stderr, "qjl_make_projection_mt failed\n");
        free(prj); dlclose(h); return 1;
    }

    /* Generate N_VECTORS random key vectors. */
    float (*keys)[HEAD_DIM] = malloc((size_t)N_VECTORS * sizeof(*keys));
    if (!keys) { fprintf(stderr, "oom\n"); free(prj); dlclose(h); return 1; }
    uint64_t st = 0x12345678ABCDEF01ULL;
    for (int i = 0; i < N_VECTORS; i++) {
        for (int j = 0; j < HEAD_DIM; j++) {
            keys[i][j] = gauss(&st);
        }
    }

    /* Quantize via both paths and compare. */
    int sign_match = 0, norm_match = 0, full_match = 0;
    int dump_budget = 3;
    for (int i = 0; i < N_VECTORS; i++) {
        qjl_block_qjl1_256 local;
        qjl_quantize_row_ref(keys[i], prj, &local);

        /* The fork's block layout matches the standalone library's:
         * signs (32 bytes) then bf16 norm (16-bit). See ggml-common.h
         * `block_qjl1_256` and qjl_block_qjl1_256 in the kernel-library
         * public header — both are signs-then-norm. */
        struct fork_block {
            uint8_t  signs[QJL_PACKED_BYTES];
            uint16_t d;
        } fork_blk;
        _Static_assert(sizeof(fork_blk) == 34, "fork block must be 34B");
        fork_quant(keys[i], &fork_blk, HEAD_DIM);

        int signs_ok = (memcmp(local.qs, fork_blk.signs, QJL_PACKED_BYTES) == 0);
        int norm_ok  = (local.norm_bf16 == fork_blk.d);
        if (signs_ok) sign_match++;
        if (norm_ok)  norm_match++;
        if (signs_ok && norm_ok) full_match++;

        if ((!signs_ok || !norm_ok) && dump_budget > 0) {
            fprintf(stderr, "  row %d: signs %s, norm %s (got 0x%04x exp 0x%04x)\n",
                i, signs_ok ? "OK" : "DIFF",
                norm_ok ? "OK" : "DIFF",
                fork_blk.d, local.norm_bf16);
            dump_budget--;
        }
    }

    printf("[qjl-fork-parity] %d/%d signs match, %d/%d norms match, %d/%d full match\n",
           sign_match, N_VECTORS, norm_match, N_VECTORS, full_match, N_VECTORS);
    printf("[qjl-fork-parity] standalone SIMD path: %s\n", qjl_active_simd());

    int ok = (full_match == N_VECTORS);
    printf("[qjl-fork-parity] %s\n", ok ? "PASS" : "FAIL");

    free(keys);
    free(prj);
    dlclose(h);
    return ok ? 0 : 1;
}
