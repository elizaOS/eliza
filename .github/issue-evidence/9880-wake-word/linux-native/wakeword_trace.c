/*
 * wakeword_trace — like wakeword_score_raw, but reports the per-frame score
 * trajectory so we can distinguish a sustained wake (many frames over the
 * threshold) from a transient spike (one stray frame peaking high).
 *
 *   wakeword_trace mel.gguf emb.gguf cls.gguf clip.f32 [threshold]
 *
 * Feeds the stream in 80 ms (1280-sample) hops — the runtime's natural hop —
 * and prints: peak, peak time (s), #frames >= threshold, total frames,
 * and the frame index of the peak.
 */
#include <stdio.h>
#include <stdlib.h>
#include "wakeword/wakeword.h"

int main(int argc, char **argv) {
	if (argc < 5) {
		fprintf(stderr, "usage: %s <mel> <emb> <cls> <audio.f32> [threshold]\n", argv[0]);
		return 2;
	}
	float thr = (argc >= 6) ? (float)atof(argv[5]) : 0.5f;
	wakeword_handle h;
	if (wakeword_open(argv[1], argv[2], argv[3], &h) != 0) {
		fprintf(stderr, "open failed\n");
		return 1;
	}
	FILE *f = fopen(argv[4], "rb");
	if (!f) { fprintf(stderr, "cannot open %s\n", argv[4]); wakeword_close(h); return 1; }
	float buf[1280];
	float peak = 0.0f, score = 0.0f;
	size_t n, frame = 0, peak_frame = 0, over = 0, run = 0, max_run = 0;
	while ((n = fread(buf, sizeof(float), 1280, f)) > 0) {
		if (wakeword_process(h, buf, n, &score) == 0) {
			if (score >= thr) { over++; run++; if (run > max_run) max_run = run; }
			else run = 0;
			if (score > peak) { peak = score; peak_frame = frame; }
		}
		frame++;
	}
	fclose(f);
	wakeword_close(h);
	double hop_s = 1280.0 / 16000.0; /* 0.08 s */
	printf("peak=%.4f peak_t=%.2fs over_%.2f=%zu max_run=%zu /%zu peak_frame=%zu\n",
	       peak, (double)peak_frame * hop_s, thr, over, max_run, frame, peak_frame);
	return 0;
}
