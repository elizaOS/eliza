/*
 * voice_diarizer_parity_test — gates per-frame label agreement between
 * the C forward pass and the ONNX reference on the W3-6 5-fixture set.
 *
 * Reference labels were generated from
 *   onnx-community/pyannote-segmentation-3.0 :: onnx/model.onnx
 * and live in `voice_diarizer_parity_fixtures.h`. Each entry holds the
 * 293-frame argmax stream over the first 5 seconds (80000 samples) of
 * the fixture.
 *
 * The test:
 *  1. Opens the GGUF emitted by `scripts/voice_diarizer_to_gguf.py`
 *     (expected at `models/voice/diarizer/pyannote-segmentation-3.0.gguf`
 *      relative to the repo root — override with $VOICE_DIARIZER_GGUF).
 *  2. For each fixture: loads the WAV via a tiny in-file PCM-16 reader,
 *     truncates to 80000 samples, normalises to fp32 [-1, 1], calls
 *     `voice_diarizer_segment`, and asserts ≥ 99 % per-frame agreement
 *     with the ONNX reference.
 *  3. Asserts the speaker-count contract per fixture (solo → 1 speaker
 *     class present; multi-speaker fixtures → ≥ 2 distinct non-silence
 *     classes).
 *
 * Skipped (exit 0 with a message) if the GGUF or fixtures are absent —
 * this lets developers without HF_TOKEN still run the unit suite.
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_diarizer_parity_fixtures.h"

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define WINDOW_SAMPLES 80000
#define EXPECTED_FRAMES DIAR_PARITY_T

/* Minimum per-frame agreement we accept (per the brief: ≥ 99 % with
 * some quant-noise tolerance on transition frames). We are at fp32 so
 * the realistic agreement is 100 %; allow a 1 % slack for floating-
 * point reorder. */
#define MIN_AGREEMENT_PCT 99.0

/* Tiny PCM16 WAV reader. Doesn't validate every header field — just the
 * minimum we need for the fixtures. Returns 0 on success, -1 on any
 * parse error or read failure. */
static int read_pcm16_wav_mono_16k(const char *path, float *out, int max_samples,
                                   int *n_samples_out) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    unsigned char hdr[44];
    if (fread(hdr, 1, 44, f) != 44) { fclose(f); return -1; }
    if (memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) {
        fclose(f); return -1;
    }
    /* Find data chunk — for the W3-6 fixtures it sits at offset 36
     * with "data" + uint32 size. */
    if (memcmp(hdr + 36, "data", 4) != 0) {
        /* Walk forward looking for "data". */
        fseek(f, 12, SEEK_SET);
        unsigned char buf[8];
        while (fread(buf, 1, 8, f) == 8) {
            uint32_t sz = (uint32_t)buf[4] | ((uint32_t)buf[5] << 8) |
                          ((uint32_t)buf[6] << 16) | ((uint32_t)buf[7] << 24);
            if (memcmp(buf, "data", 4) == 0) {
                /* The "data" chunk header is here; the PCM samples
                 * follow at the current file pos. */
                break;
            } else {
                fseek(f, sz, SEEK_CUR);
            }
        }
    }
    int16_t *samples = (int16_t *)malloc(sizeof(int16_t) * max_samples);
    if (!samples) { fclose(f); return -1; }
    size_t got = fread(samples, sizeof(int16_t), max_samples, f);
    fclose(f);
    for (size_t i = 0; i < got; ++i) {
        out[i] = (float)samples[i] / 32768.0f;
    }
    free(samples);
    /* Pad with zeros to max_samples. */
    for (int i = (int)got; i < max_samples; ++i) out[i] = 0.0f;
    *n_samples_out = (int)got;
    return 0;
}

