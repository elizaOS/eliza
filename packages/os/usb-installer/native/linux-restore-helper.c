#define _GNU_SOURCE

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef BLKGETDISKSEQ
#define BLKGETDISKSEQ _IOR(0x12, 128, uint64_t)
#endif

#define REQUEST_MAX_BYTES 2048U
#define RESPONSE_MAX_MESSAGE 256U
#define PLAN_ID_BYTES 32U
#define BOOT_ID_BYTES 36U
#define DEVICE_PATH_BYTES 128U
#define MAX_AUTHORIZATION_NS UINT64_C(300000000000)
#define STATE_ROOT "/run/elizaos-usb-restore"

/* This binary is an identity-retention gate, not a mutation implementation. */

struct request {
  char plan_id[PLAN_ID_BYTES + 1U];
  char plan_binding[65U];
  char boot_id[BOOT_ID_BYTES + 1U];
  char device_path[DEVICE_PATH_BYTES];
  uint64_t expected_major;
  uint64_t expected_minor;
  uint64_t expected_diskseq;
  uint64_t expected_size_bytes;
  uint64_t authorized_from_ns;
  uint64_t authorized_until_ns; /* Trusted file only, never parsed from request. */
};

struct retained_authorization {
  int directory;
  int record;
};

struct sha256_context {
  uint8_t data[64];
  uint32_t data_length;
  uint64_t bit_length;
  uint32_t state[8];
};

static const uint32_t sha256_constants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU,
    0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U,
    0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U,
    0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U,
    0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
    0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
    0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U,
    0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U, 0x1e376c08U,
    0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU,
    0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

