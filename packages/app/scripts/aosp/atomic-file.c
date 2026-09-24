/**
 * Publishes a complete temporary file without replacing any existing target.
 * The caller owns file preparation, validation, fsync and temporary cleanup.
 * Version 1 returns zero on installation or the positive Linux errno; it never
 * emulates no-replace with ordinary rename and makes no durability claim.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>

int eliza_atomic_file_publish_noreplace_v1(const char *source, const char *target) {
  if (source == NULL || target == NULL) return EINVAL;
  if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE) == 0) return 0;
  return errno;
}
