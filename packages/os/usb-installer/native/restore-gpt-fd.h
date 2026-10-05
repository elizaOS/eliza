#ifndef ELIZAOS_RESTORE_GPT_FD_H
#define ELIZAOS_RESTORE_GPT_FD_H

#include <stdint.h>

struct elizaos_restore_identity {
  uint32_t major;
  uint32_t minor;
  uint64_t diskseq;
  uint64_t size_bytes;
};

/* Internal mutation primitive, not an authorization or device-opening API.
 * The caller must hold its exclusively opened, authorized whole-device FD and
 * durable single-use target lock for the entire call. No pathname is accepted.
 * This module is not linked into the shipped (disabled) restore helper yet.
 * Returns 0 on verified success, negative errno on failure. A failed create
 * may have partially written the target and always requires recovery. */
int elizaos_restore_create_gpt(int fd,
                             const struct elizaos_restore_identity *expected);
int elizaos_restore_verify_gpt(int fd,
                             const struct elizaos_restore_identity *expected);

#endif
