/*
 * silero-vad-cpp Phase 2 runtime test.
 *
 * Loads the GGUF fixture supplied as argv[1] (the build system passes
 * `${CMAKE_BINARY_DIR}/silero-vad-v5.gguf`), runs two pairs of windows
 * — silence and a synthesized speech-like signal — and asserts the
 * model behaves the way the upstream Silero VAD does on the same
 * inputs:
 *
 *   1. Silence (all-zero PCM) — speech probability is solidly below
 *      0.5. (Reference Python silero_vad on a 512-sample zero buffer
 *      reports ~0.0006.)
 *   2. Speech-like signal (band-limited modulated noise around the
 *      voice fundamental) — probability is **higher** than the
 *      silence case. We do NOT assert > 0.5: synthetic non-speech
 *      modulated noise typically reads as <0.1 in the upstream
 *      reference too. The honest assertion is "the model agrees with
 *      its reference that synthetic noise differs from silence"
 *      and "both probabilities lie in [0, 1]".
 *
 * This test refuses to run without a fixture GGUF (argv[1] missing or
 * the file unreadable). That keeps "ctest passed" honest: a forgotten
 * conversion step shows up as a hard test failure, not a silently
 * skipped check.
 */

#include "silero_vad/silero_vad.h"

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define N_SAMPLES SILERO_VAD_WINDOW_SAMPLES_16K
#define SAMPLE_RATE_HZ SILERO_VAD_SAMPLE_RATE_HZ

static void make_silence(float *buf, size_t n) {
    for (size_t i = 0; i < n; ++i) buf[i] = 0.0f;
}

/* Synthesized non-silence test vector: amplitude-modulated band-noise
 * around 300 Hz. Not real speech — but it has a clearly different
 * spectral footprint than silence and the model should report a
 * different probability. Deterministic via a tiny LCG so the test is
 * reproducible. */
static void make_speech_like(float *buf, size_t n) {
    uint32_t s = 0x1234ABCDu;
    const float two_pi = 6.2831853f;
    for (size_t i = 0; i < n; ++i) {
        s = s * 1664525u + 1013904223u;
        const float noise = ((float)((int32_t)(s >> 8) & 0xFFFF) / 32767.5f) - 1.0f;
        const float carrier = sinf(two_pi * 300.0f * (float)i / (float)SAMPLE_RATE_HZ);
        const float envelope = 0.5f + 0.5f * sinf(two_pi * 50.0f * (float)i / (float)SAMPLE_RATE_HZ);
        buf[i] = 0.4f * envelope * (0.7f * carrier + 0.3f * noise);
    }
}

static int test_silence_low_prob(silero_vad_handle h, float *out_prob) {
    float pcm[N_SAMPLES];
    make_silence(pcm, N_SAMPLES);
    if (silero_vad_reset_state(h) != 0) {
        fprintf(stderr, "[runtime-test] reset_state failed\n");
        return 1;
    }
    float prob = -1.0f;
    int rc = silero_vad_process(h, pcm, N_SAMPLES, &prob);
    if (rc != 0) {
        fprintf(stderr, "[runtime-test] silence: process rc=%d\n", rc);
        return 1;
    }
    if (!(prob >= 0.0f && prob <= 1.0f)) {
        fprintf(stderr, "[runtime-test] silence: prob out of [0,1]: %f\n", (double)prob);
        return 1;
    }
    if (prob >= 0.5f) {
        fprintf(stderr, "[runtime-test] silence: prob >= 0.5 (%f)\n", (double)prob);
        return 1;
    }
    *out_prob = prob;
    return 0;
}

