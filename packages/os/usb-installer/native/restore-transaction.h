#ifndef ELIZAOS_RESTORE_TRANSACTION_H
#define ELIZAOS_RESTORE_TRANSACTION_H

#include <stdbool.h>
#include "restore-gpt-fd.h"
#include "restore-tool-runner.h"

enum elizaos_restore_step {
  ELIZAOS_RESTORE_NOT_STARTED = -1,
  ELIZAOS_RESTORE_AUTHORIZED,
  ELIZAOS_RESTORE_CONSUMED,
  ELIZAOS_RESTORE_GPT_CREATED,
  ELIZAOS_RESTORE_GPT_VERIFIED,
  ELIZAOS_RESTORE_KERNEL_REREAD,
  ELIZAOS_RESTORE_UDEV_SETTLED,
  ELIZAOS_RESTORE_PARTITION_RETAINED,
  ELIZAOS_RESTORE_FORMATTED,
  ELIZAOS_RESTORE_CHECKED,
  ELIZAOS_RESTORE_SYNCED,
  ELIZAOS_RESTORE_COMPLETE
};
enum elizaos_restore_outcome {
  ELIZAOS_RESTORE_FAILED, ELIZAOS_RESTORE_CANCELLED, ELIZAOS_RESTORE_SUCCEEDED
};
enum elizaos_restore_media { ELIZAOS_RESTORE_UNTOUCHED, ELIZAOS_RESTORE_INCOMPLETE,
                            ELIZAOS_RESTORE_READY };
struct elizaos_restore_result {
  enum elizaos_restore_outcome outcome;
  enum elizaos_restore_media media;
  enum elizaos_restore_step last_completed;
  int error;
  struct elizaos_tool_result tool;
};

/* Trusted in-process bindings, never an IPC or user-selected callback surface.
 * Caller has already authenticated the exact boot-bound request, retained its
 * root-owned authorization directory and exclusively opened whole-device FD.
 * check_authorization must return 0 or negative errno at every boundary.
 * consume must durably create its single-use marker (0 or negative errno).
 * open_partition returns a new owned FD bound to partition 1 and the fixed GPT
 * extent. validate must recheck both held identities (partition == -1 until
 * opened). No callback may release/reassign descriptors or outlive this call.
 * Progress is a synchronous trusted observer; cancellation is observed only
 * between bounded operations, never by racing an in-flight write or child.
 * The caller keeps the target claim until all work and child cleanup settles.
 * This candidate is exercised in isolated VMs, not linked into the shipped
 * disabled helper. The trusted helper supplies the expiry check; initiating
 * local-user authentication and broker policy remain separate requirements. */
struct elizaos_restore_transaction {
  int whole_fd;
  struct elizaos_restore_identity identity;
  void *context;
  int (*check_authorization)(void *context);
  int (*consume)(void *context);
  int (*open_partition)(void *context, int whole_fd);
  bool (*validate)(void *context, int whole_fd, int partition_fd);
  bool (*cancelled)(void *context);
  void (*progress)(void *context, enum elizaos_restore_step step);
};

int elizaos_restore_execute(const struct elizaos_restore_transaction *transaction,
                           struct elizaos_restore_result *result);
#endif
