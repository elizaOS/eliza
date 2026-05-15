import * as fs from "node:fs/promises";
import {
  type Action,
  type ActionResult,
  CANONICAL_SUBACTION_KEY,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import {
  failureToActionResult,
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
  truncate,
} from "../lib/format.js";
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
const SHELL_HISTORY_DEFAULT_LIMIT = 20;
const URL_PREFIXES = ["https://", "http://"] as const;
const SHELL_URL_METACHARS = new Set(["&", ";", "(", ")", "<", ">", "|"]);

type ShellActionSubaction = "run" | "clear_history" | "view_history";

type ShellHistoryEntryLike = {
  command?: unknown;
};

type ShellHistoryServiceLike = {
  clearCommandHistory?: (conversationId: string) => void;
  getCommandHistory?: (
    conversationId: string,
    limit?: number,
  ) => ShellHistoryEntryLike[];
};

function normalizeShellSubaction(
  value: string | undefined,
): ShellActionSubaction {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "clear":
    case "clear_history":
    case "history_clear":
      return "clear_history";
    case "view":
    case "show":
    case "list":
    case "view_history":
    case "show_history":
    case "list_history":
    case "history_view":
      return "view_history";
    default:
      return "run";
  }
}

function inferShellSubactionFromText(
  text: string,
): ShellActionSubaction | null {
  const lower = text.toLowerCase();
  if (!/\b(history|terminal|shell|command)\b/.test(lower)) return null;
  if (/\b(show|view|list|display|print)\b/.test(lower)) return "view_history";
  if (/\b(clear|reset|delete|remove|clean|wipe)\b/.test(lower)) {
    return "clear_history";
  }
  return null;
}

function getShellHistoryService(
  runtime: IAgentRuntime,
): ShellHistoryServiceLike | null {
  const service = runtime.getService("shell") as unknown;
  return service && typeof service === "object" ? service : null;
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Math.floor(value)));
}

function clampHistoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SHELL_HISTORY_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function hasUnescapedShellUrlMetachar(token: string): boolean {
  let escaped = false;
  for (const char of token) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (SHELL_URL_METACHARS.has(char)) return true;
  }
  return false;
}

function shellSingleQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

function quoteBareUrlsWithShellMetacharacters(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (escaped) {
      out += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      out += char;
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    const prefix = URL_PREFIXES.find((candidate) =>
      command.startsWith(candidate, index),
    );
    if (!prefix) {
      out += char;
      index += 1;
      continue;
    }

    let end = index + prefix.length;
    while (end < command.length) {
      const next = command[end];
      if (/\s/.test(next) || next === "'" || next === '"') break;
      end += 1;
    }

    const token = command.slice(index, end);
    out += hasUnescapedShellUrlMetachar(token)
      ? shellSingleQuote(token)
      : token;
    index = end;
  }

  return out;
}

function formatStreams(
  stdout: string,
  stderr: string,
  options: { showEmptyStreams?: boolean } = {},
): string {
  const sOut = truncate(stdout, STREAM_CAP_CHARS);
  const sErr = truncate(stderr, STREAM_CAP_CHARS);
  const lines: string[] = [];
  if (sOut.text.length > 0 || options.showEmptyStreams) {
    lines.push("--- stdout ---");
    lines.push(sOut.text.length > 0 ? sOut.text : "(empty)");
  }
  if (sErr.text.length > 0 || options.showEmptyStreams) {
    lines.push("--- stderr ---");
    lines.push(sErr.text.length > 0 ? sErr.text : "(empty)");
  }
  return lines.join("\n");
}

