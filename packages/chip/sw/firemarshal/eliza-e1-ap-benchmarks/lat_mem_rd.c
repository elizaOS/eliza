/*
 * Minimal lmbench-style lat_mem_rd target for generated-AP transcripts.
 *
 * This is not a drop-in lmbench replacement; it emits the same simple
 * "size latency_ns" shape the evidence parser needs while staying small
 * enough for the FireMarshal no-disk initramfs.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint64_t monotonic_ns(void) {
	struct timespec ts;
	if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
		return 0;
	}
	return ((uint64_t)ts.tv_sec * 1000000000ull) + (uint64_t)ts.tv_nsec;
}

static size_t parse_max_bytes(int argc, char **argv) {
	if (argc < 2) {
		return 32u * 1024u * 1024u;
	}

	char *end = NULL;
	double value = strtod(argv[1], &end);
	if (value <= 0.0) {
		return 32u * 1024u * 1024u;
	}
	if (end && (*end == 'm' || *end == 'M')) {
		value *= 1024.0 * 1024.0;
	}
	return (size_t)value;
}

int main(int argc, char **argv) {
	const size_t stride = argc >= 3 ? (size_t)strtoull(argv[2], NULL, 0) : 128u;
	const size_t max_bytes = parse_max_bytes(argc, argv);
	volatile uint8_t sink = 0;

	for (size_t bytes = 512u * 1024u; bytes <= max_bytes; bytes <<= 1) {
		uint8_t *buf = calloc(bytes, 1);
		if (!buf) {
			fprintf(stderr, "lat_mem_rd: allocation failed at %zu bytes\n", bytes);
			return 2;
		}

		for (size_t i = 0; i < bytes; i += stride) {
			buf[i] = (uint8_t)i;
		}

		const size_t touches = bytes / stride;
		const uint64_t start = monotonic_ns();
		for (size_t repeat = 0; repeat < 8; repeat++) {
			for (size_t i = 0; i < bytes; i += stride) {
				sink ^= buf[i];
			}
		}
		const uint64_t elapsed = monotonic_ns() - start;
		const double latency = touches == 0 ? 0.0 : (double)elapsed / (double)(touches * 8u);
		printf("%.5f %.3f\n", (double)bytes / (1024.0 * 1024.0), latency);
		free(buf);
	}

	if (sink == 255) {
		fprintf(stderr, "lat_mem_rd: sink=%u\n", (unsigned)sink);
	}
	return 0;
}
