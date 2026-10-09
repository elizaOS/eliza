/*
 * wakeword_score_raw — score a raw 16 kHz mono float32 PCM stream through the
 * real wake-word runtime and print the peak classifier probability.
 *
 * Unlike wakeword_runtime_test (synthetic silence + chirp), this drives ARBITRARY
 * audio so the shipped eliza-1 head can be verified against real speech:
 *
 *   ffmpeg -i hey-eliza.wav -ar 16000 -ac 1 -f f32le clip.f32
 *   wakeword_score_raw mel.gguf emb.gguf cls.gguf clip.f32
 *
 * Prints the max P(wake) over the stream (one line, 4 decimals). NOTE: the
 * streaming pipeline needs ~1.9 s of audio to fill the mel+embedding rings, so a
 * positive clip must carry warm-up audio before the phrase (see this dir's
 * CLAUDE.md). Exit 0 on success, 1 on I/O / open failure, 2 on usage.
 */
#include <stdio.h>
#include "wakeword/wakeword.h"

int main(int argc, char **argv) {
	if (argc != 5) {
		fprintf(stderr,
			"usage: %s <melspec.gguf> <embedding.gguf> <classifier.gguf> <audio.f32>\n",
			argv[0]);
		return 2;
	}
	wakeword_handle h;
	if (wakeword_open(argv[1], argv[2], argv[3], &h) != 0) {
		fprintf(stderr, "[wakeword-score] open failed\n");
		return 1;
	}
	FILE *f = fopen(argv[4], "rb");
	if (!f) {
		fprintf(stderr, "[wakeword-score] cannot open %s\n", argv[4]);
		wakeword_close(h);
		return 1;
	}
	float buf[1280];
	float peak = 0.0f, score = 0.0f;
	size_t n;
	while ((n = fread(buf, sizeof(float), 1280, f)) > 0) {
		if (wakeword_process(h, buf, n, &score) == 0 && score > peak) {
			peak = score;
		}
	}
	fclose(f);
	wakeword_close(h);
	printf("%.4f\n", peak);
	return 0;
}
