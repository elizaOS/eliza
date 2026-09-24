#define _GNU_SOURCE
#include "gpt-snapshot.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#ifndef BLKGETDISKSEQ
#define BLKGETDISKSEQ _IOR(0x12, 128, uint64_t)
#endif
#define ENVELOPE 128U
#define MAX_ARRAY 4194304U
static const unsigned char magic[16] = "ELIZAOS-GPT-V1";

static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8U |
    (uint32_t)p[2] << 16U | (uint32_t)p[3] << 24U;
}
static uint64_t le64(const unsigned char *p) {
  return (uint64_t)le32(p) | (uint64_t)le32(p + 4) << 32U;
}
static void put32(unsigned char *p, uint32_t n) {
  for (unsigned int i = 0; i < 4U; ++i) p[i] = (unsigned char)(n >> (8U * i));
}
static void put64(unsigned char *p, uint64_t n) {
  put32(p, (uint32_t)n); put32(p + 4, (uint32_t)(n >> 32U));
}
static bool zeroes(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n; ++i) if (p[i] != 0U) return false;
  return true;
}
static uint32_t crc32(const unsigned char *p, size_t n) {
  uint32_t crc = UINT32_MAX;
  for (size_t i = 0; i < n; ++i) {
    crc ^= p[i];
    for (unsigned int bit = 0; bit < 8U; ++bit)
      crc = (crc >> 1U) ^ ((crc & 1U) ? UINT32_C(0xedb88320) : 0U);
  }
  return ~crc;
}
static int sha256(const unsigned char *p, size_t n, unsigned char digest[32]) {
  unsigned int length = 0;
  return EVP_Digest(p, n, digest, &length, EVP_sha256(), NULL) == 1 && length == 32U
    ? 0 : -EIO;
}
static int read_exact(int fd, void *buffer, size_t n, uint64_t offset) {
  if (n > (size_t)INT64_MAX || offset > (uint64_t)INT64_MAX - n) return -EOVERFLOW;
  size_t used = 0;
  while (used < n) {
    ssize_t amount = pread(fd, (unsigned char *)buffer + used, n - used,
                           (off_t)(offset + used));
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) return amount < 0 ? -errno : -EIO;
    used += (size_t)amount;
  }
  return 0;
}
int elizaos_install_check_whole_disk(int fd, const struct elizaos_install_disk_identity *id) {
  if (!id || !id->diskseq || id->size_bytes < UINT64_C(67108864) ||
      id->size_bytes > INT64_MAX ||
      (id->sector_bytes != 512U && id->sector_bytes != 4096U) ||
      id->size_bytes % id->sector_bytes != 0U) return -EINVAL;
  struct stat st;
  if (fstat(fd, &st) != 0) return -errno;
  if (!S_ISBLK(st.st_mode)) return -ENOTBLK;
  if (major(st.st_rdev) != id->major || minor(st.st_rdev) != id->minor) return -ESTALE;
  const int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -errno;
  if ((flags & O_ACCMODE) == O_WRONLY) return -EACCES;
  uint64_t size = 0, sequence = 0;
  int sector = 0;
  if (ioctl(fd, BLKGETSIZE64, &size) != 0 ||
      ioctl(fd, BLKGETDISKSEQ, &sequence) != 0 || ioctl(fd, BLKSSZGET, &sector) != 0)
    return -errno;
  if (size != id->size_bytes || sequence != id->diskseq || sector != (int)id->sector_bytes)
    return -ESTALE;
  char path[96];
  int n = snprintf(path, sizeof(path), "/sys/dev/block/%u:%u/partition", id->major, id->minor);
  if (n < 0 || (size_t)n >= sizeof(path)) return -EINVAL;
  if (lstat(path, &st) == 0) return -EINVAL;
  if (errno != ENOENT) return -errno;
  char *slash = strrchr(path, '/');
  if (!slash) return -EINVAL;
  *slash = '\0';
  if (stat(path, &st) != 0) return -errno;
  if (!S_ISDIR(st.st_mode)) return -ESTALE;
  /* The old FD can outlive its sysfs name. Refuse a replacement device which
   * acquired that dev_t, even if old descriptor metadata remains readable. */
  memcpy(slash, "/diskseq", sizeof("/diskseq"));
  const int sequence_fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (sequence_fd < 0) return -errno;
  char value[32];
  ssize_t count;
  do { count = read(sequence_fd, value, sizeof(value)); } while (count < 0 && errno == EINTR);
  const int read_error = errno;
  const int closed = close(sequence_fd);
  if (count < 0) return -read_error;
  if (closed != 0) return -EIO;
  if (count < 2 || count > 21 || value[count - 1] != '\n' || value[0] == '0') return -ESTALE;
  uint64_t current_sequence = 0;
  for (ssize_t i = 0; i < count - 1; ++i) {
    if (value[i] < '0' || value[i] > '9') return -ESTALE;
    const uint64_t digit = (uint64_t)(value[i] - '0');
    if (current_sequence > (UINT64_MAX - digit) / 10U) return -ESTALE;
    current_sequence = current_sequence * 10U + digit;
  }
  return current_sequence == id->diskseq ? 0 : -ESTALE;
}