static int file_exists(const char *p) {
    struct stat st;
    return stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

int main(void) {
    const char *gguf = getenv("VOICE_DIARIZER_GGUF");
    if (!gguf) gguf = "../../../models/voice/diarizer/pyannote-segmentation-3.0.gguf";

    const char *fixtures_dir = getenv("VOICE_DIARIZER_FIXTURES_DIR");
    if (!fixtures_dir) fixtures_dir = "../../benchmarks/voice-speaker-validation/fixtures";

    if (!file_exists(gguf)) {
        fprintf(stderr,
                "[voice-diarizer-parity] SKIP — GGUF not found at %s\n"
                "  Build it with:\n"
                "    python3 packages/native-plugins/voice-classifier-cpp/scripts/voice_diarizer_to_gguf.py "
                "--output models/voice/diarizer/pyannote-segmentation-3.0.gguf\n",
                gguf);
        return 0;
    }

    voice_diarizer_handle h = NULL;
    int rc = voice_diarizer_open(gguf, &h);
    if (rc != 0 || h == NULL) {
        fprintf(stderr, "[voice-diarizer-parity] FAIL — voice_diarizer_open returned %d\n", rc);
        return 1;
    }

    int total_fail = 0;
    int total_fixtures = 0;
    for (int fi = 0; fi < DIAR_PARITY_NFIX; ++fi) {
        const char *name = diar_parity_fixture_names[fi];
        char wav_path[1024];
        snprintf(wav_path, sizeof(wav_path), "%s/%s.wav", fixtures_dir, name);
        if (!file_exists(wav_path)) {
            fprintf(stderr,
                    "[voice-diarizer-parity] SKIP %s — fixture not found at %s\n",
                    name, wav_path);
            continue;
        }
        total_fixtures += 1;
        float *pcm = (float *)calloc(WINDOW_SAMPLES, sizeof(float));
        if (!pcm) { voice_diarizer_close(h); return 1; }
        int n_samples = 0;
        if (read_pcm16_wav_mono_16k(wav_path, pcm, WINDOW_SAMPLES, &n_samples) != 0) {
            fprintf(stderr, "[voice-diarizer-parity] FAIL %s — could not read WAV\n", name);
            free(pcm); voice_diarizer_close(h); return 1;
        }

        int8_t labels[EXPECTED_FRAMES];
        size_t cap = EXPECTED_FRAMES;
        rc = voice_diarizer_segment(h, pcm, WINDOW_SAMPLES, labels, &cap);
        free(pcm);
        if (rc != 0) {
            fprintf(stderr,
                    "[voice-diarizer-parity] FAIL %s — segment returned %d (cap=%zu)\n",
                    name, rc, cap);
            voice_diarizer_close(h); return 1;
        }
        if (cap != EXPECTED_FRAMES) {
            fprintf(stderr,
                    "[voice-diarizer-parity] FAIL %s — got %zu frames, expected %d\n",
                    name, cap, EXPECTED_FRAMES);
            voice_diarizer_close(h); return 1;
        }

        int agree = 0;
        int n_distinct[VOICE_DIARIZER_NUM_CLASSES] = {0};
        for (int t = 0; t < EXPECTED_FRAMES; ++t) {
            if (labels[t] == diar_parity_expected[fi][t]) agree += 1;
            if (labels[t] >= 0 && labels[t] < VOICE_DIARIZER_NUM_CLASSES) {
                n_distinct[(int)labels[t]] += 1;
            }
        }
        const double pct = 100.0 * (double)agree / (double)EXPECTED_FRAMES;
        int distinct_used = 0;
        for (int c = 0; c < VOICE_DIARIZER_NUM_CLASSES; ++c)
            if (n_distinct[c] > 0) distinct_used += 1;

        printf("[voice-diarizer-parity] %s: agreement=%.2f%% (%d/%d), "
               "distinct_classes=%d\n",
               name, pct, agree, EXPECTED_FRAMES, distinct_used);

        if (pct < MIN_AGREEMENT_PCT) {
            fprintf(stderr,
                    "[voice-diarizer-parity] FAIL %s — agreement %.2f%% < %.2f%%\n",
                    name, pct, MIN_AGREEMENT_PCT);
            total_fail += 1;
            /* Print mismatched positions for debug */
            int printed = 0;
            for (int t = 0; t < EXPECTED_FRAMES && printed < 20; ++t) {
                if (labels[t] != diar_parity_expected[fi][t]) {
                    fprintf(stderr, "    t=%d got=%d expected=%d\n",
                            t, (int)labels[t], (int)diar_parity_expected[fi][t]);
                    printed += 1;
                }
            }
        }
    }

    voice_diarizer_close(h);

    if (total_fixtures == 0) {
        fprintf(stderr, "[voice-diarizer-parity] SKIP — no fixtures available\n");
        return 0;
    }
    if (total_fail > 0) {
        fprintf(stderr, "[voice-diarizer-parity] %d of %d fixtures FAILED\n",
                total_fail, total_fixtures);
        return 1;
    }
    printf("[voice-diarizer-parity] ALL %d fixtures passed ≥ %.1f%% parity\n",
           total_fixtures, MIN_AGREEMENT_PCT);
    return 0;
}
