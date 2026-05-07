import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import type { ShellTaskService } from "../services/shell-task-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SHELL_TASK_SERVICE,
} from "../types.js";

const STOP_GRACE_MS = 2_500;

export const taskStopAction: Action = {
  name: "TASK_STOP",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["KILL_TASK", "STOP_TASK"],
  description:
    "Terminate a running background BASH task by id. Sends SIGTERM (and SIGKILL after a grace period). Returns the task's terminal status.",
  descriptionCompressed: "Stop a background shell task.",
  parameters: [
    {
      name: "task_id",
      description: "Task id returned by BASH (background or auto-promoted).",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    const disable = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (disable === true || disable === "true" || disable === "1") return false;
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!message.roomId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }

    const taskId = readStringParam(options, "task_id");
    if (!taskId || taskId.trim().length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "task_id is required",
      });
    }

    const tasks = runtime.getService(SHELL_TASK_SERVICE) as InstanceType<
      typeof ShellTaskService
    > | null;
    if (!tasks) {
      return failureToActionResult({
        reason: "internal",
        message: "ShellTaskService unavailable",
      });
    }

    try {
      const rec = tasks.get(taskId);
      if (!rec) {
        return failureToActionResult({
          reason: "invalid_param",
          message: `Unknown task ${taskId}`,
        });
      }

      if (rec.status !== "running") {
        const text = `Task already ${rec.status}`;
        if (callback) await callback({ text, source: "coding-tools" });
        return successActionResult(text, {
          task_id: rec.id,
          status: rec.status,
          exit_code: rec.exitCode ?? null,
        });
      }

      const sent = tasks.stop_(taskId);
      if (!sent) {
        return failureToActionResult({
          reason: "internal",
          message: `failed to deliver stop signal to ${taskId}`,
        });
      }

      coreLogger.debug(
        `${CODING_TOOLS_LOG_PREFIX} TASK_STOP signaled ${taskId}`,
      );

      // Wait briefly so the caller sees the post-kill status; SIGTERM almost
      // always lands well before the grace window expires.
      const final = await tasks.waitFor(taskId, STOP_GRACE_MS);
      const status = final?.status ?? "killed";
      const text = `Task ${taskId} stopped (status=${status})`;
      if (callback) await callback({ text, source: "coding-tools" });
      return successActionResult(text, {
        task_id: taskId,
        status,
        exit_code: final?.exitCode ?? null,
      });
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      return failureToActionResult({
        reason: "internal",
        message: `task stop failed: ${messageText.slice(0, 500)}`,
      });
    }
  },
};
