import { spawn } from "node:child_process";
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

interface BashRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<BashRunResult> {
  return new Promise((resolve) => {
    const proc = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STREAM_CAP_CHARS * 2) {
        stdout += chunk.toString("utf8");
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_CAP_CHARS * 2) {
        stderr += chunk.toString("utf8");
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 1500);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      stderr += `\n${err.message}`;
      resolve({ exitCode: -1, signal: null, stdout, stderr, timedOut });
    });
  });
}

export const bashAction: Action = {
  name: "BASH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  roleGate: { minRole: "OWNER" },
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["SHELL", "EXEC", "RUN_COMMAND"],
  description:
    "Execute a shell command via /bin/bash -c <command>. Runs synchronously in the session cwd by default. Returns stdout, stderr, and exit code. Hard timeout kills the command. Paths under the configured blocklist are off-limits as cwd.",
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
        message: "BASH requires 'command' (string)",
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
      "CODING_TOOLS_BASH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const timeout = clampTimeout(
      readNumberParam(options, "timeout"),
      defaultTimeout,
    );

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} BASH cwd=${cwd} timeout=${timeout}ms`,
    );

    const startedAt = Date.now();
    const result = await runBash(command, cwd, timeout);
    const took = Date.now() - startedAt;
    const head = result.timedOut
      ? `$ ${command}\n[timeout ${timeout}ms] (cwd=${cwd}, took=${took}ms)`
      : `$ ${command}\n[exit ${result.exitCode ?? -1}] (cwd=${cwd}, took=${took}ms)`;
    const streams = formatStreams(result.stdout, result.stderr);
    const text = streams.length > 0 ? `${head}\n${streams}` : head;

    if (callback) await callback({ text, source: "coding-tools" });

    if (result.timedOut) {
      return failureToActionResult(
        { reason: "timeout", message: `command timed out after ${timeout}ms` },
        { cwd, output: text },
      );
    }
    if ((result.exitCode ?? -1) !== 0) {
      return failureToActionResult(
        {
          reason: "command_failed",
          message: `command exited with code ${result.exitCode ?? -1}`,
        },
        { exit_code: result.exitCode ?? -1, cwd, output: text },
      );
    }
    return successActionResult(text, {
      exit_code: result.exitCode ?? 0,
      cwd,
    });
  },
};
