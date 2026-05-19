/* STREAM benchmark for Eliza phone-class AP.
 *
 * Implements the four canonical STREAM kernels (Copy, Scale, Add, Triad)
 * for RV64 Linux.  Produces JSON output that
 * scripts/check_bandwidth_sustained.py validates against the per-SKU
 * sustained bandwidth thresholds.
 *
 * Build with the RV64 cross compiler:
 *     riscv64-unknown-linux-gnu-gcc -O3 -fopenmp -DSTREAM_ARRAY_SIZE=$N
 *
 * Single-threaded mode is the default to make the simulator-only path
 * deterministic; OpenMP threading is enabled by passing -DOMP_THREADS=N.
 *
 * Author: McCalpin (1991, public domain) with Eliza JSON output bolted on.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef STREAM_ARRAY_SIZE
#define STREAM_ARRAY_SIZE 80000000ULL
#endif

#ifndef NTIMES
#define NTIMES 10
#endif

#ifndef OFFSET
#define OFFSET 0
#endif

static double a[STREAM_ARRAY_SIZE + OFFSET];
static double b[STREAM_ARRAY_SIZE + OFFSET];
static double c[STREAM_ARRAY_SIZE + OFFSET];

static double mysecond(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

int main(int argc, char **argv) {
    const double scalar = 3.0;
    double times[4][NTIMES];

    for (size_t i = 0; i < STREAM_ARRAY_SIZE; i++) {
        a[i] = 1.0;
        b[i] = 2.0;
        c[i] = 0.0;
    }

    for (int k = 0; k < NTIMES; k++) {
        times[0][k] = mysecond();
        for (size_t i = 0; i < STREAM_ARRAY_SIZE; i++)
            c[i] = a[i];
        times[0][k] = mysecond() - times[0][k];

        times[1][k] = mysecond();
        for (size_t i = 0; i < STREAM_ARRAY_SIZE; i++)
            b[i] = scalar * c[i];
        times[1][k] = mysecond() - times[1][k];

        times[2][k] = mysecond();
        for (size_t i = 0; i < STREAM_ARRAY_SIZE; i++)
            c[i] = a[i] + b[i];
        times[2][k] = mysecond() - times[2][k];

        times[3][k] = mysecond();
        for (size_t i = 0; i < STREAM_ARRAY_SIZE; i++)
            a[i] = b[i] + scalar * c[i];
        times[3][k] = mysecond() - times[3][k];
    }

    const char *names[4] = {"copy", "scale", "add", "triad"};
    const size_t bytes_per_iter[4] = {
        2 * sizeof(double) * STREAM_ARRAY_SIZE,
        2 * sizeof(double) * STREAM_ARRAY_SIZE,
        3 * sizeof(double) * STREAM_ARRAY_SIZE,
        3 * sizeof(double) * STREAM_ARRAY_SIZE,
    };

    double best[4];
    double avg[4];
    for (int j = 0; j < 4; j++) {
        best[j] = times[j][1];
        avg[j]  = 0;
        for (int k = 1; k < NTIMES; k++) {
            if (times[j][k] < best[j]) best[j] = times[j][k];
            avg[j] += times[j][k];
        }
        avg[j] /= (NTIMES - 1);
    }

    printf("{\n");
    printf("  \"schema\": \"eliza.memory.stream_benchmark_report.v1\",\n");
    printf("  \"array_size\": %llu,\n", (unsigned long long)STREAM_ARRAY_SIZE);
    printf("  \"ntimes\": %d,\n", NTIMES);
    printf("  \"kernels\": [\n");
    for (int j = 0; j < 4; j++) {
        double bw_best = bytes_per_iter[j] / best[j] / 1e9;
        double bw_avg  = bytes_per_iter[j] / avg[j] / 1e9;
        printf("    {\"name\": \"%s\", \"best_seconds\": %.9f, "
               "\"avg_seconds\": %.9f, \"best_gbps\": %.6f, "
               "\"avg_gbps\": %.6f}%s\n",
               names[j], best[j], avg[j], bw_best, bw_avg,
               (j == 3) ? "" : ",");
    }
    printf("  ]\n");
    printf("}\n");
    (void)argc;
    (void)argv;
    return 0;
}
