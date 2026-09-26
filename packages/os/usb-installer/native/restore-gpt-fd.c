#define _GNU_SOURCE
#include "restore-gpt-fd.h"

#include <errno.h>
#include <fcntl.h>
#include <libfdisk/libfdisk.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define ENTRY_COUNT 128U
#define ENTRY_BYTES 128U
#define ARRAY_BYTES (ENTRY_COUNT * ENTRY_BYTES)
#define MIB (1024U * 1024U)

static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8U) |
         ((uint32_t)p[2] << 16U) | ((uint32_t)p[3] << 24U);
}

static uint64_t le64(const unsigned char *p) {
  return (uint64_t)le32(p) | ((uint64_t)le32(p + 4) << 32U);
}

static uint32_t crc32(const unsigned char *data, size_t size) {
  uint32_t crc = UINT32_MAX;
  for (size_t index = 0; index < size; ++index) {
    crc ^= data[index];
    for (unsigned int bit = 0; bit < 8U; ++bit)
      crc = (crc >> 1U) ^ ((crc & 1U) ? UINT32_C(0xedb88320) : 0U);
  }
  return ~crc;
}

static bool zeroes(const unsigned char *data, size_t size) {
  for (size_t index = 0; index < size; ++index)
    if (data[index] != 0U) return false;
  return true;
}

static int read_exact(int fd, void *buffer, size_t size, uint64_t offset) {
  unsigned char *bytes = buffer;
  if (offset > (uint64_t)INT64_MAX - size) return -EOVERFLOW;
  size_t read_bytes = 0;
  while (read_bytes < size) {
    const ssize_t count = pread(fd, bytes + read_bytes, size - read_bytes,
                                (off_t)(offset + read_bytes));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return count < 0 ? -errno : -EIO;
    read_bytes += (size_t)count;
  }
  return 0;
}

static int validate_fd(int fd, const struct elizaos_restore_identity *expected,
                       bool writing, unsigned int *sector_bytes) {
  struct stat metadata;
  uint64_t size = 0;
  uint64_t diskseq = 0;
  int sector = 0;
  int readonly = 0;
  if (!expected || !expected->diskseq || expected->size_bytes < 64U * MIB ||
      expected->size_bytes > (uint64_t)INT64_MAX) return -EINVAL;
  if (fstat(fd, &metadata) != 0) return -errno;
  if (!S_ISBLK(metadata.st_mode)) return -ENOTBLK;
  if (major(metadata.st_rdev) != expected->major ||
      minor(metadata.st_rdev) != expected->minor) return -ESTALE;
  const int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -errno;
  if ((flags & O_ACCMODE) == O_WRONLY ||
      (writing && (flags & O_ACCMODE) != O_RDWR)) return -EACCES;
  if (ioctl(fd, BLKGETSIZE64, &size) != 0 ||
      ioctl(fd, BLKGETDISKSEQ, &diskseq) != 0 ||
      ioctl(fd, BLKSSZGET, &sector) != 0 ||
      ioctl(fd, BLKROGET, &readonly) != 0) return -errno;
  if (size != expected->size_bytes || diskseq != expected->diskseq)
    return -ESTALE;
  if ((sector != 512 && sector != 4096) || size % (uint64_t)sector != 0U)
    return -EINVAL;
  if (writing && readonly) return -EROFS;
  char partition_path[96];
  const int length = snprintf(partition_path, sizeof(partition_path),
                              "/sys/dev/block/%u:%u/partition",
                              expected->major, expected->minor);
  if (length < 0 || (size_t)length >= sizeof(partition_path)) return -EINVAL;
  if (lstat(partition_path, &metadata) == 0) return -EINVAL;
  if (errno != ENOENT) return -errno;
  /* ENOENT is a whole-disk result only when its sysfs device exists. */
  char *slash = strrchr(partition_path, '/');
  if (!slash) return -EINVAL;
  *slash = '\0';
  if (stat(partition_path, &metadata) != 0) return -errno;
  if (!S_ISDIR(metadata.st_mode)) return -EINVAL;
  *sector_bytes = (unsigned int)sector;
  return 0;
}

/* Inspect the actual primary AND backup bytes. libfdisk may reconstruct a
 * damaged header in memory, so its in-memory verifier is not this readback. */
