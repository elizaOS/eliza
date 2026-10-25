#ifndef ELIZAOS_RESTORE_TOOL_RUNNER_H
#define ELIZAOS_RESTORE_TOOL_RUNNER_H
#include <stddef.h>

enum elizaos_restore_tool { ELIZAOS_RESTORE_SETTLE, ELIZAOS_RESTORE_FORMAT,
                            ELIZAOS_RESTORE_CHECK };
enum elizaos_tool_outcome { ELIZAOS_TOOL_OK, ELIZAOS_TOOL_SETUP,
  ELIZAOS_TOOL_EXIT, ELIZAOS_TOOL_SIGNAL, ELIZAOS_TOOL_TIMEOUT,
  ELIZAOS_TOOL_OUTPUT_LIMIT, ELIZAOS_TOOL_IO };
struct elizaos_tool_result {
  enum elizaos_tool_outcome outcome;
  int detail;
  size_t stdout_bytes;
  size_t stderr_bytes;
};
/* Internal, synchronous, single-threaded helper API. No authorization is
 * implied. Caller retains the physical-target lock and checks cancellation
 * and device identities before AND after this bounded operation. Only the
 * partition descriptor is inherited (as FD 4); settle requires fd == -1.
 * No caller path, argv, environment or timeout is accepted. Output is counted
 * and discarded, never interpreted as a privileged progress protocol.
 * Returns zero only for exit-zero completion; every failure is negative errno.
 * The deadline triggers SIGKILL, then the leader is reaped before returning.
 * Kernel uninterruptible I/O can delay reaping; callers must keep the target
 * lock held during that wait, never claim an interrupted write was rolled back.
 * SIGCHLD must have its default disposition and no competing reaper.
 * Not linked into the shipped helper until the complete broker is qualified. */
int elizaos_restore_run_tool(enum elizaos_restore_tool tool, int partition_fd,
                            struct elizaos_tool_result *result);
#endif