static bool valid_header(const unsigned char *p, uint32_t sector) {
  const uint32_t bytes = le32(p + 12);
  if (memcmp(p, "EFI PART", 8U) != 0 || le32(p + 8) != 0x10000U ||
      bytes < 92U || bytes > sector || le32(p + 20) != 0U) return false;
  unsigned char header[4096];
  memcpy(header, p, bytes);
  memset(header + 16, 0, 4U);
  return zeroes(p + bytes, sector - bytes) && crc32(header, bytes) == le32(p + 16);
}
static bool array_geometry(const unsigned char *header, uint32_t sector,
                            uint32_t *bytes, uint32_t *span) {
  const uint32_t count = le32(header + 80), entry = le32(header + 84);
  /* UEFI entries are 128 * 2^n bytes. Bound both work and allocation. */
  if (!count || count > 4096U || entry < 128U || (entry & (entry - 1U)) != 0U ||
      (uint64_t)count * entry < 16384U ||
      (uint64_t)count * entry > MAX_ARRAY) return false;
  *bytes = count * entry;
  *span = ((*bytes + sector - 1U) / sector) * sector;
  return *span <= MAX_ARRAY;
}
static int verify_content(const unsigned char *data, size_t length,
                           const unsigned char binding[32]) {
  if (length < ENVELOPE || length > ELIZAOS_GPT_SNAPSHOT_MAX ||
      memcmp(data, magic, sizeof(magic)) != 0 || memcmp(data + 48, binding, 32U) != 0 ||
      zeroes(binding, 32U) || !zeroes(data + 80, 48U)) return -EINVAL;
  const uint32_t sector = le32(data + 16), span = le32(data + 20);
  const uint64_t size = le64(data + 24);
  if ((sector != 512U && sector != 4096U) || !span || span > MAX_ARRAY ||
      span % sector != 0U || size < UINT64_C(67108864) || size > INT64_MAX ||
      size % sector != 0U || length != ENVELOPE + 3U * sector + 2U * (size_t)span)
    return -EINVAL;
  const uint64_t last = size / sector - 1U;
  const unsigned char *mbr = data + ENVELOPE, *primary = mbr + sector;
  const unsigned char *entries = primary + sector, *secondary_entries = entries + span;
  const unsigned char *secondary = secondary_entries + span;
  if (mbr[510] != 0x55U || mbr[511] != 0xaaU ||
      !zeroes(mbr + 440, 6U) || !zeroes(mbr + 512, sector - 512U) ||
      !valid_header(primary, sector) || !valid_header(secondary, sector) ||
      le32(primary + 12) != le32(secondary + 12)) return -EUCLEAN;
  unsigned int protective_records = 0;
  for (unsigned int i = 0; i < 4U; ++i) {
    const unsigned char *record = mbr + 446U + 16U * i;
    if (zeroes(record, 16U)) continue;
    if (record[0] != 0U || record[4] != 0xeeU || le32(record + 8) != 1U ||
        le32(record + 12) != (last > UINT32_MAX ? UINT32_MAX : (uint32_t)last)) return -EUCLEAN;
    ++protective_records;
  }
  if (protective_records != 1U) return -EUCLEAN;
  uint32_t bytes = 0, actual_span = 0;
  if (!array_geometry(primary, sector, &bytes, &actual_span) || actual_span != span ||
      le64(primary + 24) != 1U || le64(primary + 32) != last ||
      le64(secondary + 24) != last || le64(secondary + 32) != 1U ||
      memcmp(primary + 40, secondary + 40, 32U) != 0 ||
      memcmp(primary + 80, secondary + 80, 12U) != 0 ||
      zeroes(primary + 56, 16U)) return -EUCLEAN;
  const uint64_t first_usable = le64(primary + 40), last_usable = le64(primary + 48);
  const uint64_t first_array = le64(primary + 72), last_array = le64(secondary + 72);
  const uint64_t array_sectors = span / sector;
  if (first_usable < 2U + array_sectors || first_usable > last_usable || last_usable >= last ||
      first_array < 2U || first_array > first_usable - array_sectors ||
      last_array <= last_usable || last_array > last - array_sectors ||
      first_array != le64(data + 32) || last_array != le64(data + 40) ||
      crc32(entries, bytes) != le32(primary + 88) ||
      crc32(secondary_entries, bytes) != le32(secondary + 88) ||
      memcmp(entries, secondary_entries, bytes) != 0) return -EUCLEAN;
  const uint32_t count = le32(primary + 80), stride = le32(primary + 84);
  for (uint32_t i = 0; i < count; ++i) {
    const unsigned char *entry = entries + (size_t)i * stride;
    if (!zeroes(entry + 128, stride - 128U)) return -EUCLEAN;
    if (zeroes(entry, 16U)) {
      if (!zeroes(entry, stride)) return -EUCLEAN;
      continue;
    }
    const uint64_t start = le64(entry + 32), end = le64(entry + 40);
    if (zeroes(entry + 16, 16U) || start < first_usable || end > last_usable || start > end)
      return -EUCLEAN;
    for (uint32_t j = 0; j < i; ++j) {
      const unsigned char *other = entries + (size_t)j * stride;
      if (!zeroes(other, 16U) &&
          (memcmp(entry + 16, other + 16, 16U) == 0 ||
           (start <= le64(other + 40) && le64(other + 32) <= end))) return -EUCLEAN;
    }
  }
  return 0;
}
int elizaos_install_verify_gpt_snapshot(const unsigned char *data, size_t length,
    const unsigned char binding[32], const unsigned char digest[32]) {
  if (!data || !binding || !digest || length > ELIZAOS_GPT_SNAPSHOT_MAX) return -EINVAL;
  unsigned char actual[32];
  int rc = sha256(data, length, actual);
  if (rc) return rc;
  if (CRYPTO_memcmp(actual, digest, 32U) != 0) return -EBADMSG;
  return verify_content(data, length, binding);
}
static int compare_region(int fd, uint64_t offset, const unsigned char *expected, size_t length) {
  unsigned char buffer[65536];
  size_t used = 0;
  while (used < length) {
    const size_t amount = length - used < sizeof(buffer) ? length - used : sizeof(buffer);
    int rc = read_exact(fd, buffer, amount, offset + used);
    if (rc) return rc;
    if (memcmp(buffer, expected + used, amount) != 0) return -ESTALE;
    used += amount;
  }
  return 0;
}
int elizaos_install_capture_gpt(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], unsigned char *output, size_t capacity,
    size_t *length, unsigned char digest[32]) {
  if (!binding || !output || !length || !digest || zeroes(binding, 32U)) return -EINVAL;
  *length = 0;
  int rc = elizaos_install_check_whole_disk(fd, expected);
  if (rc) return rc;
  const uint32_t sector = expected->sector_bytes;
  unsigned char header[4096];
  if ((rc = read_exact(fd, header, sector, sector))) return rc;
  uint32_t bytes = 0, span = 0;
  if (!valid_header(header, sector) || !array_geometry(header, sector, &bytes, &span)) return -EUCLEAN;
  const size_t needed = ENVELOPE + 3U * sector + 2U * (size_t)span;
  if (capacity < needed) return -ENOBUFS;
  memset(output, 0, ENVELOPE);
  memcpy(output, magic, sizeof(magic));
  put32(output + 16, sector); put32(output + 20, span);
  put64(output + 24, expected->size_bytes);
  put64(output + 32, le64(header + 72));
  memcpy(output + 48, binding, 32U);
  unsigned char *mbr = output + ENVELOPE, *primary = mbr + sector;
  unsigned char *entries = primary + sector, *secondary_entries = entries + span;
  unsigned char *secondary = secondary_entries + span;
  const uint64_t last = expected->size_bytes / sector - 1U;
  if ((rc = read_exact(fd, mbr, sector, 0)) ||
      (rc = read_exact(fd, secondary, sector, last * sector))) return rc;
  memcpy(primary, header, sector);
  if (!valid_header(secondary, sector)) return -EUCLEAN;
  const uint64_t first_array = le64(primary + 72), last_array = le64(secondary + 72);
  /* Bound offsets before multiplication or reading any claimed arrays. */
  if (first_array < 2U || first_array > last - span / sector ||
      last_array < 2U || last_array > last - span / sector) return -EUCLEAN;
  put64(output + 40, last_array);
  if ((rc = read_exact(fd, entries, span, first_array * sector)) ||
      (rc = read_exact(fd, secondary_entries, span, last_array * sector)) ||
      (rc = verify_content(output, needed, binding))) return rc;
  if ((rc = compare_region(fd, 0, mbr, sector)) ||
      (rc = compare_region(fd, sector, primary, sector)) ||
      (rc = compare_region(fd, first_array * sector, entries, span)) ||
      (rc = compare_region(fd, last_array * sector, secondary_entries, span)) ||
      (rc = compare_region(fd, last * sector, secondary, sector)) ||
      (rc = elizaos_install_check_whole_disk(fd, expected)) || (rc = sha256(output, needed, digest))) return rc;
  *length = needed;
  return 0;
}


