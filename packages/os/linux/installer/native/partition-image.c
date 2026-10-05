#define _GNU_SOURCE
#include "partition-image.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#define CHUNK (4U * 1024U * 1024U)

static int image_unchanged(int image, const struct stat *original) {
  struct stat current;
  if (fstat(image, &current) != 0)
    return -errno;
  if (!S_ISREG(current.st_mode) || current.st_uid || current.st_gid ||
      (current.st_mode & 07777U) != 0600U || current.st_nlink != 1 ||
      current.st_dev != original->st_dev ||
      current.st_ino != original->st_ino ||
      current.st_size != original->st_size ||
      current.st_mtim.tv_sec != original->st_mtim.tv_sec ||
      current.st_mtim.tv_nsec != original->st_mtim.tv_nsec ||
      current.st_ctim.tv_sec != original->st_ctim.tv_sec ||
      current.st_ctim.tv_nsec != original->st_ctim.tv_nsec)
    return -ESTALE;
  return 0;
}
static int guarded(int target,
                   const struct elizaos_install_disk_identity *identity,
                   int image, const struct stat *source,
                   const struct elizaos_gpt_restore_control *control) {
  int rc = control->check(control->context);
  if (rc)
    return rc < 0 ? rc : -EACCES;
  if ((rc = elizaos_install_check_whole_disk(target, identity)))
    return rc;
  return image_unchanged(image, source);
}
static int read_all(int fd, unsigned char *bytes, size_t length,
                    uint64_t offset) {
  size_t used = 0;
  while (used < length) {
    ssize_t count =
        pread(fd, bytes + used, length - used, (off_t)(offset + used));
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      return count < 0 ? -errno : -EIO;
    used += (size_t)count;
  }
  return 0;
}
int elizaos_install_write_partition_image(
    int target, const struct elizaos_install_disk_identity *identity,
    const unsigned char *snapshot, size_t snapshot_length,
    const unsigned char binding[32], const unsigned char snapshot_digest[32],
    uint32_t partition_index, int image, const unsigned char image_digest[32],
    const struct elizaos_gpt_restore_control *control,
    struct elizaos_partition_image_result *result) {
  if (!result)
    return -EINVAL;
  memset(result, 0, sizeof(*result));
  result->error = -EINVAL;
  if (!identity || !image_digest || !control || !control->check)
    return result->error;
  struct stat source;
  int rc = 0;
  uint64_t start = 0, length = 0;
  if ((rc = elizaos_install_gpt_partition_extent(
           snapshot, snapshot_length, binding, snapshot_digest, partition_index,
           &start, &length)))
    goto done;
  if (length > identity->size_bytes || start > identity->size_bytes - length ||
      length > INT64_MAX || start > (uint64_t)INT64_MAX - length) {
    rc = -EOVERFLOW;
    goto done;
  }
  if (fstat(image, &source) != 0) {
    rc = -errno;
    goto done;
  }
  if (source.st_size < 0 || (uint64_t)source.st_size != length) {
    rc = -EINVAL;
    goto done;
  }
  if ((rc = guarded(target, identity, image, &source, control)))
    goto done;
  const int flags = fcntl(target, F_GETFL);
  if (flags < 0) {
    rc = -errno;
    goto done;
  }
  if ((flags & O_ACCMODE) != O_RDWR || (flags & (O_APPEND | O_DIRECT))) {
    rc = -EACCES;
    goto done;
  }
  int readonly = 0;
  if (ioctl(target, BLKROGET, &readonly) != 0) {
    rc = -errno;
    goto done;
  }
  if (readonly) {
    rc = -EROFS;
    goto done;
  }
  unsigned char *bytes = malloc(CHUNK);
  EVP_MD_CTX *hash = EVP_MD_CTX_new();
  if (!bytes || !hash) {
    free(bytes);
    EVP_MD_CTX_free(hash);
    rc = -ENOMEM;
    goto done;
  }
  /* Three complete passes: source preflight, exact copied bytes, uncached
   * media. */
  for (unsigned int pass = 0; pass < 3U; ++pass) {
    if (EVP_DigestInit_ex(hash, EVP_sha256(), NULL) != 1) {
      rc = -EIO;
      break;
    }
    for (uint64_t offset = 0; offset < length;) {
      if ((rc = guarded(target, identity, image, &source, control)))
        break;
      const size_t count =
          length - offset < CHUNK ? (size_t)(length - offset) : CHUNK;
      rc = read_all(pass == 2U ? target : image, bytes, count,
                    pass == 2U ? start + offset : offset);
      if (rc)
        break;
      if (EVP_DigestUpdate(hash, bytes, count) != 1) {
        rc = -EIO;
        break;
      }
      if (pass == 1U) {
        size_t used = 0;
        while (used < count) {
          if ((rc = guarded(target, identity, image, &source, control)))
            break;
          result->write_attempted = 1;
          const ssize_t written = pwrite(target, bytes + used, count - used,
                                         (off_t)(start + offset + used));
          if (written < 0 && errno == EINTR)
            continue;
          if (written <= 0) {
            rc = written < 0 ? -errno : -EIO;
            break;
          }
          used += (size_t)written;
          result->bytes_written += (uint64_t)written;
        }
        if (rc)
          break;
      }
      offset += count;
    }
    if (rc)
      break;
    unsigned char actual[32];
    unsigned int size = 0;
    if (EVP_DigestFinal_ex(hash, actual, &size) != 1 || size != 32U) {
      rc = -EIO;
      break;
    }
    if (CRYPTO_memcmp(actual, image_digest, 32U)) {
      rc = -EBADMSG;
      break;
    }
    if ((rc = guarded(target, identity, image, &source, control)))
      break;
    if (pass == 1U) {
      if (fsync(target) != 0 || ioctl(target, BLKFLSBUF) != 0) {
        rc = -errno;
        break;
      }
      result->synced = 1;
    }
  }
  EVP_MD_CTX_free(hash);
  free(bytes);
  if (!rc)
    result->verified = 1;
done:
  if (rc && result->write_attempted && !result->synced) {
    /* Cancellation stops new writes, but the caller waits for buffered writes
     * to settle before releasing the claim or reporting the failed operation.
     */
    if (fsync(target) != 0)
      result->settle_error = -errno;
    else
      result->synced = 1;
  }
  result->error = rc;
  return rc;
}
