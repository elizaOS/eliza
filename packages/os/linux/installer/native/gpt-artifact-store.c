#define _GNU_SOURCE
#include "gpt-artifact-store.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/sysmacros.h>
#include <unistd.h>

static void artifact_name(const unsigned char digest[32], char name[69]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 32U; ++i) {
    name[2U * i] = hex[digest[i] >> 4U];
    name[2U * i + 1U] = hex[digest[i] & 15U];
  }
  memcpy(name + 64, ".gpt", 5U);
}
static int storage_guard(int directory, const struct elizaos_gpt_store_identity *id,
                          const struct elizaos_gpt_store_control *control) {
  int rc = control->check(control->context);
  if (rc) return rc < 0 ? rc : -EACCES;
  struct stat st;
  if (fstat(directory, &st) != 0) return -errno;
  if (geteuid() != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 07777U) != 0700U || !st.st_nlink) return -EACCES;
  if ((uint64_t)st.st_dev != id->filesystem_device ||
      (uint64_t)st.st_ino != id->directory_inode) return -ESTALE;
  struct statfs filesystem;
  if (fstatfs(directory, &filesystem) != 0) return -errno;
  if (filesystem.f_type != EXT4_SUPER_MAGIC) return -EOPNOTSUPP;
  return 0;
}
static bool safe_file(const struct stat *st, uint64_t device) {
  return S_ISREG(st->st_mode) && st->st_uid == 0 && st->st_gid == 0 &&
    (st->st_mode & 07777U) == 0600U && st->st_nlink == 1 &&
    (uint64_t)st->st_dev == device && st->st_size >= 0 &&
    (uint64_t)st->st_size <= ELIZAOS_GPT_SNAPSHOT_MAX;
}
static int file_binding(int directory, int file, const char *name,
                         const struct stat *original) {
  struct stat held, named;
  if (fstat(file, &held) != 0 || fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0)
    return -errno;
  if (!safe_file(&held, (uint64_t)original->st_dev) ||
      !safe_file(&named, (uint64_t)original->st_dev) ||
      held.st_ino != original->st_ino || named.st_ino != held.st_ino ||
      held.st_size != original->st_size || named.st_size != held.st_size ||
      held.st_mtim.tv_sec != original->st_mtim.tv_sec ||
      held.st_mtim.tv_nsec != original->st_mtim.tv_nsec ||
      held.st_ctim.tv_sec != original->st_ctim.tv_sec ||
      held.st_ctim.tv_nsec != original->st_ctim.tv_nsec) return -ESTALE;
  return 0;
}
static int write_binding(int directory, int file, const char *name,
                          const struct stat *created, size_t size) {
  struct stat current;
  if (fstat(file, &current) != 0) return -errno;
  if (current.st_ino != created->st_ino || current.st_dev != created->st_dev ||
      current.st_size < 0 || (uint64_t)current.st_size != size) return -ESTALE;
  return file_binding(directory, file, name, &current);
}
int elizaos_install_read_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char digest[32],
    const struct elizaos_gpt_store_control *control,
    unsigned char *output, size_t capacity, size_t *length) {
  if (length) *length = 0;
  if (!expected || !binding || !digest || !control || !control->check || !output || !length)
    return -EINVAL;
  const struct elizaos_gpt_store_identity id = *expected;
  const struct elizaos_gpt_store_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  int rc = storage_guard(directory, &id, &hooks);
  if (rc) return rc;
  char name[69]; artifact_name(saved_digest, name);
  const int file = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (file < 0) return -errno;
  unsigned char *copy = NULL;
  struct stat st;
  if (fstat(file, &st) != 0) { rc = -errno; goto finish_read; }
  if (!safe_file(&st, id.filesystem_device) || st.st_size < 128) { rc = -EINVAL; goto finish_read; }
  const size_t size = (size_t)st.st_size;
  if (size > capacity) { rc = -ENOBUFS; goto finish_read; }
  copy = malloc(size);
  if (!copy) { rc = -ENOMEM; goto finish_read; }
  size_t used = 0;
  while (used < size) {
    if ((rc = storage_guard(directory, &id, &hooks))) goto finish_read;
    const size_t amount = size - used < 65536U ? size - used : 65536U;
    const ssize_t got = pread(file, copy + used, amount, (off_t)used);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { rc = got < 0 ? -errno : -EIO; goto finish_read; }
    used += (size_t)got;
  }
  if ((rc = elizaos_install_verify_gpt_snapshot(copy, size, saved_binding, saved_digest)) ||
      (rc = file_binding(directory, file, name, &st)) ||
      (rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  if (fsync(file) != 0) { rc = -errno; goto finish_read; }
  if ((rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  if (fsync(directory) != 0) { rc = -errno; goto finish_read; }
  if ((rc = file_binding(directory, file, name, &st)) ||
      (rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  memcpy(output, copy, size);
  *length = size;
finish_read:
  if (close(file) != 0 && !rc) rc = -EIO;
  if (rc) *length = 0;
  free(copy);
  return rc;
}
static void progress(const struct elizaos_gpt_store_control *control,
                       enum elizaos_gpt_store_step step) {
  if (control->progress) control->progress(control->context, step);
}
int elizaos_install_store_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_store_control *control,
    struct elizaos_gpt_store_result *result) {
  if (!result) return -EINVAL;
  memset(result, 0, sizeof(*result)); result->error = -EINVAL;
  if (!expected || !binding || !data || !digest || !control || !control->check ||
      length < 128U || length > ELIZAOS_GPT_SNAPSHOT_MAX) return result->error;
  const struct elizaos_gpt_store_identity id = *expected;
  const struct elizaos_gpt_store_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  unsigned char *copy = malloc(length);
  if (!copy) { result->error = -ENOMEM; return result->error; }
  memcpy(copy, data, length);
  int file = -1;
  int rc = elizaos_install_verify_gpt_snapshot(copy, length, saved_binding, saved_digest);
  if (rc || (rc = storage_guard(directory, &id, &hooks))) goto finish_store;
  char name[69]; artifact_name(saved_digest, name);
  result->create_attempted = 1;
  file = openat(directory, name, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (file < 0) { rc = -errno; goto finish_store; }
  result->created = 1;
  struct stat st;
  if (fstat(file, &st) != 0) { rc = -errno; goto finish_store; }
  if (!safe_file(&st, id.filesystem_device) || st.st_size != 0) { rc = -EACCES; goto finish_store; }
  progress(&hooks, ELIZAOS_GPT_STORE_CREATED);
  size_t used = 0;
  while (used < length) {
    if ((rc = storage_guard(directory, &id, &hooks)) ||
        (rc = write_binding(directory, file, name, &st, used))) goto finish_store;
    const size_t amount = length - used < 65536U ? length - used : 65536U;
    const ssize_t wrote = pwrite(file, copy + used, amount, (off_t)used);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) { rc = wrote < 0 ? -errno : -EIO; goto finish_store; }
    used += (size_t)wrote;
    result->bytes_written += (uint64_t)wrote;
  }
  progress(&hooks, ELIZAOS_GPT_STORE_WRITTEN);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (fsync(file) != 0) { rc = -errno; goto finish_store; }
  result->file_synced = 1;
  progress(&hooks, ELIZAOS_GPT_STORE_FILE_SYNCED);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (fsync(directory) != 0) { rc = -errno; goto finish_store; }
  result->directory_synced = 1;
  progress(&hooks, ELIZAOS_GPT_STORE_DIRECTORY_SYNCED);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (close(file) != 0) { file = -1; rc = -EIO; goto finish_store; }
  file = -1;
  size_t read_length = 0;
  rc = elizaos_install_read_gpt_artifact(directory, &id, saved_binding, saved_digest,
                                        &hooks, copy, length, &read_length);
  if (!rc && read_length != length) rc = -ESTALE;
  if (!rc) {
    result->verified = 1;
    progress(&hooks, ELIZAOS_GPT_STORE_VERIFIED);
  }
finish_store:
  if (file >= 0 && close(file) != 0 && !rc) rc = -EIO;
  free(copy);
  result->error = rc;
  return rc;
}


static int sysfs_disk(dev_t device) {
  char path[96];
  const int n = snprintf(path, sizeof(path), "/sys/dev/block/%u:%u", major(device), minor(device));
  if (n < 0 || (size_t)n >= sizeof(path)) return -EINVAL;
  const int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  return fd < 0 ? -errno : fd;
}
static int direct_disk(int node) {
  /* Stacked/loop/network devices do not establish independent physical backing.
   * A real device link is necessary but not sufficient; policy still excludes
   * hardware aliases such as two paths to the same LUN. */
  struct stat st;
  if (fstatat(node, "device", &st, 0) != 0) return -errno;
  if (!S_ISDIR(st.st_mode)) return -EINVAL;
  int fd = openat(node, "slaves", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -errno;
  DIR *directory = fdopendir(fd);
  if (!directory) { const int rc = -errno; close(fd); return rc; }
  int rc = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory))) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { rc = -EOPNOTSUPP; break; }
  }
  if (!rc && errno) rc = -errno;
  if (closedir(directory) != 0 && !rc) rc = -errno;
  return rc;
}
static int positive_sysfs_number(int directory, const char *name, uint64_t *value) {
  const int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -errno;
  char text[32];
  ssize_t count;
  do { count = read(fd, text, sizeof(text)); } while (count < 0 && errno == EINTR);
  const int read_error = errno;
  const int closed = close(fd);
  if (count < 0) return -read_error;
  if (closed != 0) return -EIO;
  if (count < 2 || count > 21 || text[0] == '0' || text[count - 1] != '\n') return -EINVAL;
  uint64_t number = 0;
  for (ssize_t index = 0; index < count - 1; ++index) {
    if (text[index] < '0' || text[index] > '9') return -EINVAL;
    uint64_t digit = (uint64_t)(text[index] - '0');
    if (number > (UINT64_MAX - digit) / 10U) return -EOVERFLOW;
    number = number * 10U + digit;
  }
  *value = number;
  return 0;
}
int elizaos_install_check_recovery_storage(int directory,
    const struct elizaos_gpt_store_identity *expected_directory,
    int partition, int storage,
    const struct elizaos_install_disk_identity *expected_storage,
    int target, const struct elizaos_install_disk_identity *expected_target) {
  if (!expected_directory || !expected_storage || !expected_target) return -EINVAL;
  const struct elizaos_gpt_store_identity id = *expected_directory;
  const struct elizaos_install_disk_identity storage_id = *expected_storage, target_id = *expected_target;
  int rc = elizaos_install_check_whole_disk(storage, &storage_id);
  if (rc || (rc = elizaos_install_check_whole_disk(target, &target_id))) return rc;
  if (storage_id.major == target_id.major && storage_id.minor == target_id.minor) return -EXDEV;
  struct stat dir, part;
  if (fstat(directory, &dir) != 0 || fstat(partition, &part) != 0) return -errno;
  if (geteuid() != 0 || !S_ISDIR(dir.st_mode) || dir.st_uid != 0 || dir.st_gid != 0 ||
      (dir.st_mode & 07777U) != 0700U || !dir.st_nlink) return -EACCES;
  if ((uint64_t)dir.st_dev != id.filesystem_device || (uint64_t)dir.st_ino != id.directory_inode ||
      !S_ISBLK(part.st_mode) || part.st_rdev != dir.st_dev) return -ESTALE;
  struct statfs filesystem;
  if (fstatfs(directory, &filesystem) != 0) return -errno;
  if (filesystem.f_type != EXT4_SUPER_MAGIC) return -EOPNOTSUPP;
  const int flags = fcntl(partition, F_GETFL);
  if (flags < 0) return -errno;
  if ((flags & O_ACCMODE) == O_WRONLY) return -EACCES;
  uint64_t bytes = 0, sequence = 0;
  int sector = 0;
  if (ioctl(partition, BLKGETSIZE64, &bytes) != 0 || ioctl(partition, BLKGETDISKSEQ, &sequence) != 0 ||
      ioctl(partition, BLKSSZGET, &sector) != 0) return -errno;
  if (sequence != storage_id.diskseq || sector != (int)storage_id.sector_bytes) return -ESTALE;
  int storage_node = -1, target_node = -1, part_node = -1, parent = -1;
  storage_node = sysfs_disk(makedev(storage_id.major, storage_id.minor));
  if (storage_node < 0) { rc = storage_node; goto finish_storage; }
  target_node = sysfs_disk(makedev(target_id.major, target_id.minor));
  if (target_node < 0) { rc = target_node; goto finish_storage; }
  part_node = sysfs_disk(part.st_rdev);
  if (part_node < 0) { rc = part_node; goto finish_storage; }
  parent = openat(part_node, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) { rc = -errno; goto finish_storage; }
  struct stat whole_stat, parent_stat;
  if (fstat(storage_node, &whole_stat) != 0 || fstat(parent, &parent_stat) != 0) {
    rc = -errno; goto finish_storage;
  }
  if (whole_stat.st_dev != parent_stat.st_dev || whole_stat.st_ino != parent_stat.st_ino) {
    rc = -EXDEV; goto finish_storage;
  }
  uint64_t number = 0, start = 0, sectors = 0;
  if ((rc = positive_sysfs_number(part_node, "partition", &number)) ||
      (rc = positive_sysfs_number(part_node, "start", &start)) ||
      (rc = positive_sysfs_number(part_node, "size", &sectors)) ||
      (rc = direct_disk(storage_node)) || (rc = direct_disk(target_node))) goto finish_storage;
  if (number > UINT32_MAX || sectors > UINT64_MAX / 512U || sectors * 512U != bytes ||
      start > storage_id.size_bytes / 512U || sectors > storage_id.size_bytes / 512U - start) {
    rc = -ESTALE; goto finish_storage;
  }
  rc = elizaos_install_check_whole_disk(storage, &storage_id);
  if (!rc) rc = elizaos_install_check_whole_disk(target, &target_id);
finish_storage:
  if (parent >= 0 && close(parent) != 0 && !rc) rc = -EIO;
  if (part_node >= 0 && close(part_node) != 0 && !rc) rc = -EIO;
  if (target_node >= 0 && close(target_node) != 0 && !rc) rc = -EIO;
  if (storage_node >= 0 && close(storage_node) != 0 && !rc) rc = -EIO;
  return rc;
}
