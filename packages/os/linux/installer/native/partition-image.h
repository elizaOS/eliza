#ifndef ELIZAOS_PARTITION_IMAGE_H
#define ELIZAOS_PARTITION_IMAGE_H
#include "gpt-snapshot.h"

struct elizaos_partition_image_result {
  int error, write_attempted, synced, verified, settle_error;
  uint64_t bytes_written;
};
/* Retained-descriptor image copy. Source must be a root-owned 0600 regular file
 * exactly the size of the selected partition, with the expected SHA-256. The
 * trusted caller retains its independent storage and target claims, verifies
 * source pathname/inode, original backup, current GPT, authorization expiry and
 * cancellation through control->check. Hash before writing, hash copied bytes,
 * fsync/discard target cache, then hash readback. Failure may leave a partial
 * filesystem; callers retain their journal/target lock until explicit recovery.
 * This does not validate a filesystem, install a bootloader or issue an action
 * completion receipt. It is not a pathname or request-authorization API. */
int elizaos_install_write_partition_image(
    int target, const struct elizaos_install_disk_identity *identity,
    const unsigned char *snapshot, size_t snapshot_length,
    const unsigned char binding[32], const unsigned char snapshot_digest[32],
    uint32_t partition_index, int image, const unsigned char image_digest[32],
    const struct elizaos_gpt_restore_control *control,
    struct elizaos_partition_image_result *result);
#endif
