/**
 * Native ACPX task-agent tools for the native-reasoning loop.
 *
 * These thin-wrap @0xsolace/plugin-acpx's AcpService directly so the
 * native-reasoning registry can dispatch subagent work without going through
 * Eliza's separate action-selection pipeline.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  NativeTool,
  NativeToolHandler,
  ToolHandlerResult,
} from "../tool-schema.js";

export interface SpawnAgentInput {
  agent?: string;
  cwd?: string;
  prompt: string;
}

export interface SessionsSpawnInput {
  agent?: string;
  cwd?: string;
  initial_prompt: string;
  name?: string;
}

interface AcpSpawnResult {
  sessionId: string;
  id?: string;
  name?: string;
  agentType?: string;
  workdir: string;
  status?: string;
}

interface AcpPromptResult {
  sessionId: string;
  response?: string;
  finalText?: string;
  stopReason?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

interface AcpServiceLike {
  spawnSession(opts: {
    name?: string;
    agentType?: string;
    workdir?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<AcpSpawnResult>;
  sendPrompt(
    sessionId: string,
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<AcpPromptResult>;
  closeSession?(sessionId: string): Promise<void>;
  onSessionEvent?(
    handler: (sessionId: string, event: string, data: unknown) => void,
  ): () => void;
}

const DEFAULT_AGENT = "codex";
const DEFAULT_WORKDIR_ROOT = "/workspace/tasks";
const DEFAULT_TIMEOUT_MS = 600_000;
const CLOSE_TIMEOUT_MS = 20_000;

export const spawnAgentTool: NativeTool = {
  type: "custom",
  name: "spawn_agent",
  description:
    "Spawn a one-shot codex/acpx subagent in a fresh workspace. PREFER THIS for any multi-step coding task, file creation across multiple files, repo investigation, tests, refactors, or reasoning that benefits from a clean context. Use instead of bash for anything more complex than a single command. Returns JSON with sessionId, workdir, response, durationMs, and stopReason.",
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "acpx-compatible agent to run (default: codex).",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the subagent. Defaults to a fresh directory under /workspace/tasks.",
      },
      prompt: {
        type: "string",
        description: "Initial prompt/task to send to the subagent.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export const sessionsSpawnTool: NativeTool = {
  type: "custom",
  name: "sessions_spawn",
  description:
    "Create a persistent codex/acpx subagent session you can keep messaging. PREFER THIS for ongoing collaboration with a subagent across multiple turns, long investigations, or tasks where the same agent context should stay available. Returns JSON with sessionId, workdir, response, name, durationMs, and stopReason.",
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "acpx-compatible agent to run (default: codex).",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the session. Defaults to a fresh directory under /workspace/tasks.",
      },
      initial_prompt: {
        type: "string",
        description: "Initial prompt/task to send to the persistent session.",
      },
      name: {
        type: "string",
        description: "Optional human-readable session name.",
      },
    },
    required: ["initial_prompt"],
    additionalProperties: false,
  },
};

export const createTaskTool: NativeTool = {
  ...sessionsSpawnTool,
  name: "create_task",
  description:
    "Alias for sessions_spawn: create a persistent codex/acpx subagent task session you can keep messaging later. Prefer sessions_spawn in new prompts; this alias exists for compatibility with CREATE_TASK wording.",
};

export const spawnAgentHandler: NativeToolHandler = async (
  rawInput,
  runtime,
  message,
) => {
  const input = (rawInput ?? {}) as Partial<SpawnAgentInput>;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return safeError("'prompt' is required and must be a non-empty string");
  }
  return runAcpPrompt({
    runtime,
    message,
    toolName: "spawn_agent",
    agent: input.agent,
    cwd: input.cwd,
    prompt: input.prompt,
    persistent: false,
  });
};

export const sessionsSpawnHandler: NativeToolHandler = async (
  rawInput,
  runtime,
  message,
) => {
  const input = (rawInput ?? {}) as Partial<SessionsSpawnInput>;
  if (
    typeof input.initial_prompt !== "string" ||
    input.initial_prompt.trim().length === 0
  ) {
    return safeError(
      "'initial_prompt' is required and must be a non-empty string",
    );
  }
  return runAcpPrompt({
    runtime,
    message,
    toolName: "sessions_spawn",
    agent: input.agent,
    cwd: input.cwd,
    prompt: input.initial_prompt,
    name: input.name,
    persistent: true,
  });
};

export const createTaskHandler: NativeToolHandler = async (
  rawInput,
  runtime,
  message,
) => {
  const result = await sessionsSpawnHandler(rawInput, runtime, message);
  if (!result.is_error) {
    return {
      ...result,
      content: result.content.replace(
        '"tool":"sessions_spawn"',
        '"tool":"create_task"',
      ),
    };
  }
  return result;
};

async function runAcpPrompt(opts: {
  runtime: IAgentRuntime;
  message: Memory;
  toolName: "spawn_agent" | "sessions_spawn";
  agent?: string;
  cwd?: string;
  prompt: string;
  name?: string;
  persistent: boolean;
}): Promise<ToolHandlerResult> {
  const startedAt = Date.now();
  const logger = runtimeLogger(opts.runtime);
  logger.info?.(`[NativeRegistry] ${opts.toolName} invoked`, {
    agent: opts.agent ?? DEFAULT_AGENT,
    cwd: opts.cwd,
    promptLength: opts.prompt.length,
    name: opts.name,
    persistent: opts.persistent,
  });

  try {
    const service = getAcpService(opts.runtime);
    if (!service) {
      return safeError(
        "AcpService is not available via ACP_SUBPROCESS_SERVICE/PTY_SERVICE",
      );
    }

    const timeoutMs = getPromptTimeoutMs(opts.runtime);
    const agentType = clean(opts.agent) ?? DEFAULT_AGENT;
    const workdir = clean(opts.cwd) ?? generateDefaultWorkdir(opts.runtime);
    const name =
      clean(opts.name) ?? `${opts.toolName}-${randomUUID().slice(0, 8)}`;

    logger.info?.("[AcpService] spawnSession via native-reasoning", {
      tool: opts.toolName,
      agentType,
      workdir,
      name,
    });

    const session = await service.spawnSession({
      agentType,
      workdir,
      name,
      timeoutMs,
      metadata: {
        source: `native-reasoning:${opts.toolName}`,
        messageId: opts.message?.id,
        roomId: opts.message?.roomId,
        worldId: opts.message?.worldId,
        userId: opts.message?.entityId,
        persistent: opts.persistent,
      },
    });

    const tracker = createTaskCompleteTracker(service, session.sessionId);
    const promptResult = await withTimeout(
      service.sendPrompt(session.sessionId, opts.prompt, { timeoutMs }),
      timeoutMs + 5_000,
      `timed out waiting for AcpService.sendPrompt after ${timeoutMs}ms`,
    );
    const eventResult = await tracker.wait(1_500);
    tracker.dispose();

    if (!opts.persistent && typeof service.closeSession === "function") {
      void withTimeout(
        service.closeSession(session.sessionId),
        CLOSE_TIMEOUT_MS,
        `timed out closing ${session.sessionId}`,
      ).catch((err) =>
        logger.warn?.("[NativeRegistry] spawn_agent closeSession failed", {
          sessionId: session.sessionId,
          error: errMsg(err),
        }),
      );
    }

    const response =
      eventResult.response ??
      promptResult.response ??
      promptResult.finalText ??
      "";
    const stopReason =
      eventResult.stopReason ?? promptResult.stopReason ?? "unknown";
    const durationMs = promptResult.durationMs ?? Date.now() - startedAt;
    const error = eventResult.error ?? promptResult.error;

    const payload = {
      tool: opts.toolName,
      sessionId: session.sessionId,
      workdir: session.workdir ?? workdir,
      response,
      durationMs,
      stopReason,
      ...(opts.persistent ? { name } : {}),
      ...(error ? { error } : {}),
    };

    logger.info?.(`[NativeRegistry] ${opts.toolName} completed`, {
      sessionId: session.sessionId,
      workdir: payload.workdir,
      durationMs,
      stopReason,
      hasResponse: response.length > 0,
      error,
    });

    return {
      content: JSON.stringify(payload, null, 2),
      is_error: Boolean(error) || stopReason === "error",
    };
  } catch (err) {
    logger.error?.(`[NativeRegistry] ${opts.toolName} failed`, {
      error: errMsg(err),
    });
    return safeError(errMsg(err));
  }
}

function getAcpService(runtime: IAgentRuntime): AcpServiceLike | undefined {
  const getter = (runtime as { getService?: (name: string) => unknown })
    .getService;
  if (typeof getter !== "function") return undefined;
  for (const name of ["ACP_SUBPROCESS_SERVICE", "PTY_SERVICE", "ACP_SERVICE"]) {
    const service = getter.call(runtime, name);
    const candidate = Array.isArray(service) ? service[0] : service;
    if (
      candidate &&
      typeof (candidate as AcpServiceLike).spawnSession === "function" &&
      typeof (candidate as AcpServiceLike).sendPrompt === "function"
    ) {
      return candidate as AcpServiceLike;
    }
  }
  return undefined;
}

function createTaskCompleteTracker(service: AcpServiceLike, sessionId: string) {
  let response: string | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;
  let done = false;
  let resolveWait: (() => void) | undefined;
  const unsubscribe = service.onSessionEvent?.((sid, event, data) => {
    if (sid !== sessionId) return;
    const payload = asRecord(data);
    if (event === "task_complete") {
      response =
        typeof payload.response === "string" ? payload.response : response;
      stopReason =
        typeof payload.stopReason === "string"
          ? payload.stopReason
          : stopReason;
      done = true;
      resolveWait?.();
    } else if (event === "error") {
      error = typeof payload.message === "string" ? payload.message : "unknown";
      done = true;
      resolveWait?.();
    } else if (event === "stopped" && !done) {
      response =
        typeof payload.response === "string" ? payload.response : response;
      done = true;
      resolveWait?.();
    }
  });

  return {
    wait(ms: number): Promise<{
      response?: string;
      stopReason?: string;
      error?: string;
    }> {
      if (done) return Promise.resolve({ response, stopReason, error });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ response, stopReason, error });
        }, ms);
        resolveWait = () => {
          clearTimeout(timer);
          resolve({ response, stopReason, error });
        };
      });
    },
    dispose(): void {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    },
  };
}

function getPromptTimeoutMs(runtime: IAgentRuntime): number {
  const fromRuntime = (
    runtime as { getSetting?: (key: string) => string | undefined }
  ).getSetting?.("ELIZA_ACP_PROMPT_TIMEOUT_MS");
  const raw = fromRuntime ?? process.env.ELIZA_ACP_PROMPT_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_TIMEOUT_MS;
}

function generateDefaultWorkdir(
  runtime: IAgentRuntime,
  now: Date = new Date(),
): string {
  const fromRuntime = (
    runtime as { getSetting?: (key: string) => string | undefined }
  ).getSetting?.("ELIZA_ACP_WORKSPACE_ROOT");
  const root =
    fromRuntime ?? process.env.ELIZA_ACP_WORKSPACE_ROOT ?? DEFAULT_WORKDIR_ROOT;
  const ts =
    `${now.getUTCFullYear()}` +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "-" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  return path.posix.join(root, `${ts}-${randomUUID().slice(0, 8)}`);
}

function safeError(reason: string): ToolHandlerResult {
  return {
    content: JSON.stringify({ error: reason }, null, 2),
    is_error: true,
  };
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeLogger(runtime: IAgentRuntime): {
  info?: (message: string, data?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
  error?: (message: string, data?: unknown) => void;
} {
  const candidate = (runtime as { logger?: unknown }).logger;
  if (candidate && typeof candidate === "object") return candidate;
  return console;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
