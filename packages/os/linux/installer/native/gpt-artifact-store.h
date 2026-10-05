#ifndef ELIZAOS_GPT_ARTIFACT_STORE_H
#define ELIZAOS_GPT_ARTIFACT_STORE_H
#include "gpt-snapshot.h"

struct elizaos_gpt_store_identity {
  uint64_t filesystem_device;
  uint64_t directory_inode;
};
enum elizaos_gpt_store_step {
  ELIZAOS_GPT_STORE_CREATED = 0,
  ELIZAOS_GPT_STORE_WRITTEN = 1,
  ELIZAOS_GPT_STORE_FILE_SYNCED = 2,
  ELIZAOS_GPT_STORE_DIRECTORY_SYNCED = 3,
  ELIZAOS_GPT_STORE_VERIFIED = 4
};
struct elizaos_gpt_store_control {
  void *context;
  int (*check)(void *context);
  void (*progress)(void *context, enum elizaos_gpt_store_step step);
};
struct elizaos_gpt_store_result {
  int error;
  int create_attempted;
  int created;
  int file_synced;
  int directory_synced;
  int verified;
  uint64_t bytes_written;
};

/* Read-only kernel backing check. Bind the private recovery directory to the
 * retained partition, its direct whole-disk parent, and a distinct target disk.
 * Reject stacked/virtual backing without a direct device and empty slave list.
 * All expected identities come from trusted inventory, never request IPC.
 * Caller retains descriptors/locks and repeats this check at operation boundaries.
 * This is not a physical alias detector: trusted policy must additionally exclude
 * multipath aliases, verify hardware identity and qualify durable recovery media,
 * configured pathname, authorization and mount lifetime. Not installed. */
int elizaos_install_check_recovery_storage(int directory,
    const struct elizaos_gpt_store_identity *expected_directory,
    int partition, int storage,
    const struct elizaos_install_disk_identity *expected_storage,
    int target, const struct elizaos_install_disk_identity *expected_target);

/* Internal filesystem primitive, not installed and not a storage/authorization
 * policy. Caller must prove that the retained directory is on qualified durable
 * recovery storage independent of the physical target, bind its configured
 * location to this identity, and retain the target/storage locks throughout.
 * Required trusted check repeats authorization, cancellation, physical storage
 * identity and location checks; never pass caller IPC as that authority.
 * The primitive requires a root-owned 0700 directory on an ext-family filesystem.
 * Children are named only by the trusted digest, created exclusively as 0600
 * regular files, and never replaced or deleted, including on failure.
 * Interrupted files require explicit recovery; a failed creation attempt is not
 * proof that no artifact exists. Successful storage does not commit a journal,
 * authenticate a recovery request, or prove hardware power-loss safety. */
int elizaos_install_store_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_store_control *control,
    struct elizaos_gpt_store_result *result);

/* Reopen only the digest-derived name, reject unsafe/replaced/truncated files,
 * verify the exact snapshot, then fsync that file and directory again. Output
 * length is usable only on success. Same trusted policy/locks as the writer. */
int elizaos_install_read_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char digest[32],
    const struct elizaos_gpt_store_control *control,
    unsigned char *output, size_t capacity, size_t *length);
#endif
