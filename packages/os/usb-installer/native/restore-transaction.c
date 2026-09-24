#define _GNU_SOURCE
#include "restore-transaction.h"
#include <errno.h>
#include <linux/fs.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int guard(const struct elizaos_restore_transaction *transaction,
                 int partition) {
  const int authorization = transaction->check_authorization(transaction->context);
  if (authorization != 0) return authorization < 0 ? authorization : -EACCES;
  if (!transaction->validate(transaction->context, transaction->whole_fd,
                              partition)) return -ESTALE;
  return transaction->cancelled(transaction->context) ? -ECANCELED : 0;
}

static void completed(const struct elizaos_restore_transaction *transaction,
                      struct elizaos_restore_result *result,
                      enum elizaos_restore_step step) {
  result->last_completed = step;
  if (transaction->progress != NULL)
    transaction->progress(transaction->context, step);
}

int elizaos_restore_execute(const struct elizaos_restore_transaction *transaction,
                           struct elizaos_restore_result *result) {
  if (result == NULL) return -EINVAL;
  memset(result, 0, sizeof(*result));
  result->outcome = ELIZAOS_RESTORE_FAILED;
  result->last_completed = ELIZAOS_RESTORE_NOT_STARTED;
  result->media = ELIZAOS_RESTORE_UNTOUCHED;
  if (transaction == NULL || transaction->whole_fd < 0 ||
      transaction->check_authorization == NULL || transaction->consume == NULL ||
      transaction->open_partition == NULL ||
      transaction->validate == NULL || transaction->cancelled == NULL) {
    result->error = -EINVAL;
    return result->error;
  }
  int partition = -1;
  int rc = guard(transaction, partition);
  if (rc != 0) goto done;
  completed(transaction, result, ELIZAOS_RESTORE_AUTHORIZED);
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  /* Even a failed marker fsync may have consumed authorization. From here,
   * uncertainty never becomes an untouched/retryable success claim. */
  result->media = ELIZAOS_RESTORE_INCOMPLETE;
  rc = transaction->consume(transaction->context);
  if (rc != 0) { if (rc > 0) rc = -EIO; goto done; }
  completed(transaction, result, ELIZAOS_RESTORE_CONSUMED);

#define RUN(expression, step) do { \
  rc = guard(transaction, partition); \
  if (rc != 0) goto done; \
  rc = (expression); \
  if (rc != 0) goto done; \
  if (!transaction->validate(transaction->context, transaction->whole_fd, partition)) { \
    rc = -ESTALE; goto done; \
  } \
  completed(transaction, result, (step)); \
} while (0)

  RUN(elizaos_restore_create_gpt(transaction->whole_fd, &transaction->identity),
      ELIZAOS_RESTORE_GPT_CREATED);
  RUN(elizaos_restore_verify_gpt(transaction->whole_fd, &transaction->identity),
      ELIZAOS_RESTORE_GPT_VERIFIED);
  RUN(ioctl(transaction->whole_fd, BLKRRPART) == 0 ? 0 : -errno,
      ELIZAOS_RESTORE_KERNEL_REREAD);
  RUN(elizaos_restore_run_tool(ELIZAOS_RESTORE_SETTLE, -1, &result->tool),
      ELIZAOS_RESTORE_UDEV_SETTLED);
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  partition = transaction->open_partition(transaction->context,
                                         transaction->whole_fd);
  if (partition < 0) { rc = -ESTALE; goto done; }
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  completed(transaction, result, ELIZAOS_RESTORE_PARTITION_RETAINED);
  RUN(elizaos_restore_run_tool(ELIZAOS_RESTORE_FORMAT, partition, &result->tool),
      ELIZAOS_RESTORE_FORMATTED);
  RUN(elizaos_restore_run_tool(ELIZAOS_RESTORE_CHECK, partition, &result->tool),
      ELIZAOS_RESTORE_CHECKED);
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  if (fsync(partition) != 0 || fsync(transaction->whole_fd) != 0) {
    rc = -errno;
    goto done;
  }
  rc = elizaos_restore_verify_gpt(transaction->whole_fd, &transaction->identity);
  if (rc != 0) goto done;
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  completed(transaction, result, ELIZAOS_RESTORE_SYNCED);
  rc = guard(transaction, partition);
  if (rc != 0) goto done;
  if (close(partition) != 0) { partition = -1; rc = -errno; goto done; }
  partition = -1;
  result->outcome = ELIZAOS_RESTORE_SUCCEEDED;
  result->media = ELIZAOS_RESTORE_READY;
  completed(transaction, result, ELIZAOS_RESTORE_COMPLETE);
done:
  if (partition >= 0) (void)close(partition);
  if (rc != 0) {
    result->outcome = rc == -ECANCELED ? ELIZAOS_RESTORE_CANCELLED
                                       : ELIZAOS_RESTORE_FAILED;
  }
  result->error = rc;
  return rc;
#undef RUN
}
