/**
 * Coding agent task lifecycle actions.
 *
 * ARCHIVE_CODING_TASK → POST /api/coding-agents/coordinator/threads/:id/archive
 * REOPEN_CODING_TASK  → POST /api/coding-agents/coordinator/threads/:id/reopen
 */

import type { Action, ActionResult, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import { hasOwnerAccess } from "../security/access.js";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

interface CodingTaskParams {
  taskId?: string;
}

async function postCodingThreadAction(
  taskId: string,
  verb: "archive" | "reopen",
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const url = `${getApiBase()}/api/coding-agents/coordinator/threads/${encodeURIComponent(taskId)}/${verb}`;
  const resp = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  const bodyText = await resp.text();
  return { ok: resp.ok, status: resp.status, bodyText };
}

export const archiveCodingTaskAction: Action = {
  name: "ARCHIVE_CODING_TASK",
  contexts: ["code", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["CLOSE_CODING_TASK", "ARCHIVE_TASK_THREAD"],
  description:
    "Archive a coding-agent task thread by id. The thread becomes hidden from the active list but remains in history.",
  descriptionCompressed:
    "archive coding-agent task thread id thread become hidden active list remain history",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may archive coding tasks.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | CodingTaskParams
      | undefined;
    const taskId = params?.taskId?.trim();
    if (!taskId) {
      return {
        success: false,
        text: "taskId is required.",
        values: { error: "MISSING_TASK_ID" },
      };
    }

    try {
      const result = await postCodingThreadAction(taskId, "archive");
      if (!result.ok) {
        return {
          success: false,
          text: `Failed to archive coding task ${taskId}: HTTP ${result.status}`,
          data: {
            actionName: "ARCHIVE_CODING_TASK",
            taskId,
            status: result.status,
            body: result.bodyText,
          },
        };
      }
      return {
        success: true,
        text: `Archived coding task ${taskId}.`,
        values: { taskId, archived: true },
        data: { actionName: "ARCHIVE_CODING_TASK", taskId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[archive-coding-task] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to archive coding task ${taskId}: ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "taskId",
      description: "ID of the coding-agent task thread to archive.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Archive coding task abc-123." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Archived coding task abc-123.",
          action: "ARCHIVE_CODING_TASK",
        },
      },
    ],
  ],
};

export const reopenCodingTaskAction: Action = {
  name: "REOPEN_CODING_TASK",
  contexts: ["code", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["UNARCHIVE_CODING_TASK", "RESUME_CODING_TASK"],
  description:
    "Reopen a previously-archived coding-agent task thread by id, returning it to the active list.",
  descriptionCompressed:
    "reopen previously-archive coding-agent task thread id, return active list",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may reopen coding tasks.",
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | CodingTaskParams
      | undefined;
    const taskId = params?.taskId?.trim();
    if (!taskId) {
      return {
        success: false,
        text: "taskId is required.",
        values: { error: "MISSING_TASK_ID" },
      };
    }

    try {
      const result = await postCodingThreadAction(taskId, "reopen");
      if (!result.ok) {
        return {
          success: false,
          text: `Failed to reopen coding task ${taskId}: HTTP ${result.status}`,
          data: {
            actionName: "REOPEN_CODING_TASK",
            taskId,
            status: result.status,
            body: result.bodyText,
          },
        };
      }
      return {
        success: true,
        text: `Reopened coding task ${taskId}.`,
        values: { taskId, reopened: true },
        data: { actionName: "REOPEN_CODING_TASK", taskId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[reopen-coding-task] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to reopen coding task ${taskId}: ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "taskId",
      description: "ID of the coding-agent task thread to reopen.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Reopen coding task abc-123." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Reopened coding task abc-123.",
          action: "REOPEN_CODING_TASK",
        },
      },
    ],
  ],
};