static int restore_guard(int fd, const struct elizaos_install_disk_identity *id,
                          const struct elizaos_gpt_restore_control *control) {
  int rc = control->check(control->context);
  if (rc != 0) return rc < 0 ? rc : -EACCES;
  if ((rc = elizaos_install_check_whole_disk(fd, id))) return rc;
  const int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -errno;
  if ((flags & O_ACCMODE) != O_RDWR || (flags & (O_APPEND | O_DIRECT)) != 0) return -EACCES;
  int readonly = 0;
  if (ioctl(fd, BLKROGET, &readonly) != 0) return -errno;
  return readonly ? -EROFS : 0;
}
static void restore_completed(const struct elizaos_gpt_restore_control *control,
                               struct elizaos_gpt_restore_result *result,
                               enum elizaos_gpt_restore_step step) {
  result->last_completed = step;
  if (control->progress) control->progress(control->context, step);
}
static int restore_region(int fd, const struct elizaos_install_disk_identity *id,
                           const struct elizaos_gpt_restore_control *control,
                           const unsigned char *data, size_t length, uint64_t offset,
                           struct elizaos_gpt_restore_result *result) {
  size_t used = 0;
  while (used < length) {
    int rc = restore_guard(fd, id, control);
    if (rc) return rc;
    const size_t amount = length - used < 65536U ? length - used : 65536U;
    result->write_attempted = 1;
    const ssize_t count = pwrite(fd, data + used, amount, (off_t)(offset + used));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return count < 0 ? -errno : -EIO;
    used += (size_t)count;
    result->bytes_written += (uint64_t)count;
  }
  return restore_guard(fd, id, control);
}
int elizaos_install_restore_gpt(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_restore_control *control,
    struct elizaos_gpt_restore_result *result) {
  if (!result) return -EINVAL;
  memset(result, 0, sizeof(*result));
  result->last_completed = ELIZAOS_GPT_RESTORE_NOT_STARTED;
  result->error = -EINVAL;
  if (!expected || !binding || !data || !digest || !control || !control->check ||
      length < ENVELOPE || length > ELIZAOS_GPT_SNAPSHOT_MAX) return result->error;
  /* Neither callback activity nor caller-owned input mutation may replace the
   * bytes/identity which were verified for this invocation. */
  const struct elizaos_install_disk_identity id = *expected;
  const struct elizaos_gpt_restore_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  unsigned char *copy = malloc(length);
  if (!copy) { result->error = -ENOMEM; return result->error; }
  memcpy(copy, data, length);
  int rc = elizaos_install_verify_gpt_snapshot(copy, length, saved_binding, saved_digest);
  if (rc) goto finish;
  if (le32(copy + 16) != id.sector_bytes || le64(copy + 24) != id.size_bytes) {
    rc = -ESTALE; goto finish;
  }
  if ((rc = restore_guard(fd, &id, &hooks))) goto finish;
  restore_completed(&hooks, result, ELIZAOS_GPT_RESTORE_VALIDATED);
  const uint32_t sector = id.sector_bytes, span = le32(copy + 20);
  const uint64_t last = id.size_bytes / sector - 1U;
  const uint64_t first_array = le64(copy + 32), last_array = le64(copy + 40);
  const unsigned char *mbr = copy + ENVELOPE, *primary = mbr + sector;
  const unsigned char *entries = primary + sector, *secondary_entries = entries + span;
  const unsigned char *secondary = secondary_entries + span;
#define WRITE_REGION(bytes, count, offset, step) do { \
  rc = restore_region(fd, &id, &hooks, (bytes), (count), (offset), result); \
  if (rc) goto finish; \
  restore_completed(&hooks, result, (step)); \
} while (0)
  WRITE_REGION(secondary_entries, span, last_array * sector, ELIZAOS_GPT_RESTORE_BACKUP_ARRAY_WRITTEN);
  rc = restore_region(fd, &id, &hooks, secondary, sector, last * sector, result);
  if (rc) goto finish;
  if (fsync(fd) != 0) { rc = -errno; goto finish; }
  if ((rc = compare_region(fd, last_array * sector, secondary_entries, span)) ||
      (rc = compare_region(fd, last * sector, secondary, sector)) ||
      (rc = restore_guard(fd, &id, &hooks))) goto finish;
  restore_completed(&hooks, result, ELIZAOS_GPT_RESTORE_BACKUP_SYNCED);
  WRITE_REGION(entries, span, first_array * sector, ELIZAOS_GPT_RESTORE_PRIMARY_ARRAY_WRITTEN);
  WRITE_REGION(primary, sector, sector, ELIZAOS_GPT_RESTORE_PRIMARY_HEADER_WRITTEN);
  WRITE_REGION(mbr, sector, 0, ELIZAOS_GPT_RESTORE_MBR_WRITTEN);
  if ((rc = restore_guard(fd, &id, &hooks))) goto finish;
  if (fsync(fd) != 0) { rc = -errno; goto finish; }
  if ((rc = restore_guard(fd, &id, &hooks))) goto finish;
  restore_completed(&hooks, result, ELIZAOS_GPT_RESTORE_MEDIA_SYNCED);
  if ((rc = restore_guard(fd, &id, &hooks)) ||
      (rc = compare_region(fd, 0, mbr, sector)) ||
      (rc = compare_region(fd, sector, primary, sector)) ||
      (rc = compare_region(fd, first_array * sector, entries, span)) ||
      (rc = compare_region(fd, last_array * sector, secondary_entries, span)) ||
      (rc = compare_region(fd, last * sector, secondary, sector)) ||
      (rc = restore_guard(fd, &id, &hooks))) goto finish;
  restore_completed(&hooks, result, ELIZAOS_GPT_RESTORE_VERIFIED);