static int test_speech_like_above_silence(
    silero_vad_handle h, float silence_prob, float *out_prob) {
    float pcm[N_SAMPLES];
    make_speech_like(pcm, N_SAMPLES);
    if (silero_vad_reset_state(h) != 0) {
        fprintf(stderr, "[runtime-test] reset_state failed\n");
        return 1;
    }
    float prob = -1.0f;
    int rc = silero_vad_process(h, pcm, N_SAMPLES, &prob);
    if (rc != 0) {
        fprintf(stderr, "[runtime-test] speech-like: process rc=%d\n", rc);
        return 1;
    }
    if (!(prob >= 0.0f && prob <= 1.0f)) {
        fprintf(stderr, "[runtime-test] speech-like: prob out of [0,1]: %f\n",
                (double)prob);
        return 1;
    }
    /* Honest gate: synthetic modulated noise is NOT speech, so the
     * upstream reference does not always cross 0.5 either. We only
     * require that the model differentiates it from pure silence. */
    if (!(prob > silence_prob)) {
        fprintf(stderr,
                "[runtime-test] speech-like prob (%f) not > silence prob (%f) — "
                "model is not differentiating signal from silence\n",
                (double)prob, (double)silence_prob);
        return 1;
    }
    *out_prob = prob;
    return 0;
}

static int test_invalid_window_size(silero_vad_handle h) {
    float pcm[N_SAMPLES + 1];
    for (int i = 0; i < N_SAMPLES + 1; ++i) pcm[i] = 0.0f;
    float prob = 0.5f;
    int rc = silero_vad_process(h, pcm, N_SAMPLES + 1, &prob);
    if (rc != -22 /* -EINVAL */) {
        fprintf(stderr,
                "[runtime-test] wrong window size returned %d, expected -EINVAL (-22)\n",
                rc);
        return 1;
    }
    if (prob != 0.0f) {
        fprintf(stderr,
                "[runtime-test] wrong window size did not clear prob: %f\n",
                (double)prob);
        return 1;
    }
    return 0;
}

static int test_state_advances(silero_vad_handle h) {
    /* Run silence twice without reset — the second call must complete
     * successfully (state promotion in `silero_vad_process` keeps the
     * graph well-defined across windows). */
    float pcm[N_SAMPLES];
    make_silence(pcm, N_SAMPLES);
    if (silero_vad_reset_state(h) != 0) {
        fprintf(stderr, "[runtime-test] state-advances: reset failed\n");
        return 1;
    }
    float p1 = -1.0f, p2 = -1.0f;
    if (silero_vad_process(h, pcm, N_SAMPLES, &p1) != 0) return 1;
    if (silero_vad_process(h, pcm, N_SAMPLES, &p2) != 0) return 1;
    if (!(p1 >= 0.0f && p1 <= 1.0f && p2 >= 0.0f && p2 <= 1.0f)) {
        fprintf(stderr,
                "[runtime-test] state-advances: probs out of [0,1] (p1=%f p2=%f)\n",
                (double)p1, (double)p2);
        return 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "[runtime-test] usage: %s <silero-vad-v5.gguf>\n"
                "  Generate the fixture with:\n"
                "    python3 packages/native-plugins/silero-vad-cpp/scripts/silero_vad_to_gguf.py "
                "--output build/silero-vad-v5.gguf\n",
                argv[0] ? argv[0] : "silero_vad_runtime_test");
        return 2;
    }
    const char *gguf_path = argv[1];

    silero_vad_handle h = NULL;
    int rc = silero_vad_open(gguf_path, &h);
    if (rc != 0) {
        fprintf(stderr,
                "[runtime-test] silero_vad_open(%s) rc=%d — fixture missing or "
                "malformed. Re-run scripts/silero_vad_to_gguf.py to (re)create it.\n",
                gguf_path, rc);
        return 2;
    }
    if (h == NULL) {
        fprintf(stderr, "[runtime-test] silero_vad_open returned NULL handle\n");
        return 1;
    }

    int failures = 0;
    float silence_prob = 0.0f, speech_prob = 0.0f;
    failures += test_silence_low_prob(h, &silence_prob);
    failures += test_speech_like_above_silence(h, silence_prob, &speech_prob);
    failures += test_invalid_window_size(h);
    failures += test_state_advances(h);

    printf("[runtime-test] silence_prob=%f speech_like_prob=%f failures=%d\n",
           (double)silence_prob, (double)speech_prob, failures);

    silero_vad_close(h);
    return failures == 0 ? 0 : 1;
}
