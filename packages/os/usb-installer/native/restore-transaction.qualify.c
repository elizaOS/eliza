/* Disposable-VM entrypoint only. Neither this wrapper nor its transaction is
 * installed or linked into the shipped disabled helper. */
#define main elizaos_disabled_transaction_gate_main
#include "linux-restore-helper.c"
#undef main
#include "restore-transaction.h"

typedef int (*qualification_observer)(int step, int whole, int partition);

struct qualification {
  struct request request;
  struct retained_authorization grant;
  int consumed_directory;
  int cancel_step;
  bool cancelled;
  uint32_t *steps;
  int whole_fd;
  int partition_fd;
  qualification_observer observer;
};
static int transaction_authorization(void *data) {
  const struct qualification *context = data;
  return authorization_status(&context->request, &context->grant);
}
static int transaction_consume(void *data) {
  struct qualification *context = data;
  const int rc = consume_authorized_plan(&context->request,
                                         context->consumed_directory, &context->grant);
  return rc == 0 ? 0 : rc == 1 ? -EALREADY : (errno == EKEYEXPIRED || errno == EKEYREVOKED) ? -errno : -EIO;
}
static int transaction_open(void *data, int whole) {
  struct qualification *context = data;
  context->partition_fd = open_verified_partition(&context->request, whole);
  return context->partition_fd;
}
static bool transaction_validate(void *data, int whole, int partition) {
  struct qualification *context = data;
  return partition < 0 ? validate_whole_device_fd(whole, &context->request)
                        : validate_partition_fd(&context->request, whole, partition);
}
static bool transaction_cancelled(void *data) {
  const struct qualification *context = data;
  return context->cancelled;
}
static void transaction_progress(void *data, enum elizaos_restore_step step) {
  struct qualification *context = data;
  *context->steps |= UINT32_C(1) << (unsigned int)step;
  if ((int)step == context->cancel_step) context->cancelled = true;
  if (context->observer != NULL &&
      context->observer((int)step, context->whole_fd,
                        step == ELIZAOS_RESTORE_COMPLETE ? -1 : context->partition_fd) != 0)
    context->cancelled = true;
}

static int qualify_transaction(const char *input, size_t length, int cancel_step,
                               qualification_observer observer,
                               struct elizaos_restore_result *result, uint32_t *steps) {
  if (result == NULL || steps == NULL) return -EINVAL;
  memset(result, 0, sizeof(*result));
  *steps = 0U;
  result->last_completed = ELIZAOS_RESTORE_NOT_STARTED;
  result->error = -EINVAL;
  if (input == NULL || length == 0U || length > REQUEST_MAX_BYTES ||
      cancel_step < -1 || cancel_step >= (int)ELIZAOS_RESTORE_COMPLETE ||
      geteuid() != 0U) return result->error;
  char wire[REQUEST_MAX_BYTES + 1U];
  memcpy(wire, input, length);
  wire[length] = '\0';
  struct qualification context = {.consumed_directory = -1,
                                  .whole_fd = -1, .partition_fd = -1, .observer = observer,
                                  .cancel_step = cancel_step, .steps = steps};
  if (!parse_request(wire, length, &context.request) ||
      !request_matches_current_boot(&context.request)) return result->error;
  const int authorization = validate_authorized_plan(&context.request,
                                                      &context.consumed_directory, &context.grant);
  if (authorization != 0) {
    result->error = authorization == 1 ? -EALREADY : authorization == -3 ? -EKEYEXPIRED : -EPERM;
    return result->error;
  }
  const int whole = open(context.request.device_path,
                          O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_EXCL);
  if (whole < 0) {
    result->error = -errno;
    (void)close(context.consumed_directory);
    (void)close_authorization(&context.grant);
    return result->error;
  }
  context.whole_fd = whole;
  const struct elizaos_restore_transaction transaction = {
    .whole_fd = whole,
    .identity = {.major = (uint32_t)context.request.expected_major,
                 .minor = (uint32_t)context.request.expected_minor,
                 .diskseq = context.request.expected_diskseq,
                 .size_bytes = context.request.expected_size_bytes},
    .context = &context, .check_authorization = transaction_authorization,
    .consume = transaction_consume,
    .open_partition = transaction_open, .validate = transaction_validate,
    .cancelled = transaction_cancelled, .progress = transaction_progress
  };
  int rc = elizaos_restore_execute(&transaction, result);
  const int close_whole = close(whole);
  const int close_directory = close(context.consumed_directory);
  const int close_grant = close_authorization(&context.grant);
  if (rc == 0 && (close_whole != 0 || close_directory != 0 || close_grant != 0)) {
    rc = -EIO;
    result->error = rc;
    result->outcome = ELIZAOS_RESTORE_FAILED;
    result->media = ELIZAOS_RESTORE_INCOMPLETE;
  }
  return rc;
}

int elizaos_qualify_transaction(const char *input, size_t length, int cancel_step,
                               struct elizaos_restore_result *result, uint32_t *steps) {
  return qualify_transaction(input, length, cancel_step, NULL, result, steps);
}

/* Test-only synchronous observer. Descriptors are borrowed and must not be
 * closed, replaced or retained. No observer is accepted by the shipped helper. */
int elizaos_qualify_transaction_observed(const char *input, size_t length,
                                        qualification_observer observer,
                                        struct elizaos_restore_result *result,
                                        uint32_t *steps) {
  if (observer == NULL) return -EINVAL;
  return qualify_transaction(input, length, -1, observer, result, steps);
}