export const shellAction: Action = {
  name: "SHELL",
  contexts: [...CODING_TOOLS_CONTEXTS],
  roleGate: { minRole: "OWNER" },
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["BASH", "EXEC", "RUN_COMMAND"],
  description:
    "Shell action. action=run executes command via local shell. action=clear_history clears conversation command history. action=view_history returns recent commands. command required only for run. Prefer bounded commands; avoid recursive whole-filesystem scans unless explicitly requested. For JSON API inspection, prefer jq or node; if Python is needed, call python3 rather than assuming a python alias exists. If a command exits 0 with empty stdout/stderr, the command produced no output; try another source or parser when data is still needed instead of claiming the shell did not return output. For disk checks, use df for every requested mount/path (for root plus home: df -h / /home) plus targeted du on likely cleanup directories; when asked for cleanup candidates, inspect one readable largest directory one level deeper before ranking candidates. Use separators that still allow later inspection commands to run when du hits expected permission-denied paths.",
  descriptionCompressed: "Run shell commands; clear/view shell history.",
  parameters: [
    {
      name: "action",
      description: "Shell operation: run | clear_history | view_history.",
      required: false,
      schema: {
        type: "string",
        enum: ["run", "clear_history", "view_history"],
      },
    },
    {
      name: "command",
      description:
        "For action=run: shell command, executed via /bin/bash -c. Keep routine inspection commands bounded; avoid broad scans like du -sh /* when a targeted path is enough. For JSON API data, prefer jq or node; use python3, not python, unless the environment explicitly shows python exists. If stdout/stderr are marked empty, the command produced no output; try a different command/source when the user still needs a value. Include every requested path in df, e.g. df -h / /home. For cleanup candidates, follow the first bounded du result with a targeted du on the largest readable directory before answering; avoid && between du probes when permission-denied paths are expected.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "5-10 word human-readable command summary.",
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
        "Absolute cwd; must not resolve under blocked path. Default session cwd.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "For action=view_history: max recorded commands.",
      required: false,
      schema: { type: "number" },
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
    const explicitSubaction = readStringParam(options, "action");
    const inferredSubaction = inferShellSubactionFromText(
      message.content.text ?? "",
    );
    const subaction = explicitSubaction
      ? normalizeShellSubaction(explicitSubaction)
      : (inferredSubaction ?? "run");

    if (subaction === "clear_history" || subaction === "view_history") {
      const shellHistoryService = getShellHistoryService(runtime);
      if (!shellHistoryService) {
        return failureToActionResult({
          reason: "internal",
          message: "Shell history service unavailable.",
        });
      }
      const conversationId = message.roomId || message.agentId;
      if (!conversationId) {
        return failureToActionResult({
          reason: "missing_param",
          message: "no conversation id",
        });
      }
      if (subaction === "clear_history") {
        if (typeof shellHistoryService.clearCommandHistory !== "function") {
          return failureToActionResult({
            reason: "internal",
            message: "Shell history clearing is unavailable.",
          });
        }
        shellHistoryService.clearCommandHistory(String(conversationId));
        const text = "Shell command history has been cleared.";
        if (callback) await callback({ text, source: "coding-tools" });
        return successActionResult(text, {
          actionName: "SHELL",
          [CANONICAL_SUBACTION_KEY]: "clear_history",
        });
      }

      if (typeof shellHistoryService.getCommandHistory !== "function") {
        return failureToActionResult({
          reason: "internal",
          message: "Shell history reading is unavailable.",
        });
      }
      const limit = clampHistoryLimit(readNumberParam(options, "limit"));
      const entries = shellHistoryService.getCommandHistory(
        String(conversationId),
        limit,
      );
      const lines = entries.length
        ? entries
            .map((entry, index) => {
              const command =
                typeof entry.command === "string"
                  ? entry.command
                  : JSON.stringify(entry);
              return `${index + 1}. ${command}`;
            })
            .join("\n")
        : "(no shell history recorded for this conversation)";
      const text = `Shell command history (last ${entries.length}):\n${lines}`;
      if (callback) await callback({ text, source: "coding-tools" });
      return successActionResult(text, {
        actionName: "SHELL",
        [CANONICAL_SUBACTION_KEY]: "view_history",
        entryCount: entries.length,
      });
    }

    const rawCommand = readStringParam(options, "command");
    if (!rawCommand || rawCommand.trim().length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "SHELL requires 'command' (string)",
      });
    }
    const command = quoteBareUrlsWithShellMetacharacters(rawCommand);
    if (command !== rawCommand) {
      coreLogger.debug(
        `${CODING_TOOLS_LOG_PREFIX} SHELL quoted bare URL metacharacters before execution`,
      );
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

    let cwd = "";
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
        if (!isMissingPathError(err)) {
          return failureToActionResult({
            reason: "io_error",
            message: `cwd stat failed: ${(err as Error).message}`,
          });
        }
        cwd = session.getCwd(conversationId);
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} SHELL cwd not found; using session cwd (requested=${cwdParam}, fallback=${cwd})`,
        );
      }
      if (!cwd) cwd = v.resolved;
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

    coreLogger.info(`${CODING_TOOLS_LOG_PREFIX} SHELL mode=${mode} cwd=${cwd}`);

    let result: ShellResult;
    try {
      result = await runShell(runtime, { command, cwd, timeoutMs: timeout });
    } catch (err) {
      const message = (err as Error).message;
      coreLogger.error(
        `${CODING_TOOLS_LOG_PREFIX} SHELL dispatch failed: ${message}`,
      );
      return failureToActionResult({ reason: "internal", message }, { cwd });
    }

    const took = Date.now() - startedAt;
    const timedOut = result.timedOut;
    const signal = result.signal;
    const head = timedOut
      ? `$ ${command}\n[timeout ${timeout}ms] (cwd=${cwd}, took=${took}ms)`
      : `$ ${command}\n[exit ${result.exitCode}] (cwd=${cwd}, took=${took}ms)`;
    const streams = formatStreams(result.stdout, result.stderr, {
      showEmptyStreams: !result.stdout && !result.stderr,
    });
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
        content: {
          text: "Run `git status` in the current repo.",
          source: "chat",
        },
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
    [
      {
        name: "{{name1}}",
        content: {
          text: "Check disk space and safe cleanup candidates.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '$ df -h / /home; du -x -h --max-depth=1 /home 2>/dev/null | sort -hr | head -n 5; du -x -h --max-depth=2 "$HOME" 2>/dev/null | sort -hr | head -n 8\n[exit 0]',
          actions: ["SHELL"],
          thought:
            "Disk checks should use df for mount usage, then bounded du probes that still run after permission-denied paths and inspect the largest readable directory one level deeper before ranking cleanup candidates.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fetch a current JSON API value.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ curl -s \"https://api.example.com/status?format=json\" | jq -r '.status'\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Current JSON API checks should keep the URL quoted and parse with jq or node; do not assume a python binary exists when python3 is the portable Python command.",
        },
      },
    ],
  ],
};