int elizaos_restore_verify_gpt(int fd,
                             const struct elizaos_restore_identity *expected) {
  unsigned int sector = 0;
  int rc = validate_fd(fd, expected, false, &sector);
  if (rc) return rc;
  const uint64_t last_lba = expected->size_bytes / sector - 1U;
  const uint64_t array_sectors = ARRAY_BYTES / sector;
  unsigned char headers[2][4096];
  unsigned char entries[2][ARRAY_BYTES];
  unsigned char mbr[512];
  if ((rc = read_exact(fd, mbr, sizeof(mbr), 0))) return rc;
  if (mbr[510] != 0x55U || mbr[511] != 0xaaU || mbr[450] != 0xeeU ||
      le32(mbr + 454) != 1U ||
      le32(mbr + 458) != (last_lba > UINT32_MAX ? UINT32_MAX : (uint32_t)last_lba) ||
      !zeroes(mbr + 462, 48U)) return -EUCLEAN;
  for (unsigned int copy = 0; copy < 2U; ++copy) {
    const uint64_t lba = copy == 0U ? 1U : last_lba;
    const uint64_t other_lba = copy == 0U ? last_lba : 1U;
    const uint64_t array_lba = copy == 0U ? 2U : last_lba - array_sectors;
    unsigned char *header = headers[copy];
    if ((rc = read_exact(fd, header, sector, lba * sector))) return rc;
    if (memcmp(header, "EFI PART", 8U) != 0 || le32(header + 8) != 0x10000U ||
        le32(header + 12) != 92U || le32(header + 20) != 0U ||
        le64(header + 24) != lba || le64(header + 32) != other_lba ||
        le64(header + 40) != MIB / sector ||
        le64(header + 48) != last_lba - array_sectors - 1U ||
        zeroes(header + 56, 16U) || le64(header + 72) != array_lba ||
        le32(header + 80) != ENTRY_COUNT || le32(header + 84) != ENTRY_BYTES)
      return -EUCLEAN;
    const uint32_t header_crc = le32(header + 16);
    memset(header + 16, 0, 4U);
    if (crc32(header, 92U) != header_crc) return -EUCLEAN;
    if ((rc = read_exact(fd, entries[copy], ARRAY_BYTES, array_lba * sector)))
      return rc;
    if (crc32(entries[copy], ARRAY_BYTES) != le32(header + 88)) return -EUCLEAN;
  }
  if (memcmp(headers[0] + 56, headers[1] + 56, 16U) != 0 ||
      memcmp(entries[0], entries[1], ARRAY_BYTES) != 0) return -EUCLEAN;
  static const unsigned char basic_data_guid[16] = {
      0xa2, 0xa0, 0xd0, 0xeb, 0xe5, 0xb9, 0x33, 0x44,
      0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7};
  static const unsigned char name[72] = {'E', 0, 'L', 0, 'I', 0, 'Z', 0,
                                        'A', 0, 'O', 0, 'S', 0};
  const unsigned char *entry = entries[0];
  const uint64_t start = MIB / sector;
  const uint64_t end = last_lba - array_sectors - 1U;
  if (memcmp(entry, basic_data_guid, sizeof(basic_data_guid)) != 0 ||
      zeroes(entry + 16, 16U) || le64(entry + 32) != start ||
      le64(entry + 40) != end || le64(entry + 48) != 0U ||
      memcmp(entry + 56, name, sizeof(name)) != 0 ||
      !zeroes(entry + ENTRY_BYTES, ARRAY_BYTES - ENTRY_BYTES)) return -EUCLEAN;
  return validate_fd(fd, expected, false, &sector);
}

int elizaos_restore_create_gpt(int fd,
                             const struct elizaos_restore_identity *expected) {
  unsigned int sector = 0;
  int rc = validate_fd(fd, expected, true, &sector);
  if (rc) return rc;
  struct fdisk_context *context = fdisk_new_context();
  struct fdisk_partition *partition = NULL;
  struct fdisk_parttype *type = NULL;
  if (!context) return -ENOMEM;
  char diagnostic_name[64];
  const int length = snprintf(diagnostic_name, sizeof(diagnostic_name),
                              "/proc/self/fd/%d", fd);
  if (length < 0 || (size_t)length >= sizeof(diagnostic_name)) {
    rc = -EINVAL;
    goto finish;
  }
  if ((rc = fdisk_disable_dialogs(context, 1)) ||
      (rc = fdisk_assign_device_by_fd(context, fd, diagnostic_name, 0)) ||
      (rc = fdisk_disable_dialogs(context, 1)) ||
      (rc = fdisk_enable_wipe(context, 0))) goto finish;
  (void)fdisk_set_first_lba(context, MIB / sector);
  if ((rc = fdisk_create_disklabel(context, "gpt"))) goto finish;
  const uint64_t start = MIB / sector;
  const uint64_t end = expected->size_bytes / sector - ARRAY_BYTES / sector - 2U;
  if (fdisk_get_devfd(context) != fd || fdisk_get_sector_size(context) != sector ||
      fdisk_get_nsectors(context) != expected->size_bytes / sector ||
      fdisk_get_last_lba(context) != end) {
    rc = -EINVAL;
    goto finish;
  }
  partition = fdisk_new_partition();
  type = fdisk_new_parttype();
  if (!partition || !type) { rc = -ENOMEM; goto finish; }
  if ((rc = fdisk_parttype_set_typestr(type, "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7")) ||
      (rc = fdisk_partition_set_type(partition, type)) ||
      (rc = fdisk_partition_set_partno(partition, 0)) ||
      (rc = fdisk_partition_set_start(partition, start)) ||
      (rc = fdisk_partition_set_size(partition, end - start + 1U)) ||
      (rc = fdisk_partition_size_explicit(partition, 1)) ||
      (rc = fdisk_partition_set_name(partition, "ELIZAOS")) ||
      (rc = fdisk_add_partition(context, partition, NULL)) ||
      (rc = fdisk_verify_disklabel(context))) goto finish;
  if ((rc = validate_fd(fd, expected, true, &sector))) goto finish;
  rc = fdisk_write_disklabel(context);
  if (rc) goto finish;
  if (fsync(fd) != 0) { rc = -errno; goto finish; }
  rc = elizaos_restore_verify_gpt(fd, expected);
finish:
  if (type) fdisk_unref_parttype(type);
  if (partition) fdisk_unref_partition(partition);
  /* The library does not own this descriptor. Do not reassign or reopen it. */
  fdisk_unref_context(context);
  return rc > 0 ? -EIO : rc;
}
