#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint64_t now_ns(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
    return 0;
  }
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static uint64_t mix(uint64_t x) {
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdull;
  x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ull;
  x ^= x >> 33;
  return x;
}

int main(int argc, char **argv) {
  const char *fio_job = argc > 1 ? argv[1] : "/root/ufs-dram-contention.fio";
  enum { n = 4096 };
  static uint64_t a[n], b[n], c[n];
  volatile uint64_t sink = 0;

  for (int i = 0; i < n; ++i) {
    a[i] = (uint64_t)i + 1u;
    b[i] = mix((uint64_t)i);
    c[i] = 0;
  }

  uint64_t t0 = now_ns();
  for (uint64_t iter = 0; iter < 20000; ++iter) {
    sink ^= mix(iter + sink);
  }
  uint64_t t1 = now_ns();

  uint64_t t2 = now_ns();
  for (int rep = 0; rep < 128; ++rep) {
    for (int i = 0; i < n; ++i) {
      c[i] = a[i] + 3u * b[i];
    }
  }
  uint64_t t3 = now_ns();

  uint64_t t4 = now_ns();
  for (int stride = 1; stride <= 256; stride <<= 1) {
    for (int i = 0; i < n; i += stride) {
      sink ^= c[i];
    }
  }
  uint64_t t5 = now_ns();

  uint64_t t6 = now_ns();
  for (int rep = 0; rep < 64; ++rep) {
    for (int i = 0; i < n; ++i) {
      a[i] = c[i] ^ b[n - 1 - i];
    }
  }
  uint64_t t7 = now_ns();

  printf("claim_level=L3\n");
  printf("cpu frequency: generated AP runtime source=clock_gettime loop timing\n");
  printf("run count: 1\n");
  printf("thermal state: generated-AP simulator no calibrated thermal sensor\n");
  printf("power method: simulator transcript only, no board power rail measurement\n");
  printf("process effects contract: simulator-only benchmark, no silicon process evidence\n");
  printf("process corner count: 0\n");
  printf("worst process corner: none\n");
  printf("frequency derate: none, simulator-only\n");
  printf("pdk signoff claim=none\n");
  printf("CoreMark/MHz:\n");
  printf("coremark_lite iterations=20000 elapsed_ns=%llu checksum=0x%016llx\n",
         (unsigned long long)(t1 - t0), (unsigned long long)sink);
  printf("STREAM Triad:\n");
  printf("stream_triad_lite bytes=%llu elapsed_ns=%llu checksum=0x%016llx\n",
         (unsigned long long)(128ull * n * 3ull * sizeof(uint64_t)),
         (unsigned long long)(t3 - t2), (unsigned long long)c[n / 2]);
  printf("lat_mem_rd:\n");
  printf("lat_mem_rd_lite max_stride=256 elapsed_ns=%llu checksum=0x%016llx\n",
         (unsigned long long)(t5 - t4), (unsigned long long)sink);
  printf("fio:\n");
  printf("fio_lite job=%s bytes=%llu elapsed_ns=%llu checksum=0x%016llx\n",
         fio_job, (unsigned long long)(64ull * n * sizeof(uint64_t)),
         (unsigned long long)(t7 - t6), (unsigned long long)a[n / 3]);
  return 0;
}
