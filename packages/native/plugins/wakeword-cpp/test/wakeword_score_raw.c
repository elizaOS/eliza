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
 * With no gate arguments, prints the max P(wake) over the stream (one line, 4
 * decimals) for backward compatibility. Optional threshold + activation-frame
 * arguments report the sustained gate used by OpenWakeWordDetector, and an
 * optional fire/no-fire expectation turns the scorer into an assertion.
 *
 * NOTE: the streaming pipeline needs ~1.9 s of audio to fill the
 * mel+embedding rings, so a positive clip must carry warm-up audio before the
 * phrase (see this dir's CLAUDE.md). Exit 0 on success, 1 on I/O, model, or
 * expectation failure, 2 on usage.
 */
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "wakeword/wakeword.h"

static int parse_gate_args(
	int argc,
	char **argv,
	float *threshold,
	size_t *min_activation_frames,
	int *expected_fire
) {
	if (argc == 5) return 0;
	if (argc != 7 && argc != 8) return -1;

	char *threshold_end = NULL;
	errno = 0;
	const float parsed_threshold = strtof(argv[5], &threshold_end);
	if (errno != 0 || !threshold_end || threshold_end == argv[5] ||
		*threshold_end != '\0' || !isfinite(parsed_threshold) ||
		parsed_threshold < 0.0f || parsed_threshold > 1.0f) {
		return -1;
	}

	char *frames_end = NULL;
	errno = 0;
	const unsigned long parsed_frames = strtoul(argv[6], &frames_end, 10);
	if (errno != 0 || !frames_end || *frames_end != '\0' ||
		parsed_frames == 0) {
		return -1;
	}

	*threshold = parsed_threshold;
	*min_activation_frames = (size_t)parsed_frames;
	if (argc == 8) {
		if (strcmp(argv[7], "fire") == 0) {
			*expected_fire = 1;
		} else if (strcmp(argv[7], "no-fire") == 0) {
			*expected_fire = 0;
		} else {
			return -1;
		}
	}
	return 1;
}

int main(int argc, char **argv) {
	float threshold = 0.0f;
	size_t min_activation_frames = 0;
	int expected_fire = -1;
	const int gate_mode = parse_gate_args(
		argc,
		argv,
		&threshold,
		&min_activation_frames,
		&expected_fire
	);
	if (gate_mode < 0) {
		fprintf(stderr,
			"usage: %s <melspec.gguf> <embedding.gguf> <classifier.gguf> <audio.f32>"
			" [<threshold> <min-activation-frames> [fire|no-fire]]\n",
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
	size_t activation_streak = 0;
	size_t max_activation_streak = 0;
	size_t frames = 0;
	int fired = 0;
	size_t n;
	while ((n = fread(buf, sizeof(float), 1280, f)) > 0) {
		/* The production TypeScript detector only submits complete 1280-sample
		 * frames. Keep legacy peak mode's arbitrary-tail behavior, but do not let
		 * a short final read extend a sustained activation streak. */
		if (gate_mode > 0 && n < 1280) break;
		if (wakeword_process(h, buf, n, &score) != 0) {
			fprintf(stderr, "[wakeword-score] process failed at frame %zu\n", frames);
			fclose(f);
			wakeword_close(h);
			return 1;
		}
		frames++;
		if (score > peak) peak = score;
		if (gate_mode > 0) {
			if (score >= threshold) {
				activation_streak++;
				if (activation_streak > max_activation_streak) {
					max_activation_streak = activation_streak;
				}
				if (activation_streak >= min_activation_frames) fired = 1;
			} else {
				activation_streak = 0;
			}
		}
	}
	if (ferror(f)) {
		fprintf(stderr, "[wakeword-score] read failed for %s\n", argv[4]);
		fclose(f);
		wakeword_close(h);
		return 1;
	}
	fclose(f);
	wakeword_close(h);
	if (gate_mode == 0) {
		printf("%.4f\n", peak);
		return 0;
	}
	if (frames == 0) {
		fprintf(stderr, "[wakeword-score] gate input has no complete 1280-sample frame\n");
		return 1;
	}

	printf(
		"peak=%.4f max_streak=%zu fired=%d frames=%zu threshold=%.4f min_activation_frames=%zu\n",
		peak,
		max_activation_streak,
		fired,
		frames,
		threshold,
		min_activation_frames
	);
	if (expected_fire >= 0 && fired != expected_fire) {
		fprintf(
			stderr,
			"[wakeword-score] expectation failed: expected %s, observed %s\n",
			expected_fire ? "fire" : "no-fire",
			fired ? "fire" : "no-fire"
		);
		return 1;
	}
	return 0;
}