static uint32_t rotate_right(uint32_t value, uint32_t count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(struct sha256_context *context,
                             const uint8_t data[64]) {
  uint32_t words[64];
  for (uint32_t index = 0; index < 16U; ++index) {
    const uint32_t offset = index * 4U;
    words[index] = ((uint32_t)data[offset] << 24U) |
                   ((uint32_t)data[offset + 1U] << 16U) |
                   ((uint32_t)data[offset + 2U] << 8U) |
                   (uint32_t)data[offset + 3U];
  }
  for (uint32_t index = 16U; index < 64U; ++index) {
    const uint32_t s0 = rotate_right(words[index - 15U], 7U) ^
                        rotate_right(words[index - 15U], 18U) ^
                        (words[index - 15U] >> 3U);
    const uint32_t s1 = rotate_right(words[index - 2U], 17U) ^
                        rotate_right(words[index - 2U], 19U) ^
                        (words[index - 2U] >> 10U);
    words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
  }

  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (uint32_t index = 0; index < 64U; ++index) {
    const uint32_t choose = (e & f) ^ ((~e) & g);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t sigma0 = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^
                            rotate_right(a, 22U);
    const uint32_t sigma1 = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^
                            rotate_right(e, 25U);
    const uint32_t temporary1 =
        h + sigma1 + choose + sha256_constants[index] + words[index];
    const uint32_t temporary2 = sigma0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary1;
    d = c;
    c = b;
    b = a;
    a = temporary1 + temporary2;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_init(struct sha256_context *context) {
  memset(context, 0, sizeof(*context));
  context->state[0] = 0x6a09e667U;
  context->state[1] = 0xbb67ae85U;
  context->state[2] = 0x3c6ef372U;
  context->state[3] = 0xa54ff53aU;
  context->state[4] = 0x510e527fU;
  context->state[5] = 0x9b05688cU;
  context->state[6] = 0x1f83d9abU;
  context->state[7] = 0x5be0cd19U;
}

static void sha256_update(struct sha256_context *context, const uint8_t *data,
                          size_t length) {
  for (size_t index = 0; index < length; ++index) {
    context->data[context->data_length++] = data[index];
    if (context->data_length == 64U) {
      sha256_transform(context, context->data);
      context->bit_length += 512U;
      context->data_length = 0U;
    }
  }
}

static void sha256_final(struct sha256_context *context, uint8_t hash[32]) {
  uint32_t index = context->data_length;
  context->data[index++] = 0x80U;
  if (index > 56U) {
    while (index < 64U) context->data[index++] = 0U;
    sha256_transform(context, context->data);
    index = 0U;
  }
  while (index < 56U) context->data[index++] = 0U;
  context->bit_length += (uint64_t)context->data_length * 8U;
  for (uint32_t shift = 0; shift < 8U; ++shift) {
    context->data[63U - shift] =
        (uint8_t)(context->bit_length >> (shift * 8U));
  }
  sha256_transform(context, context->data);
  for (index = 0U; index < 4U; ++index) {
    for (uint32_t word = 0U; word < 8U; ++word) {
      hash[index + word * 4U] =
          (uint8_t)(context->state[word] >> (24U - index * 8U));
    }
  }
}

static int emit_result(const char *status, const char *code,
                       const char *message, int exit_code) {
  (void)dprintf(STDOUT_FILENO,
                "ELIZAOS_USB_RESTORE_RESULT_V1\nstatus=%s\ncode=%s\n"
                "message=%s\nEND\n",
                status, code, message);
  return exit_code;
}

static bool parse_uint64(const char *value, bool allow_zero, uint64_t *output) {
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) return false;
  uint64_t result = 0U;
  for (const unsigned char *cursor = (const unsigned char *)value;
       *cursor != '\0'; ++cursor) {
    if (!isdigit(*cursor)) return false;
    const uint8_t digit = (uint8_t)(*cursor - (unsigned char)'0');
    if (result > (UINT64_MAX - digit) / 10U) return false;
    result = result * 10U + digit;
  }
  if (!allow_zero && result == 0U) return false;
  *output = result;
  return true;
}

static bool is_lower_hex(const char *value, size_t length) {
  if (strlen(value) != length) return false;
  for (size_t index = 0U; index < length; ++index) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool is_canonical_boot_id(const char *value) {
  if (strlen(value) != BOOT_ID_BYTES) return false;
  for (size_t index = 0U; index < BOOT_ID_BYTES; ++index) {
    if (index == 8U || index == 13U || index == 18U || index == 23U) {
      if (value[index] != '-') return false;
    } else if (!((value[index] >= '0' && value[index] <= '9') ||
                 (value[index] >= 'a' && value[index] <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool valid_device_path(const char *value) {
  static const char prefix[] = "/dev/";
  const size_t length = strlen(value);
  if (length <= sizeof(prefix) - 1U || length >= DEVICE_PATH_BYTES ||
      strncmp(value, prefix, sizeof(prefix) - 1U) != 0 ||
      !isalnum((unsigned char)value[sizeof(prefix) - 1U]) ||
      strstr(value, "..") != NULL) {
    return false;
  }
  for (size_t index = sizeof(prefix) - 1U; index < length; ++index) {
    const unsigned char byte = (unsigned char)value[index];
    if (!(isalnum(byte) || byte == '.' || byte == '_' || byte == '-')) {
      return false;
    }
  }
  return true;
}

static const char *field_value(const char *line, const char *key) {
  const size_t key_length = strlen(key);
  if (strncmp(line, key, key_length) != 0 || line[key_length] != '=') {
    return NULL;
  }
  return line + key_length + 1U;
}

static bool parse_request(char *wire, size_t wire_length, struct request *out) {
  if (wire_length == 0U || wire[wire_length - 1U] != '\n' ||
      memchr(wire, '\0', wire_length) != NULL) {
    return false;
  }
  wire[wire_length - 1U] = '\0';
  char *lines[15];
  size_t line_count = 0U;
  char *cursor = wire;
  while (cursor != NULL && line_count < 15U) {
    lines[line_count++] = strsep(&cursor, "\n");
  }
  if (cursor != NULL || line_count != 15U ||
      strcmp(lines[0], "ELIZAOS_USB_RESTORE_REQUEST_V1") != 0 ||
      strcmp(lines[1], "operation=restore") != 0 ||
      strcmp(lines[14], "END") != 0) {
    return false;
  }

  const char *plan_id = field_value(lines[2], "plan_id");
  const char *binding = field_value(lines[3], "plan_binding");
  const char *boot_id = field_value(lines[4], "boot_id");
  const char *device_path = field_value(lines[5], "device_path");
  const char *major_text = field_value(lines[6], "expected_major");
  const char *minor_text = field_value(lines[7], "expected_minor");
  const char *diskseq_text = field_value(lines[8], "expected_diskseq");
  const char *size_text = field_value(lines[9], "expected_size_bytes");
  if (plan_id == NULL || binding == NULL || boot_id == NULL ||
      device_path == NULL ||
      major_text == NULL || minor_text == NULL || diskseq_text == NULL ||
      size_text == NULL || strcmp(lines[10], "partition_number=1") != 0 ||
      strcmp(lines[11], "filesystem=exfat") != 0 ||
      strcmp(lines[12], "label=ELIZAOS-USB") != 0 ||
      strcmp(lines[13], "acknowledgement=ERASE") != 0 ||
      !is_lower_hex(plan_id, 32U) || !is_lower_hex(binding, 64U) ||
      !is_canonical_boot_id(boot_id) ||
      !valid_device_path(device_path) ||
      !parse_uint64(major_text, true, &out->expected_major) ||
      !parse_uint64(minor_text, true, &out->expected_minor) ||
      !parse_uint64(diskseq_text, false, &out->expected_diskseq) ||
      !parse_uint64(size_text, false, &out->expected_size_bytes)) {
    return false;
  }
  if (out->expected_major > UINT32_MAX || out->expected_minor > UINT32_MAX) {
    return false;
  }
  (void)snprintf(out->plan_id, sizeof(out->plan_id), "%s", plan_id);
  (void)snprintf(out->plan_binding, sizeof(out->plan_binding), "%s", binding);
  (void)snprintf(out->boot_id, sizeof(out->boot_id), "%s", boot_id);
  (void)snprintf(out->device_path, sizeof(out->device_path), "%s", device_path);

  char canonical[REQUEST_MAX_BYTES + 1U];
  const int canonical_length = snprintf(
      canonical, sizeof(canonical),
      "ELIZAOS_USB_RESTORE_REQUEST_V1\noperation=restore\nplan_id=%s\n"
      "boot_id=%s\ndevice_path=%s\nexpected_major=%s\nexpected_minor=%s\n"
      "expected_diskseq=%s\nexpected_size_bytes=%s\npartition_number=1\n"
      "filesystem=exfat\nlabel=ELIZAOS-USB\nacknowledgement=ERASE\nEND\n",
      plan_id, boot_id, device_path, major_text, minor_text, diskseq_text,
      size_text);
  if (canonical_length <= 0 || (size_t)canonical_length >= sizeof(canonical)) {
    return false;
  }
  struct sha256_context context;
  uint8_t digest[32];
  char digest_hex[65];
  sha256_init(&context);
  sha256_update(&context, (const uint8_t *)canonical,
                (size_t)canonical_length);
  sha256_final(&context, digest);
  for (size_t index = 0U; index < sizeof(digest); ++index) {
    (void)snprintf(&digest_hex[index * 2U], 3U, "%02x", digest[index]);
  }
  digest_hex[64] = '\0';
  return strcmp(digest_hex, binding) == 0;
}

static int read_request(char buffer[REQUEST_MAX_BYTES + 1U], size_t *length) {
  size_t used = 0U;
  while (used <= REQUEST_MAX_BYTES) {
    const ssize_t amount =
        read(STDIN_FILENO, buffer + used, REQUEST_MAX_BYTES + 1U - used);
    if (amount < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (amount == 0) break;
    used += (size_t)amount;
  }
  if (used == 0U || used > REQUEST_MAX_BYTES) return -1;
  buffer[used] = '\0';
  *length = used;
  return 0;
}

static bool trusted_state_directory(int descriptor) {
  struct stat metadata;
  return fstat(descriptor, &metadata) == 0 && S_ISDIR(metadata.st_mode) &&
         metadata.st_uid == 0U && (metadata.st_mode & 0022U) == 0U;
}

static bool trusted_authorization_file(int descriptor) {
  struct stat metadata;
  return fstat(descriptor, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
         metadata.st_uid == 0U && (metadata.st_mode & 0077U) == 0U &&
         metadata.st_nlink == 1U;
}

static bool request_matches_current_boot(const struct request *request) {
  const int descriptor =
      open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) return false;
  char value[BOOT_ID_BYTES + 2U];
  size_t used = 0U;
  while (used < sizeof(value)) {
    const ssize_t amount = read(descriptor, value + used, sizeof(value) - used);
    if (amount < 0) {
      if (errno == EINTR) continue;
      (void)close(descriptor);
      return false;
    }
    if (amount == 0) break;
    used += (size_t)amount;
  }
  (void)close(descriptor);
  return used == BOOT_ID_BYTES + 1U && value[BOOT_ID_BYTES] == '\n' &&
         memcmp(value, request->boot_id, BOOT_ID_BYTES) == 0;
}

static int authorization_clock_status(const struct request *request) {
  struct timespec now;
  if (clock_gettime(CLOCK_BOOTTIME, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0 || now.tv_nsec >= 1000000000L) return -EIO;
  const uint64_t seconds = (uint64_t)now.tv_sec;
  const uint64_t nanos = (uint64_t)now.tv_nsec;
  if (seconds > (UINT64_MAX - nanos) / UINT64_C(1000000000)) return -EIO;
  const uint64_t elapsed = seconds * UINT64_C(1000000000) + nanos;
  if (request->authorized_from_ns > elapsed || request->authorized_until_ns <= elapsed ||
      request->authorized_until_ns <= request->authorized_from_ns ||
      request->authorized_until_ns - request->authorized_from_ns > MAX_AUTHORIZATION_NS)
    return -EKEYEXPIRED;
  return 0;
}

static bool read_authorization(int descriptor, struct request *request) {
  static const char prefix[] = "ELIZAOS_RESTORE_AUTHORIZATION_V1\n";
  const size_t prefix_length = sizeof(prefix) - 1U;
  const size_t deadline_offset = prefix_length + 65U;
  char value[160];
  size_t used = 0U;
  while (used < sizeof(value)) {
    const ssize_t amount = pread(descriptor, value + used, sizeof(value) - used, (off_t)used);
    if (amount < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (amount == 0) break;
    used += (size_t)amount;
  }
  if (used < deadline_offset + 2U || used == sizeof(value) ||
      memchr(value, '\0', used) != NULL || value[used - 1U] != '\n' ||
      memcmp(value, prefix, prefix_length) != 0 ||
      memcmp(value + prefix_length, request->plan_binding, 64U) != 0 ||
      value[deadline_offset - 1U] != '\n') return false;
  value[used - 1U] = '\0';
  char *separator = strchr(value + deadline_offset, '\n');
  if (separator == NULL) return false;
  *separator = '\0';
  return parse_uint64(value + deadline_offset, false, &request->authorized_from_ns) &&
         parse_uint64(separator + 1, false, &request->authorized_until_ns);
}

/* Retain the original inode so replacement cannot become a renewed grant.
 * The broker withdraws authorization by unlinking its exact record. These
 * checks sample revocation between operations; they never interrupt a write. */
static int authorization_status(const struct request *request,
                                 const struct retained_authorization *grant) {
  const int clock_status = authorization_clock_status(request);
  if (clock_status != 0) return clock_status;
  struct stat held, named;
  struct request current = *request;
  if (!trusted_state_directory(grant->directory) ||
      !trusted_authorization_file(grant->record) ||
      fstat(grant->record, &held) != 0 ||
      fstatat(grant->directory, request->plan_id, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(named.st_mode) || held.st_dev != named.st_dev || held.st_ino != named.st_ino ||
      !read_authorization(grant->record, &current) ||
      current.authorized_from_ns != request->authorized_from_ns ||
      current.authorized_until_ns != request->authorized_until_ns ||
      !trusted_authorization_file(grant->record)) return -EKEYREVOKED;
  return 0;
}

static int close_authorization(struct retained_authorization *grant) {
  const int record = close(grant->record);
  const int directory = close(grant->directory);
  grant->record = -1;
  grant->directory = -1;
  return record == 0 && directory == 0 ? 0 : -1;
}

/*
 * A caller-controlled digest is not authorization. A separate privileged
 * broker must place the exact binding in authorized/<plan-id> as a root-owned,
 * mode-0600, single-link regular file. This helper intentionally ships with no
 * broker or policy entry, so ordinary callers cannot authorize mutation.
 */
static int validate_authorized_plan(struct request *request,
                                    int *consumed_directory,
                                    struct retained_authorization *grant) {
  *consumed_directory = -1;
  grant->directory = -1;
  grant->record = -1;
  const int root = open(STATE_ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root < 0 || !trusted_state_directory(root)) {
    if (root >= 0) (void)close(root);
    return -1;
  }
  const int authorized =
      openat(root, "authorized", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (authorized < 0 || !trusted_state_directory(authorized)) {
    if (authorized >= 0) (void)close(authorized);
    (void)close(root);
    return -1;
  }
  const int consumed =
      openat(root, "consumed", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (consumed < 0 || !trusted_state_directory(consumed)) {
    if (consumed >= 0) (void)close(consumed);
    (void)close(authorized);
    (void)close(root);
    return -1;
  }

  /* Reject special files after opening without waiting for a FIFO writer or
   * device readiness. Regular-file reads are unaffected by O_NONBLOCK. */
  const int authorization = openat(authorized, request->plan_id,
                                   O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (authorization < 0 || !trusted_authorization_file(authorization) ||
      !read_authorization(authorization, request)) {
    if (authorization >= 0) (void)close(authorization);
    (void)close(consumed);
    (void)close(authorized);
    (void)close(root);
    return -2;
  }
  if (authorization_clock_status(request) != 0) {
    (void)close(authorization);
    (void)close(consumed);
    (void)close(authorized);
    (void)close(root);
    return -3;
  }

  struct stat marker_metadata;
  if (fstatat(consumed, request->plan_id, &marker_metadata,
              AT_SYMLINK_NOFOLLOW) == 0) {
    (void)close(authorization);
    (void)close(consumed);
    (void)close(authorized);
    (void)close(root);
    return 1;
  }
  if (errno != ENOENT) {
    (void)close(authorization);
    (void)close(consumed);
    (void)close(authorized);
    (void)close(root);
    return -1;
  }

  (void)close(root);
  grant->record = authorization;
  grant->directory = authorized;
  *consumed_directory = consumed;
  return 0;
}

/*
 * A future mutation implementation must call this exactly once, immediately
 * before its first destructive operation, while retaining both the verified
 * whole-device FD and the trusted directory FD returned above. The currently
 * disabled helper deliberately never consumes a plan.
 */
static int consume_authorized_plan(const struct request *request,
                                   int consumed_directory,
                                   const struct retained_authorization *grant) {
  const int authorization = authorization_status(request, grant);
  if (authorization != 0) { errno = -authorization; return -1; }
  const int marker = openat(consumed_directory, request->plan_id,
                            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                            0600);
  const int saved_errno = errno;
  if (marker >= 0) {
    static const char marker_body[] = "consumed\n";
    if (write(marker, marker_body, sizeof(marker_body) - 1U) !=
            (ssize_t)(sizeof(marker_body) - 1U) ||
        fsync(marker) != 0) {
      (void)close(marker);
      (void)unlinkat(consumed_directory, request->plan_id, 0);
      (void)fsync(consumed_directory);
      return -1;
    }
    /* Once the marker itself is durable, any uncertainty must remain
     * fail-closed. Do not unlink it when close or directory fsync fails. */
    if (close(marker) != 0 || fsync(consumed_directory) != 0) return -1;
  }
  if (marker < 0) {
    errno = saved_errno;
    return errno == EEXIST ? 1 : -1;
  }
  return 0;
}

static bool read_sysfs_value_at(int directory, const char *name, char *buffer,
                                size_t capacity, size_t *length) {
  if (capacity < 2U) return false;
  const int file = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) return false;
  size_t used = 0U;
  while (used < capacity) {
    const ssize_t amount = read(file, buffer + used, capacity - used);
    if (amount < 0) {
      if (errno == EINTR) continue;
      (void)close(file);
      return false;
    }
    if (amount == 0) break;
    used += (size_t)amount;
  }
  (void)close(file);
  if (used == 0U || used == capacity) return false;
  buffer[used] = '\0';
  *length = used;
  return true;
}

static bool sysfs_directory_has_dev(int directory, dev_t expected) {
  char actual[64];
  size_t actual_length = 0U;
  char wanted[64];
  const int wanted_length = snprintf(wanted, sizeof(wanted), "%u:%u\n",
                                     major(expected), minor(expected));
  return wanted_length > 0 && (size_t)wanted_length < sizeof(wanted) &&
         read_sysfs_value_at(directory, "dev", actual, sizeof(actual),
                             &actual_length) &&
         actual_length == (size_t)wanted_length &&
         memcmp(actual, wanted, actual_length) == 0;
}

static int open_sysfs_block_directory(dev_t device) {
  char path[96];
  const int length = snprintf(path, sizeof(path), "/sys/dev/block/%u:%u",
                              major(device), minor(device));
  if (length <= 0 || (size_t)length >= sizeof(path)) return -1;

  /* /sys/dev/block entries are kernel-owned symlinks. Follow the selected link
   * once, then anchor every subsequent lookup to the held directory FD. */
  const int directory = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0 || !sysfs_directory_has_dev(directory, device)) {
    if (directory >= 0) (void)close(directory);
    return -1;
  }
  return directory;
}

static bool validate_whole_device_fd(int descriptor,
                                     const struct request *request) {
  struct stat metadata;
  uint64_t size_bytes = 0U;
  uint64_t diskseq = 0U;
  if (fstat(descriptor, &metadata) != 0 || !S_ISBLK(metadata.st_mode) ||
      (uint64_t)major(metadata.st_rdev) != request->expected_major ||
      (uint64_t)minor(metadata.st_rdev) != request->expected_minor ||
      ioctl(descriptor, BLKGETSIZE64, &size_bytes) != 0 ||
      ioctl(descriptor, BLKGETDISKSEQ, &diskseq) != 0 ||
      size_bytes != request->expected_size_bytes ||
      diskseq != request->expected_diskseq) {
    return false;
  }

  const int sysfs = open_sysfs_block_directory(metadata.st_rdev);
  if (sysfs < 0) return false;
  const int partition = openat(sysfs, "partition", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  const int partition_errno = errno;
  if (partition >= 0) (void)close(partition);
  char removable[4];
  size_t removable_length = 0U;
  const bool valid = partition < 0 && partition_errno == ENOENT &&
                     read_sysfs_value_at(sysfs, "removable", removable,
                                         sizeof(removable), &removable_length) &&
                     removable_length == 2U && removable[0] == '1' &&
                     removable[1] == '\n';
  (void)close(sysfs);
  return valid;
}

static bool read_sysfs_uint64_at(int directory, const char *name,
                                 uint64_t *value) {
  char text[32];
  size_t length = 0U;
  if (!read_sysfs_value_at(directory, name, text, sizeof(text), &length) ||
      length < 2U || text[length - 1U] != '\n') return false;
  text[length - 1U] = '\0';
  return parse_uint64(text, false, value);
}

/* The fixed restore GPT uses 128 entries of 128 bytes, a one-sector backup
 * header, and a partition from 1 MiB through its last usable sector. Kernel
 * partition state can differ from those disk bytes after a failed reread.
 * Require BOTH ioctl geometry and the kernel sysfs extent to match that layout
 * before returning any writable partition descriptor. This is not a substitute
 * for the separate raw primary/backup GPT verifier. */
static bool validate_partition_geometry(int partition, int partition_sysfs,
                                         int whole, const struct request *request) {
  int whole_sector = 0;
  int partition_sector = 0;
  int read_only = 1;
  uint64_t size = 0U;
  uint64_t start_units = 0U;
  uint64_t size_units = 0U;
  const uint64_t start_bytes = 1024U * 1024U;
  const uint64_t array_bytes = 128U * 128U;
  if (ioctl(whole, BLKSSZGET, &whole_sector) != 0 ||
      (whole_sector != 512 && whole_sector != 4096) ||
      ioctl(partition, BLKSSZGET, &partition_sector) != 0 ||
      partition_sector != whole_sector ||
      ioctl(partition, BLKROGET, &read_only) != 0 || read_only != 0 ||
      ioctl(partition, BLKGETSIZE64, &size) != 0 ||
      !read_sysfs_uint64_at(partition_sysfs, "start", &start_units) ||
      !read_sysfs_uint64_at(partition_sysfs, "size", &size_units)) return false;
  const uint64_t sector = (uint64_t)whole_sector;
  if (request->expected_size_bytes % sector != 0U ||
      request->expected_size_bytes <= start_bytes + array_bytes + sector)
    return false;
  const uint64_t expected_size =
      request->expected_size_bytes - start_bytes - array_bytes - sector;
  return size == expected_size && start_units == start_bytes / 512U &&
         size_units == expected_size / 512U;
}

static bool validate_partition_fd(const struct request *request,
                                   int whole_device_fd, int partition) {
  if (!validate_whole_device_fd(whole_device_fd, request)) return false;
  struct stat metadata;
  uint64_t diskseq = 0U;
  if (fstat(partition, &metadata) != 0 || !S_ISBLK(metadata.st_mode) ||
      ioctl(partition, BLKGETDISKSEQ, &diskseq) != 0 ||
      diskseq != request->expected_diskseq) {
    return false;
  }

  const int partition_sysfs = open_sysfs_block_directory(metadata.st_rdev);
  if (partition_sysfs < 0) {
    return false;
  }
  char partition_number[8];
  size_t partition_number_length = 0U;
  if (!read_sysfs_value_at(partition_sysfs, "partition", partition_number,
                           sizeof(partition_number),
                           &partition_number_length) ||
      partition_number_length != 2U || partition_number[0] != '1' ||
      partition_number[1] != '\n') {
    (void)close(partition_sysfs);
    return false;
  }
  if (!validate_partition_geometry(partition, partition_sysfs, whole_device_fd,
                                    request)) {
    (void)close(partition_sysfs);
    return false;
  }
  const int parent_sysfs =
      openat(partition_sysfs, "..", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  (void)close(partition_sysfs);
  if (parent_sysfs < 0) {
    return false;
  }
  struct stat whole_metadata;
  const bool parent_matches = fstat(whole_device_fd, &whole_metadata) == 0 &&
                              S_ISBLK(whole_metadata.st_mode) &&
                              sysfs_directory_has_dev(parent_sysfs,
                                                      whole_metadata.st_rdev);
  (void)close(parent_sysfs);
  if (!parent_matches || !validate_whole_device_fd(whole_device_fd, request)) {
    return false;
  }
  return true;
}

static int open_verified_partition(const struct request *request,
                                   int whole_device_fd) {
  if (!validate_whole_device_fd(whole_device_fd, request)) return -1;
  char partition_path[DEVICE_PATH_BYTES + 2U];
  const size_t device_length = strlen(request->device_path);
  const bool needs_p = isdigit((unsigned char)request->device_path[device_length - 1U]);
  const int length = snprintf(partition_path, sizeof(partition_path), "%s%s1",
                              request->device_path, needs_p ? "p" : "");
  if (length <= 0 || (size_t)length >= sizeof(partition_path)) return -1;

  /* Retain the whole-device O_EXCL claim; a second partition claim fails EBUSY. */
  const int partition = open(partition_path, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (partition < 0) return -1;
  if (!validate_partition_fd(request, whole_device_fd, partition)) {
    (void)close(partition);
    return -1;
  }
  return partition;
}

int main(int argc, char **argv) {
  if (argc != 1 || argv == NULL || argv[0] == NULL) {
    return emit_result("error", "INVALID_INVOCATION",
                       "The helper accepts one request on standard input.", 2);
  }
  char wire[REQUEST_MAX_BYTES + 1U];
  size_t wire_length = 0U;
  struct request request;
  memset(&request, 0, sizeof(request));
  if (read_request(wire, &wire_length) != 0 ||
      !parse_request(wire, wire_length, &request)) {
    return emit_result("error", "INVALID_REQUEST",
                       "The bounded canonical restore request is invalid.", 2);
  }
  if (!request_matches_current_boot(&request)) {
    return emit_result("blocked", "BOOT_ID_MISMATCH",
                       "The restore plan belongs to a different system boot.", 3);
  }
  if (geteuid() != 0U) {
    return emit_result("blocked", "PRIVILEGE_REQUIRED",
                       "The Linux Restore helper must run with effective UID zero.",
                       4);
  }
  int consumed_directory = -1;
  struct retained_authorization grant;
  const int authorized =
      validate_authorized_plan(&request, &consumed_directory, &grant);
  if (authorized == 1) {
    return emit_result("blocked", "PLAN_ALREADY_CONSUMED",
                       "The single-use restore plan was already consumed.", 5);
  }
  if (authorized == -3) {
    return emit_result("blocked", "PLAN_AUTHORIZATION_EXPIRED",
                       "The exact restore authorization is expired or not current.", 10);
  }
  if (authorized == -2) {
    return emit_result("blocked", "PLAN_NOT_AUTHORIZED",
                       "A trusted broker did not authorize this exact restore plan.",
                       6);
  }
  if (authorized != 0) {
    return emit_result("blocked", "STATE_UNAVAILABLE",
                       "Trusted root-owned single-use plan state is unavailable.",
                       7);
  }

  const int whole_device = open(request.device_path,
                                O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_EXCL);
  if (whole_device < 0 || !validate_whole_device_fd(whole_device, &request)) {
    if (whole_device >= 0) (void)close(whole_device);
    (void)close(consumed_directory);
    (void)close_authorization(&grant);
    return emit_result("blocked", "TARGET_IDENTITY_MISMATCH",
                       "The opened whole-device identity is not the authorized target.",
                       8);
  }

  /*
   * Deliberately no destructive subprocess exists in this binary. A future
   * implementation must pass only the retained descriptor as a fixed child FD,
   * address it as /proc/self/fd/<n>, use absolute executable paths and constant
   * argv/environment, revalidate around every step, then bind the new partition
   * with open_verified_partition(). Pathname probes by the server are never an
   * authorization input.
   */
  (void)consume_authorized_plan;
  (void)open_verified_partition;
  (void)close(whole_device);
  (void)close(consumed_directory);
  (void)close_authorization(&grant);
  return emit_result(
      "blocked", "NATIVE_FD_QUALIFICATION_REQUIRED",
      "Restore remains disabled until fixed native tools pass FD qualification.",
      9);
}
