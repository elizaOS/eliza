/*
 * voice-classifier-cpp — GGUF metadata loader smoke test.
 *
 * Constructs a tiny GGUF file in memory (well, in /tmp), opens it via
 * `voice_emotion_open`, and confirms:
 *
 *   1. Right magic + version + matching metadata block → open success.
 *   2. Wrong magic                                       → -EINVAL.
 *   3. Wrong sample_rate in the metadata                 → -EINVAL.
 *   4. Missing file                                       → -ENOENT.
 *
 * This pins the metadata-validation half of the J1 infrastructure
 * (the half this commit lands); the forward graph stays -ENOSYS until
 * the J1.a / J1.b / J1.c followups.
 */

#define _DEFAULT_SOURCE
#define _XOPEN_SOURCE 700
#include "voice_classifier/voice_classifier.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* GGUF wire constants — duplicated here so the test is decoupled
 * from the internal loader header. */
#define VC_GGUF_MAGIC "GGUF"
#define VC_GGUF_VERSION 3

enum vc_gguf_type {
    VC_GGUF_TYPE_UINT32  = 4,
    VC_GGUF_TYPE_STRING  = 8,
};

static void w_u32(FILE *f, uint32_t v) {
    fwrite(&v, sizeof(v), 1, f);
}
static void w_u64(FILE *f, uint64_t v) {
    fwrite(&v, sizeof(v), 1, f);
}
static void w_i64(FILE *f, int64_t v) {
    fwrite(&v, sizeof(v), 1, f);
}
static void w_str(FILE *f, const char *s) {
    const uint64_t n = strlen(s);
    w_u64(f, n);
    fwrite(s, 1, n, f);
}
static void w_kv_u32(FILE *f, const char *key, uint32_t val) {
    w_str(f, key);
    w_u32(f, VC_GGUF_TYPE_UINT32);
    w_u32(f, val);
}
static void w_kv_str(FILE *f, const char *key, const char *val) {
    w_str(f, key);
    w_u32(f, VC_GGUF_TYPE_STRING);
    w_str(f, val);
}

/* Build a GGUF file with the locked voice_emotion metadata block.
 * Returns 0 on success, -1 on file error. */
static int write_test_gguf(const char *path,
                            const char *magic,
                            int sample_rate,
                            int num_classes) {
    FILE *f = fopen(path, "wb");
    if (!f) return -1;

    /* magic + version */
    fwrite(magic, 1, 4, f);
    w_u32(f, VC_GGUF_VERSION);

    /* tensor count (0 — we don't ship tensors for this test) */
    w_i64(f, 0);
    /* kv count */
    w_i64(f, 6);

    w_kv_u32(f, "voice_emotion.sample_rate", (uint32_t)sample_rate);
    w_kv_u32(f, "voice_emotion.n_mels", VOICE_CLASSIFIER_N_MELS);
    w_kv_u32(f, "voice_emotion.n_fft", VOICE_CLASSIFIER_N_FFT);
    w_kv_u32(f, "voice_emotion.hop", VOICE_CLASSIFIER_HOP);
    w_kv_u32(f, "voice_emotion.num_classes", (uint32_t)num_classes);
    w_kv_str(f, "voice_emotion.variant", "wav2small-test-v0");

    fclose(f);
    return 0;
}

int main(void) {
    int failures = 0;

    char tmpl[] = "/tmp/voice_gguf_loader_test_XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd < 0) {
        perror("mkstemp");
        return 1;
    }
    close(fd);

    /* ---------- Case 1: well-formed GGUF → success ---------- */
    if (write_test_gguf(tmpl, VC_GGUF_MAGIC,
                          VOICE_CLASSIFIER_SAMPLE_RATE_HZ,
                          VOICE_EMOTION_NUM_CLASSES) != 0) {
        fprintf(stderr, "[voice-gguf-loader-test] cannot write tmp\n");
        unlink(tmpl);
        return 1;
    }
    voice_emotion_handle h = NULL;
    int rc = voice_emotion_open(tmpl, &h);
    if (rc != 0 || h == NULL) {
        fprintf(stderr,
                "[voice-gguf-loader-test] well-formed open returned %d, handle=%p\n",
                rc, (void *)h);
        ++failures;
    }
    if (h) voice_emotion_close(h);

    /* ---------- Case 2: wrong magic → -EINVAL ---------- */
    if (write_test_gguf(tmpl, "ZZZZ",
                          VOICE_CLASSIFIER_SAMPLE_RATE_HZ,
                          VOICE_EMOTION_NUM_CLASSES) == 0) {
        h = NULL;
        rc = voice_emotion_open(tmpl, &h);
        if (rc != -EINVAL) {
            fprintf(stderr,
                    "[voice-gguf-loader-test] bad-magic open returned %d, expected -EINVAL\n",
                    rc);
            ++failures;
        }
        if (h != NULL) {
            fprintf(stderr,
                    "[voice-gguf-loader-test] bad-magic open did not clear handle\n");
            ++failures;
        }
    }

    /* ---------- Case 3: wrong sample_rate → -EINVAL ---------- */
    if (write_test_gguf(tmpl, VC_GGUF_MAGIC,
                          48000 /* wrong */,
                          VOICE_EMOTION_NUM_CLASSES) == 0) {
        h = NULL;
        rc = voice_emotion_open(tmpl, &h);
        if (rc != -EINVAL) {
            fprintf(stderr,
                    "[voice-gguf-loader-test] bad sample_rate open returned %d, expected -EINVAL\n",
                    rc);
            ++failures;
        }
    }

    /* ---------- Case 4: missing file → -ENOENT ---------- */
    h = NULL;
    rc = voice_emotion_open("/this/path/does/not/exist.gguf", &h);
    if (rc != -ENOENT) {
        fprintf(stderr,
                "[voice-gguf-loader-test] missing-file open returned %d, expected -ENOENT\n",
                rc);
        ++failures;
    }

    unlink(tmpl);

    printf("[voice-gguf-loader-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