finish:
  free(copy);
  result->error = rc;
  return rc;
#undef WRITE_REGION
}


static int decimal_at(int directory, const char *name, uint64_t *value) {
  const int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -errno;
  char text[32];
  ssize_t count;
  do { count = read(fd, text, sizeof(text)); } while (count < 0 && errno == EINTR);
  const int saved = errno;
  const int closed = close(fd);
  if (count < 0) return -saved;
  if (closed != 0) return -EIO;
  if (count < 2 || count > 21 || text[count - 1] != '\n' ||
      (count > 2 && text[0] == '0')) return -ESTALE;
  uint64_t number = 0;
  for (ssize_t i = 0; i < count - 1; ++i) {
    if (text[i] < '0' || text[i] > '9') return -ESTALE;
    const uint64_t digit = (uint64_t)(text[i] - '0');
    if (number > (UINT64_MAX - digit) / 10U) return -ESTALE;
    number = number * 10U + digit;
  }
  *value = number;
  return 0;
}
static int exact_snapshot(int fd, const struct elizaos_install_disk_identity *id,
                          const unsigned char *original, size_t length,
                          const unsigned char binding[32], const unsigned char digest[32]) {
  unsigned char *actual = malloc(length), actual_digest[32];
  if (!actual) return -ENOMEM;
  size_t actual_length = 0;
  int rc = elizaos_install_capture_gpt(fd, id, binding, actual, length, &actual_length, actual_digest);
  if (!rc && (actual_length != length || CRYPTO_memcmp(actual_digest, digest, 32U) != 0 ||
              memcmp(actual, original, length) != 0)) rc = -ESTALE;
  free(actual);
  return rc;
}
static int exact_kernel_map(int fd, const struct elizaos_install_disk_identity *id,
                            const struct elizaos_gpt_restore_control *control,
                            const unsigned char *artifact, uint32_t *partitions) {
  char path[64];
  const int n = snprintf(path, sizeof(path), "/sys/dev/block/%u:%u", id->major, id->minor);
  if (n < 0 || (size_t)n >= sizeof(path)) return -EINVAL;
  DIR *directory = opendir(path);
  if (!directory) return -errno;
  const unsigned char *header = artifact + ENVELOPE + id->sector_bytes;
  const unsigned char *entries = header + id->sector_bytes;
  const uint32_t count = le32(header + 80), stride = le32(header + 84);
  bool seen[4096] = { false };
  uint32_t matched = 0, visited = 0;
  int rc = 0;
  for (;;) {
    errno = 0;
    const struct dirent *child = readdir(directory);
    if (!child) { if (errno) rc = -errno; break; }
    if (strcmp(child->d_name, ".") == 0 || strcmp(child->d_name, "..") == 0) continue;
    if (++visited > 8192U) { rc = -E2BIG; break; }
    if ((rc = restore_guard(fd, id, control))) break;
    struct stat st;
    if (fstatat(dirfd(directory), child->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) { rc = -errno; break; }
    if (!S_ISDIR(st.st_mode)) continue;
    const int part = openat(dirfd(directory), child->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (part < 0) { rc = -errno; break; }
    uint64_t index = 0, start = 0, size = 0;
    rc = decimal_at(part, "partition", &index);
    if (rc == -ENOENT) { rc = close(part) == 0 ? 0 : -EIO; if (rc) break; continue; }
    if (!rc && (!index || index > count || seen[index - 1U])) rc = -ESTALE;
    if (!rc) rc = decimal_at(part, "start", &start);
    if (!rc) rc = decimal_at(part, "size", &size);
    if (!rc) {
      const unsigned char *entry = entries + (size_t)(index - 1U) * stride;
      /* Kernel sysfs extents are always in 512-byte sectors. */
      const uint64_t scale = id->sector_bytes / 512U;
      if (zeroes(entry, 16U) || start != le64(entry + 32) * scale ||
          size != (le64(entry + 40) - le64(entry + 32) + 1U) * scale) rc = -ESTALE;
      else { seen[index - 1U] = true; ++matched; }
    }
    struct stat current;
    if (!rc && (fstatat(dirfd(directory), child->d_name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
                current.st_dev != st.st_dev || current.st_ino != st.st_ino)) rc = -ESTALE;
    if (close(part) != 0 && !rc) rc = -EIO;
    if (rc) break;
  }
  if (closedir(directory) != 0 && !rc) rc = -EIO;
  for (uint32_t i = 0; !rc && i < count; ++i)
    if (seen[i] == zeroes(entries + (size_t)i * stride, 16U)) rc = -ESTALE;
  if (!rc) *partitions = matched;
  return rc;
}
int elizaos_install_refresh_gpt_map(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_restore_control *control,
    struct elizaos_gpt_map_result *result) {
  if (!result) return -EINVAL;
  memset(result, 0, sizeof(*result)); result->error = -EINVAL;
  if (!expected || !binding || !data || !digest || !control || !control->check ||
      length < ENVELOPE || length > ELIZAOS_GPT_SNAPSHOT_MAX) return result->error;
  const struct elizaos_install_disk_identity id = *expected;
  const struct elizaos_gpt_restore_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  unsigned char *copy = malloc(length);
  if (!copy) { result->error = -ENOMEM; return result->error; }
  memcpy(copy, data, length);
  int rc = elizaos_install_verify_gpt_snapshot(copy, length, saved_binding, saved_digest);
  if (rc) goto finish_map;
  if (le32(copy + 16) != id.sector_bytes || le64(copy + 24) != id.size_bytes) {
    rc = -ESTALE; goto finish_map;
  }
  if ((rc = restore_guard(fd, &id, &hooks)) ||
      (rc = exact_snapshot(fd, &id, copy, length, saved_binding, saved_digest)) ||
      (rc = restore_guard(fd, &id, &hooks))) goto finish_map;
  result->reread_attempted = 1;
  if (ioctl(fd, BLKRRPART) != 0) { rc = -errno; goto finish_map; }
  uint32_t partitions = 0;
  if ((rc = restore_guard(fd, &id, &hooks)) ||
      (rc = exact_kernel_map(fd, &id, &hooks, copy, &partitions)) ||
      (rc = exact_snapshot(fd, &id, copy, length, saved_binding, saved_digest)) ||
      (rc = restore_guard(fd, &id, &hooks))) goto finish_map;
  result->partitions = partitions;
  result->verified = 1;
finish_map:
  free(copy);
  result->error = rc;
  return rc;
}
