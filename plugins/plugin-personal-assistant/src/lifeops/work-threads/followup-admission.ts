import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScheduledTask,
  ScheduledTaskFireResult,
} from "@elizaos/plugin-scheduling";
import {
  isWorkThreadFollowup,
  workThreadFollowupInactiveReason,
} from "./followup-thread-check.js";
import {
  withWorkThreadOperationLocks,
  workThreadLockKey,
} from "./operation-lock.js";

/**
 * Runner execution boundary for work-thread follow-ups. The thread's state
 * is read again under the thread's operation lock immediately before the
 * claim, so a stop, completion or replacement that committed after the
 * scheduler's first read is seen, and one that arrives later waits until the
 * follow-up has fired. A follow-up whose thread no longer wants it is skipped
 * without a claim; the next tick dismisses it.
 */
export async function withWorkThreadFollowupAdmission(
  runtime: IAgentRuntime,
  task: ScheduledTask,
  execute: () => Promise<ScheduledTaskFireResult>,
): Promise<ScheduledTaskFireResult> {
  if (!isWorkThreadFollowup(task)) {
    return execute();
  }
  return withWorkThreadOperationLocks(
    [workThreadLockKey(task.subject.id)],
    async () => {
      const reason = await workThreadFollowupInactiveReason(runtime, task);
      if (reason) return { kind: "skipped", task, reason };
      return execute();
    },
  );
}
