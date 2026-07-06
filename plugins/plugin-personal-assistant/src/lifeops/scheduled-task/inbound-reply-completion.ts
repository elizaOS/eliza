/**
 * Deterministic inbound-reply completion for fired ScheduledTasks.
 *
 * When the owner replies in a room that has fired tasks awaiting them (the
 * same room the scheduler recorded as the pending-prompt room), the reply
 * itself is the completion signal for `user_replied_within` checks. Before
 * this hook the ONLY `evaluateCompletion` caller was the LLM verb action —
 * the planner had to notice the open prompt and route a verb, so a plain
 * "done!" reply left the task `fired` until the completion timeout skipped
 * it. This hook runs on `MESSAGE_RECEIVED`, matches the reply room against
 * each fired task's pending-prompt room, and evaluates the task's completion
 * check with the reply timestamp — no LLM in the loop.
 *
 * Scope guards:
 *  - owner messages only (`hasOwnerAccess`), never the agent's own outbounds;
 *  - only tasks with a `completionCheck` and a pending-prompt room matching
 *    the reply room;
 *  - the check itself decides: `user_replied_within` completes when the reply
 *    is inside its window; `user_acknowledged` does NOT complete from a plain
 *    reply (acknowledgment stays an explicit verb); `subject_updated` gets an
 *    opportunistic re-evaluation against the real subject store.
 *
 * Per-task evaluation errors are logged and do not block the message
 * pipeline — an inbound chat message must never fail because one scheduled
 * task row is broken.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import { type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  pendingPromptRoomIdForTask,
} from "@elizaos/plugin-scheduling";
import { CheckinService } from "../checkin/checkin-service.js";
import { resolvePendingPromptsStore } from "../pending-prompts/store.js";
import { recordTaskStateEntry } from "./scheduler.js";

const LOG_SRC = "lifeops:scheduled-task:inbound-reply-completion";

export interface InboundReplyCompletionResult {
  /** Task ids whose completion check was evaluated against this reply. */
  evaluated: string[];
  /** Subset that deterministically completed. */
  completed: string[];
}

const EMPTY: InboundReplyCompletionResult = { evaluated: [], completed: [] };

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function acknowledgeCheckinReportForCompletedTask(
  runtime: IAgentRuntime,
  task: { taskId: string; kind?: string; metadata?: Record<string, unknown> },
): Promise<boolean> {
  if (task.kind !== "checkin") return false;
  const reportId = metadataString(task.metadata, "checkinReportId");
  if (!reportId) return false;
  await new CheckinService(runtime).recordCheckinAcknowledgement({ reportId });
  logger.info(
    {
      src: LOG_SRC,
      agentId: runtime.agentId,
      taskId: task.taskId,
      reportId,
    },
    `[InboundReplyCompletion] owner reply acknowledged check-in report ${reportId}`,
  );
  return true;
}

function checkinReportIdFromOwnerReply(message: Memory): string | null {
  const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
  return (
    metadataString(metadata, "checkinReportId") ??
    metadataString(metadata, "reportId")
  );
}

async function acknowledgeCheckinReportFromReplyMetadata(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  const reportId = checkinReportIdFromOwnerReply(message);
  if (!reportId) return false;
  await new CheckinService(runtime).recordCheckinAcknowledgement({ reportId });
  logger.info(
    {
      src: LOG_SRC,
      agentId: runtime.agentId,
      reportId,
    },
    `[InboundReplyCompletion] owner reply acknowledged check-in report from reply metadata ${reportId}`,
  );
  return true;
}

/**
 * Evaluate completion checks for fired tasks awaiting a reply in the
 * message's room. Returns which tasks were evaluated/completed (for tests
 * and diagnostics).
 */
export async function completeFiredTasksOnOwnerReply(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<InboundReplyCompletionResult> {
  const roomId = typeof message.roomId === "string" ? message.roomId : null;
  if (!roomId) return EMPTY;
  if (message.entityId === runtime.agentId) return EMPTY;
  if (!(await hasOwnerAccess(runtime, message))) return EMPTY;

  const repliedAtIso =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? new Date(message.createdAt).toISOString()
      : new Date().toISOString();

  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  const fired = await runner.list({ status: "fired" });
  if (fired.length === 0) {
    await acknowledgeCheckinReportFromReplyMetadata(runtime, message);
    return EMPTY;
  }

  const result: InboundReplyCompletionResult = { evaluated: [], completed: [] };
  let acknowledgedCheckinReport = false;
  for (const task of fired) {
    if (!task.completionCheck) continue;
    if (pendingPromptRoomIdForTask(task) !== roomId) continue;
    try {
      const updated = await runner.evaluateCompletion(task.taskId, {
        repliedAtIso,
      });
      result.evaluated.push(task.taskId);
      if (updated.state.status === "completed") {
        result.completed.push(task.taskId);
        await resolvePendingPromptsStore(runtime).forgetTask(task.taskId);
        // Feed the recent-task-states log: the reply is the engagement
        // signal that breaks a quiet streak (#12284 item 8). Never throws.
        await recordTaskStateEntry(
          runtime,
          updated,
          "completed",
          new Date(repliedAtIso),
        );
        acknowledgedCheckinReport =
          (await acknowledgeCheckinReportForCompletedTask(runtime, task)) ||
          acknowledgedCheckinReport;
        logger.info(
          {
            src: LOG_SRC,
            agentId: runtime.agentId,
            taskId: task.taskId,
            roomId,
          },
          `[InboundReplyCompletion] owner reply completed fired task ${task.taskId}`,
        );
      }
    } catch (error) {
      logger.warn(
        {
          src: LOG_SRC,
          agentId: runtime.agentId,
          taskId: task.taskId,
          roomId,
          error,
        },
        `[InboundReplyCompletion] completion evaluation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (!acknowledgedCheckinReport) {
    await acknowledgeCheckinReportFromReplyMetadata(runtime, message);
  }
  return result;
}
