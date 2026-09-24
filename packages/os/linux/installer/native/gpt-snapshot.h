#ifndef ELIZAOS_INSTALL_GPT_SNAPSHOT_H
#define ELIZAOS_INSTALL_GPT_SNAPSHOT_H
#include <stddef.h>
#include <stdint.h>

#define ELIZAOS_GPT_SNAPSHOT_MAX (128U + 3U * 4096U + 2U * 4194304U)
struct elizaos_install_disk_identity {
  uint32_t major;
  uint32_t minor;
  uint64_t diskseq;
  uint64_t size_bytes;
  uint32_t sector_bytes;
};

/* Read-only kernel identity check shared by the internal recovery primitives.
 * Requires a whole block descriptor with the expected dev_t, diskseq, size and
 * sector geometry and a matching live sysfs generation. This does not authorize
 * access or prove physical hardware identity, exclusivity or storage topology. */
int elizaos_install_check_whole_disk(int fd,
    const struct elizaos_install_disk_identity *expected);

/* Read-only internal primitive, not installed or an authorization API. Caller
 * authenticates the exact plan, excludes mounted/current-boot targets and holds
 * the exclusive whole-device claim throughout capture. binding is the trusted
 * original inventory/plan binding, not caller IPC. Output is not yet a durable
 * backup: the backend must store it on verified independent recovery media,
 * fsync file and directory, and retain its digest/identity in the journal.
 * Returns 0 or negative errno; output length is valid only on success. */
int elizaos_install_capture_gpt(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], unsigned char *output, size_t capacity,
    size_t *length, unsigned char digest[32]);

/* Verify exact artifact digest, binding, envelope and both raw GPT copies.
 * This does not verify the storage medium, target hardware, authorization,
 * filesystem payloads or successful persistence. No device is written. */
int elizaos_install_verify_gpt_snapshot(const unsigned char *data, size_t length,
    const unsigned char binding[32], const unsigned char digest[32]);

enum elizaos_gpt_restore_step {
  ELIZAOS_GPT_RESTORE_NOT_STARTED = -1,
  ELIZAOS_GPT_RESTORE_VALIDATED = 0,
  ELIZAOS_GPT_RESTORE_BACKUP_ARRAY_WRITTEN = 1,
  ELIZAOS_GPT_RESTORE_BACKUP_SYNCED = 2,
  ELIZAOS_GPT_RESTORE_PRIMARY_ARRAY_WRITTEN = 3,
  ELIZAOS_GPT_RESTORE_PRIMARY_HEADER_WRITTEN = 4,
  ELIZAOS_GPT_RESTORE_MBR_WRITTEN = 5,
  ELIZAOS_GPT_RESTORE_MEDIA_SYNCED = 6,
  ELIZAOS_GPT_RESTORE_VERIFIED = 7
};
struct elizaos_gpt_restore_result {
  int error;
  enum elizaos_gpt_restore_step last_completed;
  uint64_t bytes_written;
  int write_attempted;
};
struct elizaos_gpt_restore_control {
  void *context;
  /* Required trusted in-process authorization/cancellation check. Returns 0
   * or negative errno, never derived directly from caller IPC. */
  int (*check)(void *context);
  void (*progress)(void *context, enum elizaos_gpt_restore_step step);
};
/* Internal candidate, not installed. Caller authenticates an explicit recovery
 * against the original physical target, verifies independent durable storage,
 * consumes the recovery authorization and retains its physical-target lock and
 * exclusive buffered O_RDWR whole-device claim throughout settlement.
 * Copy and verify the artifact before any write. Restore backup array/header
 * first, fsync/read back, then primary array/header and MBR; fsync/read back all
 * regions. Guards run between bounded chunks/operations. No pathname accepted.
 * A failed attempted write is always incomplete, even with bytes_written == 0.
 * Success covers on-disk GPT bytes only: caller must reread/verify the kernel
 * partition map before using partitions. This cannot roll back payload writes,
 * filesystem resizing or bootloader changes, and does not prove power-loss safety. */
int elizaos_install_restore_gpt(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_restore_control *control,
    struct elizaos_gpt_restore_result *result);
struct elizaos_gpt_map_result {
  int error;
  int reread_attempted;
  int verified;
  uint32_t partitions;
};
/* After explicit GPT restoration, require the exact original metadata still on
 * disk, issue BLKRRPART once and verify every kernel partition index/extent,
 * including missing or unexpected partitions. Recheck disk bytes and identity
 * afterward. Uses control->check, not the restore progress callback. Same trusted
 * authorization, exclusive descriptor and physical-lock prerequisites as restore.
 * A busy table or any other error remains unverified; there is no retry/fallback.
 * Success does not prove udev node settlement, safe partition FDs, bootability,
 * durable journal completion or power-loss recovery. Not installed. */
int elizaos_install_refresh_gpt_map(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_restore_control *control,
    struct elizaos_gpt_map_result *result);
#endif
