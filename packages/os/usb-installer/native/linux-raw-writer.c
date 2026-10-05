#define _GNU_SOURCE
#include "../../linux/installer/native/gpt-snapshot.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

/* Invoked through the desktop's privilege escalator, never setuid. stdin is
 * exactly the reviewed image; stdout is its flushed readback. The exclusive
 * whole-device descriptor stays open through both phases. */
static unsigned char buffer[4U * 1024U * 1024U];

static int number(const char *text, uint64_t *value) {
  if (!text || !*text || (text[0] == '0' && text[1])) return -EINVAL;
  uint64_t result = 0;
  for (const char *p = text; *p; ++p) {
    if (*p < '0' || *p > '9' || result > (UINT64_MAX - (unsigned)(*p - '0')) / 10U)
      return -EINVAL;
    result = result * 10U + (unsigned)(*p - '0');
  }
  *value = result;
  return 0;
}

static int write_all(int fd, const void *bytes, size_t length) {
  size_t used = 0;
  while (used < length) {
    ssize_t n = write(fd, (const unsigned char *)bytes + used, length - used);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return n < 0 ? -errno : -EIO;
    used += (size_t)n;
  }
  return 0;
}

static int transfer(int fd, const struct elizaos_install_disk_identity *id,
                    uint64_t length, int readback) {
  uint64_t total = 0;
  while (total < length) {
    size_t amount = length - total > sizeof(buffer) ? sizeof(buffer) : (size_t)(length - total);
    int rc = elizaos_install_check_whole_disk(fd, id);
    if (rc) return rc;
    ssize_t n;
    do { n = read(readback ? fd : STDIN_FILENO, buffer, amount); } while (n < 0 && errno == EINTR);
    if (n <= 0) return n < 0 ? -errno : -ENODATA;
    /* Input may have waited on a slow producer while the device disappeared. */
    if ((rc = elizaos_install_check_whole_disk(fd, id))) return rc;
    if ((rc = write_all(readback ? STDOUT_FILENO : fd, buffer, (size_t)n))) return rc;
    total += (uint64_t)n;
  }
  return elizaos_install_check_whole_disk(fd, id);
}

static int run(int argc, char **argv) {
  if (argc != 8 || geteuid() != 0) return -EINVAL;
  if (strncmp(argv[1], "/dev/", 5) || !argv[1][5] || strchr(argv[1] + 5, '/')) return -EINVAL;
  uint64_t fields[6];
  for (unsigned i = 0; i < 6; ++i) if (number(argv[i + 2], &fields[i])) return -EINVAL;
  if (fields[0] > UINT32_MAX || fields[1] > UINT32_MAX || fields[4] > UINT32_MAX ||
      fields[5] == 0 || fields[5] > fields[3] || fields[5] > INT64_MAX) return -EINVAL;
  struct elizaos_install_disk_identity id = {
    .major = (uint32_t)fields[0], .minor = (uint32_t)fields[1],
    .diskseq = fields[2], .size_bytes = fields[3], .sector_bytes = (uint32_t)fields[4]
  };
  int fd = open(argv[1], O_RDWR | O_EXCL | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -errno;
  int rc = transfer(fd, &id, fields[5], 0);
  if (!rc) {
    unsigned char extra;
    ssize_t n;
    do { n = read(STDIN_FILENO, &extra, 1); } while (n < 0 && errno == EINTR);
    if (n != 0) rc = n < 0 ? -errno : -EFBIG;
  }
  if (!rc) rc = elizaos_install_check_whole_disk(fd, &id);
  if (!rc && fsync(fd)) rc = -errno;
  /* Drop block cache after the durable write, so verification reads the device. */
  if (!rc && ioctl(fd, BLKFLSBUF)) rc = -errno;
  if (!rc && lseek(fd, 0, SEEK_SET) != 0) rc = -errno;
  if (!rc) rc = write_all(STDERR_FILENO, "ELIZAOS_RAW_SYNCED\n", 19);
  if (!rc) rc = transfer(fd, &id, fields[5], 1);
  if (close(fd) && !rc) rc = -errno;
  return rc;
}

int main(int argc, char **argv) {
  const int rc = run(argc, argv);
  if (rc) fprintf(stderr, "elizaOS raw writer failed: %s (%d)\n", strerror(-rc), -rc);
  return rc ? EXIT_FAILURE : EXIT_SUCCESS;
}
