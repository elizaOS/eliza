/* Probe: open a diarizer GGUF, run voice_diarizer_segment on a 5s window from
 * a 16 kHz mono PCM16 wav, print per-frame label histogram + transition count.
 * Gate-scrambled weights -> micro-segment flood (many transitions, phantom
 * multi-speaker labels). Correct weights -> few transitions. */
#include "voice_classifier/voice_classifier.h"
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WINDOW_SAMPLES 80000
#define MAX_FRAMES 512

static int read_wav(const char *path, float *out, int max_samples) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    unsigned char hdr[12];
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "RIFF", 4) || memcmp(hdr + 8, "WAVE", 4)) { fclose(f); return -1; }
    unsigned char ch[8];
    long data_off = -1; unsigned data_len = 0;
    while (fread(ch, 1, 8, f) == 8) {
        unsigned len = ch[4] | (ch[5] << 8) | (ch[6] << 16) | ((unsigned)ch[7] << 24);
        if (!memcmp(ch, "data", 4)) { data_off = ftell(f); data_len = len; break; }
        fseek(f, (long)((len + 1) & ~1u), SEEK_CUR);
    }
    if (data_off < 0) { fclose(f); return -1; }
    int n = (int)(data_len / 2);
    if (n > max_samples) n = max_samples;
    int16_t *buf = malloc((size_t)n * 2);
    if (fread(buf, 2, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return -1; }
    fclose(f);
    for (int i = 0; i < n; ++i) out[i] = (float)buf[i] / 32768.0f;
    for (int i = n; i < max_samples; ++i) out[i] = 0.0f;
    free(buf);
    return n;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s <gguf> <wav>\n", argv[0]); return 2; }
    voice_diarizer_handle h = NULL;
    int rc = voice_diarizer_open(argv[1], &h);
    if (rc != 0) { fprintf(stderr, "open rc=%d\n", rc); return 1; }
    static float pcm[WINDOW_SAMPLES];
    if (read_wav(argv[2], pcm, WINDOW_SAMPLES) <= 0) { fprintf(stderr, "bad wav\n"); return 1; }
    int8_t labels[MAX_FRAMES];
    size_t cap = MAX_FRAMES;
    rc = voice_diarizer_segment(h, pcm, WINDOW_SAMPLES, labels, &cap);
    if (rc != 0) { fprintf(stderr, "segment rc=%d\n", rc); return 1; }
    int hist[VOICE_DIARIZER_NUM_CLASSES] = {0};
    int transitions = 0;
    for (int t = 0; t < cap; ++t) {
        if (labels[t] >= 0 && labels[t] < VOICE_DIARIZER_NUM_CLASSES) hist[(int)labels[t]] += 1;
        if (t > 0 && labels[t] != labels[t - 1]) transitions += 1;
    }
    printf("frames=%zu transitions=%d hist=[", cap, transitions);
    for (int c = 0; c < VOICE_DIARIZER_NUM_CLASSES; ++c) printf("%s%d", c ? "," : "", hist[c]);
    printf("]\n");
    voice_diarizer_close(h);
    return 0;
}
