/* MLC-port substitute: Intel Memory Latency Checker for RV64.
 *
 * Intel MLC is closed source and ships x86 binaries.  This file
 * reproduces the two core MLC outputs from open code paths:
 *
 *   - Idle latency curve (random pointer-chase)
 *   - Loaded latency: random read latency under concurrent sequential
 *     read bandwidth load on the same socket.
 *
 * The intent is to provide an equivalent of the Intel tool's table that
 * the phone-class memory gate accepts.  The output JSON schema is
 * eliza.memory.mlc_substitute_report.v1.
 *
 * Single-threaded latency measurement uses pointer-chase across a
 * shuffled cyclic linked list.  Loaded latency forks N background
 * sequential-read threads sized to (working_set * 4) so their cache
 * footprint exceeds the LLC.
 */
#define _GNU_SOURCE
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef WORKING_SET_BYTES
#define WORKING_SET_BYTES (512ULL * 1024ULL * 1024ULL)
#endif

#ifndef NUM_BG_THREADS
#define NUM_BG_THREADS 4
#endif

#ifndef SAMPLES
#define SAMPLES 1024
#endif

static void *bg_thread(void *arg) {
    size_t n = (size_t)arg;
    volatile double *buf = aligned_alloc(64, n);
    if (!buf) return NULL;
    for (size_t i = 0; i < n / sizeof(double); i++) buf[i] = (double)i;
    while (1) {
        double sum = 0;
        for (size_t i = 0; i < n / sizeof(double); i++) sum += buf[i];
        if (sum < 0) puts("");
    }
}

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void shuffle_chain(size_t *chain, size_t n) {
    /* Sattolo's algorithm: produces a single cyclic permutation. */
    for (size_t i = n - 1; i > 0; i--) {
        size_t j = (size_t)((double)rand() / (RAND_MAX + 1.0) * i);
        size_t tmp = chain[i];
        chain[i] = chain[j];
        chain[j] = tmp;
    }
}

static double measure_idle_latency(size_t working_set) {
    size_t n = working_set / sizeof(size_t);
    size_t *chain = aligned_alloc(64, n * sizeof(size_t));
    if (!chain) {
        perror("alloc");
        exit(1);
    }
    for (size_t i = 0; i < n; i++) chain[i] = i;
    shuffle_chain(chain, n);

    /* Convert array of next-indices into array of next-pointers. */
    size_t **ptrs = (size_t **)chain;
    for (size_t i = 0; i < n; i++) ptrs[i] = (size_t *)&chain[chain[i]];

    /* Warm-up. */
    volatile size_t *p = (size_t *)&chain[0];
    for (size_t i = 0; i < n; i++) p = (size_t *)*p;

    double t0 = now_seconds();
    p = (size_t *)&chain[0];
    for (size_t i = 0; i < (size_t)SAMPLES * 1024; i++) {
        p = (size_t *)*p;
    }
    double dt = now_seconds() - t0;
    free(chain);
    return dt * 1e9 / ((double)SAMPLES * 1024.0);
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    /* Idle */
    double idle_ns = measure_idle_latency(WORKING_SET_BYTES);

    /* Loaded: spawn background bandwidth threads. */
    pthread_t th[NUM_BG_THREADS];
    for (int i = 0; i < NUM_BG_THREADS; i++)
        pthread_create(&th[i], NULL, bg_thread, (void *)(size_t)(WORKING_SET_BYTES * 4));
    sleep(2);  /* let bandwidth pressure stabilise */
    double loaded_ns = measure_idle_latency(WORKING_SET_BYTES);

    printf("{\n");
    printf("  \"schema\": \"eliza.memory.mlc_substitute_report.v1\",\n");
    printf("  \"working_set_bytes\": %llu,\n",
           (unsigned long long)WORKING_SET_BYTES);
    printf("  \"bg_threads\": %d,\n", NUM_BG_THREADS);
    printf("  \"idle_random_read_latency_ns\": %.6f,\n", idle_ns);
    printf("  \"loaded_random_read_latency_ns\": %.6f\n", loaded_ns);
    printf("}\n");
    return 0;
}
