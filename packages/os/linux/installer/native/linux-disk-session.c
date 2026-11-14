#define _GNU_SOURCE
#include "gpt-artifact-store.h"
#include "node-api-minimal.h"
#include "partition-image.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <openssl/crypto.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Trusted service API only. Holds the physical claim until explicit close or
 * finalization. GPT edits require the exact current snapshot and a verified
 * original backup; filesystem/payload operations are separate. */
static const napi_type_tag session_tag = {UINT64_C(0xec9766c93a7e4801),
                                          UINT64_C(0x91eff4eca9f45814)};
struct disk_session {
  int target, storage, partition, directory;
  struct elizaos_install_disk_identity target_id, storage_id;
  struct elizaos_gpt_store_identity directory_id;
  char directory_path[PATH_MAX];
  bool mutation_failed, busy;
  atomic_bool cancel_requested;
};

static napi_value failure(napi_env env, const char *operation, int rc) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s (%d)", operation, strerror(-rc),
           -rc);
  napi_throw_error(env, "ELIZAOS_INSTALL_DISK_ERROR", message);
  return NULL;
}
static int release(struct disk_session *session) {
  int error = 0;
  int *fds[] = {&session->target, &session->storage, &session->partition,
                &session->directory};
  for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); ++i) {
    if (*fds[i] >= 0) {
      int fd = *fds[i];
      *fds[i] = -1;
      if (close(fd) != 0 && !error)
        error = -errno;
    }
  }
  return error;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  struct disk_session *session = data;
  if (session) {
    release(session);
    free(session);
  }
}
static int buffer(napi_env env, napi_value value, unsigned char **bytes,
                  size_t *length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, value, (void **)bytes, length) != napi_ok)
    return -EINVAL;
  return 0;
}
static int exact(napi_env env, napi_value value, unsigned char *copy,
                 size_t expected) {
  unsigned char *bytes;
  size_t length;
  if (buffer(env, value, &bytes, &length) || length != expected)
    return -EINVAL;
  memcpy(copy, bytes, length);
  return 0;
}
static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8U | (uint32_t)p[2] << 16U |
         (uint32_t)p[3] << 24U;
}
static uint64_t le64(const unsigned char *p) {
  return (uint64_t)le32(p) | (uint64_t)le32(p + 4) << 32U;
}
static int identity(napi_env env, napi_value value,
                    struct elizaos_install_disk_identity *id) {
  unsigned char bytes[32];
  if (exact(env, value, bytes, sizeof(bytes)) || le32(bytes + 28) != 0)
    return -EINVAL;
  *id =
      (struct elizaos_install_disk_identity){.major = le32(bytes),
                                             .minor = le32(bytes + 4),
                                             .diskseq = le64(bytes + 8),
                                             .size_bytes = le64(bytes + 16),
                                             .sector_bytes = le32(bytes + 24)};
  return 0;
}
static int path_value(napi_env env, napi_value value, char output[PATH_MAX]) {
  size_t length = 0, copied = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      !length || length >= PATH_MAX ||
      napi_get_value_string_utf8(env, value, output, PATH_MAX, &copied) !=
          napi_ok ||
      copied != length || strlen(output) != length || output[0] != '/')
    return -EINVAL;
  return 0;
}
static int guard(void *context) {
  struct disk_session *s = context;
  if (s->target < 0 || s->storage < 0 || s->partition < 0 || s->directory < 0)
    return -EBADF;
  struct stat named;
  if (lstat(s->directory_path, &named) != 0)
    return -errno;
  if (!S_ISDIR(named.st_mode) ||
      (uint64_t)named.st_dev != s->directory_id.filesystem_device ||
      (uint64_t)named.st_ino != s->directory_id.directory_inode)
    return -ESTALE;
  return elizaos_install_check_recovery_storage(
      s->directory, &s->directory_id, s->partition, s->storage, &s->storage_id,
      s->target, &s->target_id);
}
static struct disk_session *arguments_any(napi_env env, napi_callback_info info,
                                          size_t wanted, napi_value *argv,
                                          bool allow_busy) {
  napi_value self;
  size_t argc = 0;
  bool tagged = false;
  if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok ||
      argc != wanted ||
      napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok ||
      napi_check_object_type_tag(env, self, &session_tag, &tagged) != napi_ok ||
      !tagged) {
    failure(env, "Invalid native disk session call", -EINVAL);
    return NULL;
  }
  struct disk_session *session = NULL;
  if (napi_unwrap(env, self, (void **)&session) != napi_ok || !session) {
    failure(env, "Invalid native disk session", -EINVAL);
    return NULL;
  }
  if (session->busy && !allow_busy) {
    failure(env, "Installer image operation is still running", -EBUSY);
    return NULL;
  }
  return session;
}
static struct disk_session *arguments(napi_env env, napi_callback_info info,
                                      size_t wanted, napi_value *argv) {
  return arguments_any(env, info, wanted, argv, false);
}
static napi_value check(napi_env env, napi_callback_info info) {
  struct disk_session *session = arguments(env, info, 0, NULL);
  if (!session)
    return NULL;
  int rc = guard(session);
  if (rc)
    return failure(env, "Check retained installer storage", rc);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value close_session(napi_env env, napi_callback_info info) {
  struct disk_session *session = arguments(env, info, 0, NULL);
  if (!session)
    return NULL;
  int rc = release(session);
  if (rc)
    return failure(env, "Close retained installer storage", rc);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value backup(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  struct disk_session *s = arguments(env, info, 1, argv);
  if (!s)
    return NULL;
  unsigned char binding[32], digest[32];
  if (exact(env, argv[0], binding, sizeof(binding)))
    return failure(env, "Invalid backup binding", -EINVAL);
  int rc = guard(s);
  if (rc)
    return failure(env, "Check backup storage", rc);
  unsigned char *data = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  if (!data)
    return failure(env, "Allocate GPT snapshot", -ENOMEM);
  size_t length = 0;
  rc = elizaos_install_capture_gpt(s->target, &s->target_id, binding, data,
                                   ELIZAOS_GPT_SNAPSHOT_MAX, &length, digest);
  struct elizaos_gpt_store_result stored;
  const struct elizaos_gpt_store_control control = {.context = s,
                                                    .check = guard};
  if (!rc)
    rc = elizaos_install_store_gpt_artifact(s->directory, &s->directory_id,
                                            binding, data, length, digest,
                                            &control, &stored);
  free(data);
  if (rc)
    return failure(
        env, "Persist partition-table backup (retain any partial artifact)",
        rc);
  napi_value result;
  if (napi_create_buffer_copy(env, sizeof(digest), digest, NULL, &result) !=
      napi_ok)
    return failure(env, "Return persisted backup digest", -ENOMEM);
  return result;
}
static napi_value verify(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  struct disk_session *s = arguments(env, info, 2, argv);
  if (!s)
    return NULL;
  unsigned char binding[32], digest[32];
  if (exact(env, argv[0], binding, sizeof(binding)) ||
      exact(env, argv[1], digest, sizeof(digest)))
    return failure(env, "Invalid backup verification binding", -EINVAL);
  int rc = guard(s);
  if (rc)
    return failure(env, "Check backup storage", rc);
  unsigned char *data = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  if (!data)
    return failure(env, "Allocate backup readback", -ENOMEM);
  size_t length = 0;
  const struct elizaos_gpt_store_control control = {.context = s,
                                                    .check = guard};
  rc = elizaos_install_read_gpt_artifact(s->directory, &s->directory_id,
                                         binding, digest, &control, data,
                                         ELIZAOS_GPT_SNAPSHOT_MAX, &length);
  free(data);
  if (rc)
    return failure(env, "Verify durable partition-table backup", rc);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
struct edit_context {
  struct disk_session *session;
  unsigned char binding[32], original_digest[32];
  unsigned char *scratch;
};
static int edit_guard(void *context) {
  struct edit_context *edit = context;
  struct disk_session *s = edit->session;
  int rc = guard(s);
  if (rc)
    return rc;
  size_t length = 0;
  const struct elizaos_gpt_store_control control = {.context = s,
                                                    .check = guard};
  return elizaos_install_read_gpt_artifact(
      s->directory, &s->directory_id, edit->binding, edit->original_digest,
      &control, edit->scratch, ELIZAOS_GPT_SNAPSHOT_MAX, &length);
}
static void encode64(unsigned char *output, uint64_t number) {
  for (unsigned int i = 0; i < 8U; ++i)
    output[i] = (unsigned char)(number >> (i * 8U));
}
static void encode32(unsigned char *output, uint32_t number) {
  for (unsigned int i = 0; i < 4U; ++i)
    output[i] = (unsigned char)(number >> (i * 8U));
}
static napi_value edit_gpt(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  struct disk_session *s = arguments(env, info, 4, argv);
  if (!s)
    return NULL;
  if (s->mutation_failed)
    return failure(env, "GPT session requires explicit recovery", -EUCLEAN);
  struct edit_context context = {.session = s};
  unsigned char before_digest[32], encoded[24];
  if (exact(env, argv[0], context.binding, 32U) ||
      exact(env, argv[1], context.original_digest, 32U) ||
      exact(env, argv[2], before_digest, 32U) ||
      exact(env, argv[3], encoded, sizeof(encoded)))
    return failure(env, "Invalid GPT edit binding", -EINVAL);
  const struct elizaos_gpt_edit edit = {.kind = le32(encoded),
                                        .role = le32(encoded + 4),
                                        .start_bytes = le64(encoded + 8),
                                        .end_bytes = le64(encoded + 16)};
  unsigned char *artifact = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  context.scratch = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  if (!artifact || !context.scratch) {
    free(artifact);
    free(context.scratch);
    return failure(env, "Allocate GPT edit buffers", -ENOMEM);
  }
  size_t length = 0, check_length = 0;
  unsigned char current[32], after[32];
  uint32_t partition_index = 0;
  struct elizaos_gpt_restore_result written = {0};
  struct elizaos_gpt_map_result mapped = {0};
  const struct elizaos_gpt_restore_control control = {.context = &context,
                                                      .check = edit_guard};
  int rc = edit_guard(&context);
  if (!rc)
    rc = elizaos_install_capture_gpt(s->target, &s->target_id, context.binding,
                                     artifact, ELIZAOS_GPT_SNAPSHOT_MAX,
                                     &length, current);
  if (!rc && CRYPTO_memcmp(current, before_digest, 32U))
    rc = -ESTALE;
  if (!rc)
    rc = elizaos_install_prepare_gpt_edit(artifact, length, context.binding,
                                          before_digest, &edit, after,
                                          &partition_index);
  if (!rc)
    rc = elizaos_install_capture_gpt(s->target, &s->target_id, context.binding,
                                     context.scratch, ELIZAOS_GPT_SNAPSHOT_MAX,
                                     &check_length, current);
  if (!rc &&
      (check_length != length || CRYPTO_memcmp(current, before_digest, 32U)))
    rc = -ESTALE;
  if (!rc)
    rc = elizaos_install_restore_gpt(s->target, &s->target_id, context.binding,
                                     artifact, length, after, &control,
                                     &written);
  /* The metadata writer fsyncs first; discard cached blocks before the exact
   * snapshot and kernel-map readback that qualify this edit. */
  if (!rc && ioctl(s->target, BLKFLSBUF) != 0)
    rc = -errno;
  if (!rc)
    rc = elizaos_install_refresh_gpt_map(s->target, &s->target_id,
                                         context.binding, artifact, length,
                                         after, &control, &mapped);
  free(artifact);
  free(context.scratch);
  if (rc) {
    if (written.write_attempted)
      s->mutation_failed = true;
    char operation[160];
    snprintf(operation, sizeof(operation),
             "GPT edit failed (write attempted=%d, bytes=%llu, map "
             "verified=%d); retain backup and target lock",
             written.write_attempted, (unsigned long long)written.bytes_written,
             mapped.verified);
    return failure(env, operation, rc);
  }
  unsigned char receipt[48];
  memcpy(receipt, after, 32U);
  encode64(receipt + 32, written.bytes_written);
  encode32(receipt + 40, partition_index);
  encode32(receipt + 44, mapped.partitions);
  napi_value result;
  if (napi_create_buffer_copy(env, sizeof(receipt), receipt, NULL, &result) !=
      napi_ok) {
    s->mutation_failed = true;
    return failure(
        env, "GPT changed but receipt allocation failed; retain target lock",
        -ENOMEM);
  }
  return result;
}
struct image_work {
  struct edit_context guard;
  unsigned char current_digest[32], image_digest[32];
  uint32_t partition_index;
  uint64_t image_size, expires_at;
  char name[69];
  struct stat source;
  int file, error;
  struct elizaos_partition_image_result result;
  napi_async_work work;
  napi_ref receiver;
  napi_deferred deferred;
};
static int image_guard(void *context) {
  struct image_work *image = context;
  struct disk_session *s = image->guard.session;
  if (atomic_load(&s->cancel_requested))
    return -ECANCELED;
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0)
    return -errno;
  if (now.tv_sec < 0 ||
      (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U >=
          image->expires_at)
    return -EKEYEXPIRED;
  int rc = edit_guard(&image->guard);
  if (rc)
    return rc;
  struct stat named;
  if (fstatat(s->directory, image->name, &named, AT_SYMLINK_NOFOLLOW) != 0)
    return -errno;
  if (named.st_dev != image->source.st_dev ||
      named.st_ino != image->source.st_ino ||
      (uint64_t)named.st_dev != s->directory_id.filesystem_device)
    return -ESTALE;
  size_t length = 0;
  unsigned char digest[32];
  rc = elizaos_install_capture_gpt(s->target, &s->target_id,
                                   image->guard.binding, image->guard.scratch,
                                   ELIZAOS_GPT_SNAPSHOT_MAX, &length, digest);
  if (!rc && CRYPTO_memcmp(digest, image->current_digest, 32U))
    rc = -ESTALE;
  return rc;
}
static void image_execute(napi_env env, void *data) {
  (void)env;
  struct image_work *image = data;
  struct disk_session *s = image->guard.session;
  int rc = guard(s);
  if (rc) {
    image->error = rc;
    return;
  }
  image->file = openat(s->directory, image->name,
                       O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (image->file < 0) {
    image->error = -errno;
    return;
  }
  if (fstat(image->file, &image->source) != 0) {
    rc = -errno;
    goto finish_image;
  }
  if (!S_ISREG(image->source.st_mode) || image->source.st_size < 0 ||
      (uint64_t)image->source.st_size != image->image_size) {
    rc = -EINVAL;
    goto finish_image;
  }
  image->guard.scratch = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  unsigned char *snapshot = malloc(ELIZAOS_GPT_SNAPSHOT_MAX);
  if (!image->guard.scratch || !snapshot) {
    rc = -ENOMEM;
    free(snapshot);
    goto finish_image;
  }
  size_t length = 0;
  unsigned char digest[32];
  rc = image_guard(image);
  if (!rc)
    rc = elizaos_install_capture_gpt(s->target, &s->target_id,
                                     image->guard.binding, snapshot,
                                     ELIZAOS_GPT_SNAPSHOT_MAX, &length, digest);
  if (!rc && CRYPTO_memcmp(digest, image->current_digest, 32U))
    rc = -ESTALE;
  const struct elizaos_gpt_restore_control control = {.context = image,
                                                      .check = image_guard};
  if (!rc)
    rc = elizaos_install_write_partition_image(
        s->target, &s->target_id, snapshot, length, image->guard.binding,
        image->current_digest, image->partition_index, image->file,
        image->image_digest, &control, &image->result);
  if (!rc)
    rc = image_guard(image);
  free(snapshot);
finish_image:
  free(image->guard.scratch);
  image->guard.scratch = NULL;
  if (close(image->file) != 0 && !rc)
    rc = -errno;
  image->file = -1;
  image->error = rc;
}
static void image_complete(napi_env env, napi_status status, void *data) {
  struct image_work *image = data;
  struct disk_session *s = image->guard.session;
  s->busy = false;
  if (status != napi_ok && !image->error)
    image->error = -EIO;
  napi_value value;
  if (!image->error) {
    unsigned char receipt[40];
    memcpy(receipt, image->image_digest, 32U);
    encode64(receipt + 32, image->result.bytes_written);
    if (napi_create_buffer_copy(env, sizeof(receipt), receipt, NULL, &value) !=
        napi_ok)
      image->error = -ENOMEM;
  }
  napi_status settled;
  if (image->error) {
    if (image->result.write_attempted)
      s->mutation_failed = true;
    char message[256];
    snprintf(message, sizeof(message),
             "Partition image failed: %s (%d), write attempted=%d bytes=%llu "
             "verified=%d settle error=%d; retain backup and target lock",
             strerror(-image->error), -image->error,
             image->result.write_attempted,
             (unsigned long long)image->result.bytes_written,
             image->result.verified, image->result.settle_error);
    napi_value code, detail;
    if (napi_create_string_utf8(env, "ELIZAOS_INSTALL_DISK_ERROR",
                                sizeof("ELIZAOS_INSTALL_DISK_ERROR") - 1U,
                                &code) != napi_ok ||
        napi_create_string_utf8(env, message, strlen(message), &detail) !=
            napi_ok ||
        napi_create_error(env, code, detail, &value) != napi_ok) {
      napi_fatal_error("installer", 9U,
                       "Unable to report partition image failure",
                       sizeof("Unable to report partition image failure") - 1U);
      abort();
    }
    settled = napi_reject_deferred(env, image->deferred, value);
  } else
    settled = napi_resolve_deferred(env, image->deferred, value);
  napi_delete_reference(env, image->receiver);
  napi_delete_async_work(env, image->work);
  free(image);
  if (settled != napi_ok) {
    napi_fatal_error("installer", 9U,
                     "Unable to settle partition image operation",
                     sizeof("Unable to settle partition image operation") - 1U);
    abort();
  }
}
static napi_value write_image(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  struct disk_session *s = arguments(env, info, 4, argv);
  if (!s)
    return NULL;
  if (s->mutation_failed)
    return failure(env, "Disk session requires explicit recovery", -EUCLEAN);
  unsigned char encoded[56];
  struct image_work *image = calloc(1, sizeof(*image));
  if (!image)
    return failure(env, "Allocate image operation", -ENOMEM);
  image->guard.session = s;
  image->file = -1;
  if (exact(env, argv[0], image->guard.binding, 32U) ||
      exact(env, argv[1], image->guard.original_digest, 32U) ||
      exact(env, argv[2], image->current_digest, 32U) ||
      exact(env, argv[3], encoded, sizeof(encoded)) ||
      le32(encoded + 4) != 0U) {
    free(image);
    return failure(env, "Invalid partition image binding", -EINVAL);
  }
  image->partition_index = le32(encoded);
  image->image_size = le64(encoded + 8);
  image->expires_at = le64(encoded + 16);
  memcpy(image->image_digest, encoded + 24, 32U);
  if (!image->partition_index || image->partition_index > 4096U ||
      !image->image_size || image->image_size > s->target_id.size_bytes ||
      !image->expires_at || image->expires_at > UINT64_C(8640000000000000)) {
    free(image);
    return failure(env, "Invalid partition image geometry or deadline",
                   -EINVAL);
  }
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 32U; ++i) {
    image->name[2U * i] = hex[image->image_digest[i] >> 4U];
    image->name[2U * i + 1U] = hex[image->image_digest[i] & 15U];
  }
  memcpy(image->name + 64, ".img", 5U);
  napi_value self, name, promise;
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok ||
      napi_create_string_utf8(env, "installer-partition-image", 25U, &name) !=
          napi_ok ||
      napi_create_reference(env, self, 1U, &image->receiver) != napi_ok ||
      napi_create_async_work(env, NULL, name, image_execute, image_complete,
                             image, &image->work) != napi_ok ||
      napi_create_promise(env, &image->deferred, &promise) != napi_ok) {
    if (image->receiver)
      napi_delete_reference(env, image->receiver);
    if (image->work)
      napi_delete_async_work(env, image->work);
    free(image);
    return failure(env, "Queue partition image operation", -ENOMEM);
  }
  atomic_store(&s->cancel_requested, false);
  s->busy = true;
  if (napi_queue_async_work(env, image->work) != napi_ok) {
    image->error = -EIO;
    image_complete(env, napi_ok, image);
  }
  return promise;
}
static napi_value cancel_image(napi_env env, napi_callback_info info) {
  struct disk_session *s = arguments_any(env, info, 0, NULL, true);
  if (!s)
    return NULL;
  atomic_store(&s->cancel_requested, true);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value open_session(napi_env env, napi_callback_info info) {
  napi_value argv[6];
  size_t argc = 0;
  if (geteuid() != 0)
    return failure(env, "Installer disk session requires root", -EACCES);
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok ||
      argc != 6 ||
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok)
    return failure(env, "Invalid installer disk session arguments", -EINVAL);
  struct disk_session *s = calloc(1, sizeof(*s));
  if (!s)
    return failure(env, "Allocate installer disk session", -ENOMEM);
  s->target = s->storage = s->partition = s->directory = -1;
  atomic_init(&s->cancel_requested, false);
  char target[PATH_MAX], storage[PATH_MAX], partition[PATH_MAX];
  int rc = -EINVAL;
  if (path_value(env, argv[0], target) ||
      identity(env, argv[1], &s->target_id) ||
      path_value(env, argv[2], storage) ||
      identity(env, argv[3], &s->storage_id) ||
      path_value(env, argv[4], partition) ||
      path_value(env, argv[5], s->directory_path))
    goto fail;
  if (strncmp(target, "/dev/", 5) || strncmp(storage, "/dev/", 5) ||
      strncmp(partition, "/dev/", 5))
    goto fail;
  s->target = open(target, O_RDWR | O_EXCL | O_NOFOLLOW | O_CLOEXEC);
  if (s->target < 0) {
    rc = -errno;
    goto fail;
  }
  s->storage = open(storage, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (s->storage < 0) {
    rc = -errno;
    goto fail;
  }
  s->partition = open(partition, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (s->partition < 0) {
    rc = -errno;
    goto fail;
  }
  s->directory =
      open(s->directory_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (s->directory < 0) {
    rc = -errno;
    goto fail;
  }
  struct stat metadata;
  if (fstat(s->directory, &metadata)) {
    rc = -errno;
    goto fail;
  }
  s->directory_id = (struct elizaos_gpt_store_identity){
      .filesystem_device = (uint64_t)metadata.st_dev,
      .directory_inode = (uint64_t)metadata.st_ino};
  if ((rc = guard(s)))
    goto fail;
  napi_value result;
  const napi_property_descriptor methods[] = {
      {.utf8name = "check", .method = check, .attributes = napi_default},
      {.utf8name = "backup", .method = backup, .attributes = napi_default},
      {.utf8name = "verify", .method = verify, .attributes = napi_default},
      {.utf8name = "editGpt", .method = edit_gpt, .attributes = napi_default},
      {.utf8name = "writeImage",
       .method = write_image,
       .attributes = napi_default},
      {.utf8name = "cancelImageWrite",
       .method = cancel_image,
       .attributes = napi_default},
      {.utf8name = "close",
       .method = close_session,
       .attributes = napi_default},
  };
  rc = -ENOMEM;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &session_tag) != napi_ok ||
      napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]),
                             methods) != napi_ok ||
      napi_wrap(env, result, s, finalize, NULL, NULL) != napi_ok)
    goto fail;
  return result;
fail:
  finalize(env, s, NULL);
  return failure(env, "Open retained installer disk session", rc);
}

int elizaos_register_disk_session(napi_env env, napi_value exports) {
  const napi_property_descriptor method = {.utf8name = "openDiskSession",
                                           .method = open_session,
                                           .attributes = napi_default};
  return napi_define_properties(env, exports, 1, &method) == napi_ok ? 0
                                                                     : -ENOMEM;
}
