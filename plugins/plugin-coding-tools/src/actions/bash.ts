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
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
  truncate,
} from "../lib/format.js";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import { runShell, type ShellResult } from "../lib/run-shell.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
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


export const shellAction: Action = {
  name: "SHELL",
  contexts: [...CODING_TOOLS_CONTEXTS],
  roleGate: { minRole: "OWNER" },
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["EXEC", "RUN_COMMAND"],
  description:
    "Execute a shell command via the configured local shell. Runs synchronously in the session cwd by default. Returns stdout, stderr, and exit code. Hard timeout kills the command. Paths under the configured blocklist are off-limits as cwd.",
  descriptionCompressed: "Run a shell command synchronously.",
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
  ],
  validate: async () => true,
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
        message: "SHELL requires 'command' (string)",
      });
    }
    const cwdParam = readStringParam(options, "cwd");

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
    if (!sandbox || !session) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    let cwd: string;
    if (cwdParam) {
      const v = await sandbox.validatePath(conversationId, cwdParam);
      if (v.ok === false) {
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
      "CODING_TOOLS_SHELL_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const timeout = clampTimeout(
      readNumberParam(options, "timeout"),
      defaultTimeout,
    );

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SHELL cwd=${cwd} timeout=${timeout}ms`,
    );

    const startedAt = Date.now();
    const mode = resolveRuntimeExecutionMode(runtime);
    if (mode === "cloud") {
      coreLogger.error(
        `${CODING_TOOLS_LOG_PREFIX} SHELL cloud-mode denied: local exec disabled`,
      );
      return failureToActionResult(
        {
          reason: "internal",
          message: "Local shell execution disabled in cloud mode.",
        },
        { cwd },
      );
    }

    coreLogger.info(
      `${CODING_TOOLS_LOG_PREFIX} SHELL mode=${mode} cwd=${cwd}`,
    );

    let result: ShellResult;
    try {
      result = await runShell(runtime, { command, cwd, timeoutMs: timeout });
    } catch (err) {
      const message = (err as Error).message;
      coreLogger.error(`${CODING_TOOLS_LOG_PREFIX} SHELL dispatch failed: ${message}`);
      return failureToActionResult({ reason: "internal", message }, { cwd });
    }

    const took = Date.now() - startedAt;
    const timedOut = result.timedOut;
    const signal = result.signal;
    const head = timedOut
      ? `$ ${command}\n[timeout ${timeout}ms] (cwd=${cwd}, took=${took}ms)`
      : `$ ${command}\n[exit ${result.exitCode}] (cwd=${cwd}, took=${took}ms)`;
    const streams = formatStreams(result.stdout, result.stderr);
    const text = streams.length > 0 ? `${head}\n${streams}` : head;

    if (callback) await callback({ text, source: "coding-tools" });

    if (timedOut) {
      return failureToActionResult(
        { reason: "timeout", message: `command timed out after ${timeout}ms` },
        { cwd, output: text },
      );
    }
    if (result.exitCode !== 0) {
      return failureToActionResult(
        {
          reason: "command_failed",
          message: `command exited with code ${result.exitCode}`,
        },
        { exit_code: result.exitCode, cwd, output: text },
      );
    }
    return successActionResult(text, {
      exit_code: result.exitCode,
      cwd,
      execution_route: result.sandbox === "host" ? "host" : "sandbox",
      sandbox_backend: result.sandbox,
      signal,
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Run `git status` in the current repo.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ git status\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Plain shell command request maps to SHELL with command='git status' in the session cwd.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Build the project: run `bun run build` with a 5-minute timeout.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ bun run build\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Long-running build maps to SHELL with command and timeout=300000 to fit the 5-minute window.",
        },
      },
    ],
  ],
};
