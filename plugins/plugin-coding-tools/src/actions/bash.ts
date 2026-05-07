import * as fs from "node:fs/promises";
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
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
  truncate,
} from "../lib/format.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import type {
  ShellTaskRecord,
  ShellTaskService,
} from "../services/shell-task-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
  SHELL_TASK_SERVICE,
} from "../types.js";

const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BG_BUDGET_MS = 15_000;
const STREAM_CAP_CHARS = 30_000;

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Math.floor(value)));
}

function formatStreams(stdout: string, stderr: string): string {
  const sOut = truncate(stdout, STREAM_CAP_CHARS);
  const sErr = truncate(stderr, STREAM_CAP_CHARS);
  const lines: string[] = [];
  if (sOut.text.length > 0) {
    lines.push("--- stdout ---");
    lines.push(sOut.text);
  }
  if (sErr.text.length > 0) {
    lines.push("--- stderr ---");
    lines.push(sErr.text);
  }
  return lines.join("\n");
}

function formatForeground(
  rec: ShellTaskRecord,
  command: string,
  took: number,
): string {
  const exit = rec.exitCode ?? -1;
  const head = `$ ${command}\n[exit ${exit}] (cwd=${rec.cwd}, took=${took}ms)`;
  const streams = formatStreams(rec.stdout, rec.stderr);
  return streams.length > 0 ? `${head}\n${streams}` : head;
}

export const bashAction: Action = {
  name: "BASH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["SHELL", "EXEC", "RUN_COMMAND"],
  description:
    "Execute a shell command via /bin/bash -c <command>. Runs in the session cwd by default. Foreground commands return stdout, stderr, and exit code. Long-running commands auto-promote to background and return a task_id; pass run_in_background=true to background immediately. Paths under the configured blocklist (e.g. ~/pvt, ~/Library, ~/.ssh) are off-limits as cwd.",
  descriptionCompressed:
    "Run a shell command (foreground or background).",
  parameters: [
    {
      name: "command",
      description: "Shell command to run; executed via /bin/bash -c <command>.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Five to ten word humanly-readable summary of the command.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description:
        "Hard timeout in ms; clamped to [100, 600000]. Default 120000.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "cwd",
      description:
        "Absolute working directory; must not resolve under a blocked path. Defaults to the session cwd.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "run_in_background",
      description:
        "If true, return a task_id immediately. Use TASK_OUTPUT to poll and TASK_STOP to terminate.",
      required: false,
      schema: { type: "boolean" },
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
    const command = readStringParam(options, "command");
    if (!command || command.trim().length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "BASH requires 'command' (string)",
      });
    }
    const description = readStringParam(options, "description");
    const cwdParam = readStringParam(options, "cwd");
    const runInBackground =
      readBoolParam(options, "run_in_background") ?? false;

    if (!message.roomId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }
    const conversationId = String(message.roomId);

    const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
      typeof SandboxService
    > | null;
    const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
      typeof SessionCwdService
    > | null;
    const tasks = runtime.getService(SHELL_TASK_SERVICE) as InstanceType<
      typeof ShellTaskService
    > | null;
    if (!sandbox || !session || !tasks) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    let cwd: string;
    if (cwdParam) {
      const v = await sandbox.validatePath(conversationId, cwdParam);
      if (!v.ok) {
        return failureToActionResult({
          reason: v.reason === "blocked" ? "path_blocked" : "invalid_param",
          message: v.message,
        });
      }
      try {
        const stat = await fs.stat(v.resolved);
        if (!stat.isDirectory()) {
          return failureToActionResult({
            reason: "invalid_param",
            message: `cwd is not a directory: ${cwdParam}`,
          });
        }
      } catch (err) {
        return failureToActionResult({
          reason: "io_error",
          message: `cwd stat failed: ${(err as Error).message}`,
        });
      }
      cwd = v.resolved;
    } else {
      cwd = session.getCwd(conversationId);
    }

    const defaultTimeout = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_BASH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const bgBudget = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_BASH_BG_BUDGET_MS",
      DEFAULT_BG_BUDGET_MS,
    );
    const timeout = clampTimeout(
      readNumberParam(options, "timeout"),
      defaultTimeout,
    );

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} BASH ${runInBackground ? "(bg)" : "(fg)"} cwd=${cwd} timeout=${timeout}ms`,
    );

    const startOpts: {
      command: string;
      cwd: string;
      description?: string;
    } = {
      command,
      cwd,
    };
    if (description !== undefined) startOpts.description = description;
    const rec = tasks.start_(startOpts);

    if (runInBackground) {
      const text = `Started background task ${rec.id}`;
      if (callback) await callback({ text, source: "coding-tools" });
      return successActionResult(text, { task_id: rec.id, command, cwd });
    }

    const startedAt = rec.startedAt;
    const foregroundBudget = Math.min(timeout, bgBudget);
    const settled = await tasks.waitFor(rec.id, foregroundBudget);

    if (settled && settled.status !== "running") {
      const took = (settled.endedAt ?? Date.now()) - startedAt;
      const text = formatForeground(settled, command, took);
      if (callback) await callback({ text, source: "coding-tools" });
      if (settled.status === "completed") {
        return successActionResult(text, {
          task_id: settled.id,
          exit_code: settled.exitCode ?? 0,
          cwd,
        });
      }
      return failureToActionResult(
        {
          reason: "command_failed",
          message: `command exited with code ${settled.exitCode ?? -1}`,
        },
        {
          task_id: settled.id,
          exit_code: settled.exitCode ?? -1,
          cwd,
          output: text,
        },
      );
    }

    if (timeout <= bgBudget) {
      tasks.stop_(rec.id);
      await tasks.waitFor(rec.id, 500);
      const final = tasks.get(rec.id);
      const took = (final?.endedAt ?? Date.now()) - startedAt;
      const head = `$ ${command}\n[timeout ${timeout}ms] (cwd=${cwd}, took=${took}ms)`;
      const streams = formatStreams(final?.stdout ?? "", final?.stderr ?? "");
      const text = streams.length > 0 ? `${head}\n${streams}` : head;
      if (callback) await callback({ text, source: "coding-tools" });
      return failureToActionResult(
        { reason: "timeout", message: `command timed out after ${timeout}ms` },
        { task_id: rec.id, cwd, output: text },
      );
    }

    const text = `Foreground budget (${bgBudget}ms) exceeded. Promoted to background task ${rec.id}. Use TASK_OUTPUT to poll.`;
    if (callback) await callback({ text, source: "coding-tools" });
    return successActionResult(text, {
      task_id: rec.id,
      command,
      cwd,
      promoted: true,
    });
  },
};
