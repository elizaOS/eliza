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
  readBoolParam,
  readNumberParam,
  readStringParam,
  successActionResult,
  truncate,
} from "../lib/format.js";
import type { ShellTaskService } from "../services/shell-task-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SHELL_TASK_SERVICE,
} from "../types.js";

const STREAM_CAP_CHARS = 30_000;
const TIMEOUT_MAX_MS = 600_000;
const DEFAULT_BLOCK_TIMEOUT_MS = 30_000;

function clampWait(value: number): number {
  return Math.max(0, Math.min(TIMEOUT_MAX_MS, Math.floor(value)));
}

export const taskOutputAction: Action = {
  name: "TASK_OUTPUT",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["GET_TASK_OUTPUT"],
  description:
    "Read captured output and current status of a background BASH task. Pass block=true to wait for completion (or until timeout) before returning.",
  descriptionCompressed:
    "Read background shell task output (optionally blocking).",
  parameters: [
    {
      name: "task_id",
      description: "Task id returned by BASH (background or auto-promoted).",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "block",
      description:
        "If true, wait for the task to finish (or until timeout) before returning.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "timeout",
      description:
        "When blocking, max ms to wait. Clamped to [0, 600000]. Default 30000 when block=true, 0 otherwise.",
      required: false,
      schema: { type: "number" },
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
      let rec = tasks.get(taskId);
      if (!rec) {
        return failureToActionResult({
          reason: "invalid_param",
          message: `Unknown task ${taskId}`,
        });
      }

      const block = readBoolParam(options, "block") ?? false;
      const requestedTimeout = readNumberParam(options, "timeout");
      const timeoutMs = clampWait(
        requestedTimeout ?? (block ? DEFAULT_BLOCK_TIMEOUT_MS : 0),
      );

      if (block && rec.status === "running" && timeoutMs > 0) {
        coreLogger.debug(
          `${CODING_TOOLS_LOG_PREFIX} TASK_OUTPUT blocking on ${taskId} for ${timeoutMs}ms`,
        );
        const updated = await tasks.waitFor(taskId, timeoutMs);
        if (updated) rec = updated;
      }

      const stdoutT = truncate(rec.stdout, STREAM_CAP_CHARS);
      const stderrT = truncate(rec.stderr, STREAM_CAP_CHARS);
      const exitLine =
        rec.exitCode === undefined
          ? "exit_code: <none>"
          : `exit_code: ${rec.exitCode}`;
      const lines = [`task_id: ${rec.id}`, `status: ${rec.status}`, exitLine];
      if (stdoutT.text.length > 0) {
        lines.push("--- stdout ---");
        lines.push(stdoutT.text);
      }
      if (stderrT.text.length > 0) {
        lines.push("--- stderr ---");
        lines.push(stderrT.text);
      }
      const text = lines.join("\n");

      if (callback) await callback({ text, source: "coding-tools" });

      return successActionResult(text, {
        task_id: rec.id,
        status: rec.status,
        exit_code: rec.exitCode ?? null,
        command: rec.command,
        cwd: rec.cwd,
      });
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      return failureToActionResult({
        reason: "internal",
        message: `task output failed: ${messageText.slice(0, 500)}`,
      });
    }
  },
};
