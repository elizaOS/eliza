/**
 * Hostile GGUF fixtures for `face_gguf_open`. A 32-byte file that declares
 * UINT64_MAX key length must fail closed with `-EINVAL` instead of wrapping
 * `ptr + u64` and memcpy-crashing the process. Contrast: a well-formed empty
 * GGUF (zero KVs, zero tensors) still opens.
 *
 * `_POSIX_C_SOURCE` must precede every system header. The package builds
 * C11 with extensions off, so `strdup` / `mkstemp` are otherwise implicit
 * on glibc and the returned pointer is truncated to `int`.
 */
#define _POSIX_C_SOURCE 200809L

#include "face_internal.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int write_bytes(const char *path, const void *data, size_t n) {
    FILE *fp = fopen(path, "wb");
    if (!fp) return -1;
    size_t wrote = fwrite(data, 1, n, fp);
    fclose(fp);
    return wrote == n ? 0 : -1;
}

static int write_empty_gguf(const char *path) {
    unsigned char buf[24];
    memcpy(buf, "GGUF", 4);
    uint32_t ver = 3;
    uint64_t zero = 0;
    memcpy(buf + 4, &ver, 4);
    memcpy(buf + 8, &zero, 8);
    memcpy(buf + 16, &zero, 8);
    return write_bytes(path, buf, sizeof buf);
}

static int write_keylen_bomb(const char *path, uint64_t key_len) {
    unsigned char buf[32];
    memcpy(buf, "GGUF", 4);
    uint32_t ver = 3;
    uint64_t n_tensors = 0;
    uint64_t n_kvs = 1;
    memcpy(buf + 4, &ver, 4);
    memcpy(buf + 8, &n_tensors, 8);
    memcpy(buf + 16, &n_kvs, 8);
    memcpy(buf + 24, &key_len, 8);
    return write_bytes(path, buf, sizeof buf);
}

static char *make_tmp(void) {
    char *path = strdup("/tmp/face-gguf-hostile-XXXXXX");
    if (!path) return NULL;
    int fd = mkstemp(path);
    if (fd < 0) {
        free(path);
        return NULL;
    }
    close(fd);
    return path;
}

int main(void) {
    int failures = 0;

    char *empty_path = make_tmp();
    char *bomb_path = make_tmp();
    if (!empty_path || !bomb_path) {
        fprintf(stderr, "[face-gguf-hostile] mkstemp failed\n");
        return 2;
    }

    if (write_empty_gguf(empty_path) != 0) {
        fprintf(stderr, "[face-gguf-hostile] write empty failed\n");
        return 2;
    }
    int err = 0;
    face_gguf *empty = face_gguf_open(empty_path, &err);
    if (!empty || err != 0) {
        fprintf(stderr, "[face-gguf-hostile] empty GGUF rejected (g=%p err=%d)\n",
            (void *)empty, err);
        ++failures;
    }
    if (empty) face_gguf_close(empty);

    if (write_keylen_bomb(bomb_path, UINT64_MAX) != 0) {
        fprintf(stderr, "[face-gguf-hostile] write bomb failed\n");
        return 2;
    }
    err = 0;
    face_gguf *bomb = face_gguf_open(bomb_path, &err);
    if (bomb != NULL || err != -EINVAL) {
        fprintf(stderr,
            "[face-gguf-hostile] UINT64_MAX key length returned g=%p err=%d, expected NULL/-EINVAL\n",
            (void *)bomb, err);
        ++failures;
    }
    if (bomb) face_gguf_close(bomb);

    char *short_path = make_tmp();
    if (!short_path) {
        fprintf(stderr, "[face-gguf-hostile] mkstemp short failed\n");
        return 2;
    }
    if (write_bytes(short_path, "GGU", 3) != 0) {
        fprintf(stderr, "[face-gguf-hostile] write 3-byte stub failed\n");
        return 2;
    }
    err = 0;
    face_gguf *too_short = face_gguf_open(short_path, &err);
    if (too_short != NULL || err != -EINVAL) {
        fprintf(stderr,
            "[face-gguf-hostile] 3-byte file returned g=%p err=%d, expected NULL/-EINVAL\n",
            (void *)too_short, err);
        ++failures;
    }
    if (too_short) face_gguf_close(too_short);

    unlink(empty_path);
    unlink(bomb_path);
    unlink(short_path);
    free(empty_path);
    free(bomb_path);
    free(short_path);

    printf("[face-gguf-hostile] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
