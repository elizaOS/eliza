/**
 * PTY manager initialization — extracted from PTYService.initialize().
 *
 * Creates either a BunCompatiblePTYManager (for Bun runtime) or PTYManager
 * (for Node), wires up event handlers, and returns the configured manager.
 *
 * @module services/pty-init
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AuthRequiredInfo,
  BunCompatiblePTYManager as BunCompatiblePTYManagerType,
  PTYManagerConfig,
  PTYManager as PTYManagerType,
  SessionHandle,
  SessionMessage,
  StallClassification,
  ToolRunningInfo,
  WorkerSessionHandle,
} from "pty-manager";
import type { CompletionMethod } from "./agent-metrics.js";
import { captureTaskResponse, cleanForChat } from "./ansi-utils.js";
import type { PTYServiceConfig } from "./pty-types.js";

// Stall detector silence threshold. 60s — long enough that a bash, git,
// WebSearch, or multi-step tool call can complete without tripping the
// classifier, short enough to still catch real hangs within a minute.
// Previously 4000ms, which misfired for every long tool call on claude-code
// agents and caused completion re-injection loops on open-ended tasks.
const STALL_TIMEOUT_MS = 60_000;

// Resolve absolute path to coding-agent-adapters so the Node worker process
// can load it regardless of its cwd.  The worker uses require() which does
// cwd-relative resolution — passing the bare module name "coding-agent-adapters"
// fails when the worker's cwd doesn't contain node_modules.
const _require = createRequire(import.meta.url);
const { BunCompatiblePTYManager, isBun, PTYManager, ShellAdapter } = _require(
  "pty-manager",
) as typeof import("pty-manager");
let resolvedAdapterModule = "coding-agent-adapters";
try {
  resolvedAdapterModule = _require.resolve("coding-agent-adapters");
} catch {
  // Fallback to bare specifier if resolve fails (shouldn't happen)
}
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(moduleDir, "../scripts/codex-exec-adapters.cjs"),
  path.resolve(moduleDir, "../../scripts/codex-exec-adapters.cjs"),
]) {
  if (existsSync(candidate)) {
    resolvedAdapterModule = candidate;
    break;
  }
}
const { createAllAdapters } = _require(
  resolvedAdapterModule,
) as typeof import("coding-agent-adapters");
let resolvedPtyWorkerPath: string | undefined;
try {
  resolvedPtyWorkerPath = _require.resolve("pty-manager/worker");
} catch {
  resolvedPtyWorkerPath = undefined;
}

function resolveNodeWorkerPath(): string {
  const explicitCandidates = [
    process.env.NODE,
    process.env.NODE_BINARY,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of explicitCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const nvmVersionsDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    const versions = readdirSync(nvmVersionsDir)
      .filter((entry) => entry.startsWith("v"))
      .sort((a, b) =>
        b.localeCompare(a, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    for (const version of versions) {
      const candidate = path.join(nvmVersionsDir, version, "bin", "node");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "node";
}

/**
 * All callbacks and state that the initialization logic needs
 * from the surrounding PTYService instance.
 */
export interface InitContext {
  serviceConfig: PTYServiceConfig;
  classifyStall: (
    sessionId: string,
    recentOutput: string,
  ) => Promise<StallClassification | null>;
  emitEvent: (sessionId: string, event: string, data: unknown) => void;
  handleGeminiAuth: (sessionId: string) => void;
  sessionMetadata: Map<string, Record<string, unknown>>;
  sessionOutputBuffers: Map<string, string[]>;
  taskResponseMarkers: Map<string, number>;
  metricsTracker: {
    recordCompletion(
      type: string,
      method: CompletionMethod,
      durationMs: number,
    ): void;
  };
  traceEntries: Array<string | Record<string, unknown>>;
  maxTraceEntries: number;
  log: (msg: string) => void;
  handleWorkerExit?: (info: {
    code: number | null;
    signal: string | null;
  }) => void;
  /** Check if a session has an active task in the coordinator. */
  hasActiveTask?: (sessionId: string) => boolean;
  /** Check if a session's task has started work (task delivered or decisions made). */
  hasTaskActivity?: (sessionId: string) => boolean;
  /** Mark a session's task as delivered (initial ready event processed). */
  markTaskDelivered?: (sessionId: string) => void;
}

async function readCodexExecOutputFile(
  ctx: InitContext,
  sessionId: string,
  outputFile: string,
): Promise<string> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fromFile = cleanForChat(await readFile(outputFile, "utf8"));
      if (fromFile.trim()) {
        return fromFile.trim();
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") {
        ctx.log(
          `Failed to read Codex exec output file for ${sessionId}: ${error}`,
        );
        return "";
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return "";
}

async function captureFastPathTaskResponse(
  ctx: InitContext,
  sessionId: string,
): Promise<string> {
  const outputFile = ctx.sessionMetadata.get(sessionId)?.codexExecOutputFile;
  if (typeof outputFile === "string" && outputFile.trim()) {
    const fromFile = await readCodexExecOutputFile(ctx, sessionId, outputFile);
    if (fromFile) {
      return fromFile;
    }
  }

  return captureTaskResponse(
    sessionId,
    ctx.sessionOutputBuffers,
    ctx.taskResponseMarkers,
  );
}

// NOTE: A previous implementation defined `forwardReadyAsTaskComplete` here,
// which re-emitted every `session_ready` event as `task_complete` if the
// session had an active task. That was incorrect: Claude Code's TUI briefly
// enters a ready state between every tool call (after Bash, WebSearch, git,
// edit, etc.), so ready ≠ done. It caused the coordinator to run its
// turn-complete decision pipeline dozens of times per real session, each of
// which would re-inject the original prompt via "Turn done, continuing",
// creating an infinite retry loop on any long multi-step task.
//
// Task completion is now signaled authoritatively by the agent's own hook
// system, routed through pty-service.handleHookEvent. The jsonl-based
// completion watcher in the eliza package provides a defense-in-depth
// ground-truth signal. `session_ready` is still emitted for consumers that
// want to know when the PTY prompt is visible, but it is not a completion
// signal.

/** Value returned by {@link initializePTYManager}. */
export interface InitResult {
  manager: PTYManagerType | BunCompatiblePTYManagerType;
  usingBunWorker: boolean;
}

/**
 * Create and configure a PTY manager for the current runtime.
 *
 * - **Bun**: instantiates a {@link BunCompatiblePTYManager} that spawns a
 *   Node worker process and communicates via JSON-RPC over stdio.
 * - **Node**: instantiates a {@link PTYManager} directly and registers
 *   all built-in adapters in-process.
 */
export async function initializePTYManager(
  ctx: InitContext,
): Promise<InitResult> {
  const usingBunWorker = isBun();
  const recentStructuredAuth = new Map<string, number>();
  const AUTH_EVENT_DEDUPE_MS = 5_000;

  const emitStructuredAuthRequired = (
    session: { id: string; type?: string },
    info: AuthRequiredInfo,
  ): void => {
    recentStructuredAuth.set(session.id, Date.now());
    if (session.type === "gemini") {
      ctx.handleGeminiAuth(session.id);
    }
    ctx.emitEvent(session.id, "login_required", {
      instructions: info.instructions,
      url: info.url,
      deviceCode: info.deviceCode,
      method: info.method,
      promptSnippet: info.promptSnippet,
      session,
      source: "pty_manager",
    });
  };

  const shouldSuppressLegacyLoginRequired = (sessionId: string): boolean => {
    const at = recentStructuredAuth.get(sessionId);
    if (!at) return false;
    if (Date.now() - at > AUTH_EVENT_DEDUPE_MS) {
      recentStructuredAuth.delete(sessionId);
      return false;
    }
    return true;
  };

  if (usingBunWorker) {
    // Use Bun-compatible manager that spawns a Node worker
    ctx.log("Detected Bun runtime, using BunCompatiblePTYManager");
    ctx.log(`Resolved adapter module: ${resolvedAdapterModule}`);
    const bunManager = new BunCompatiblePTYManager({
      adapterModules: [resolvedAdapterModule],
      nodePath: resolveNodeWorkerPath(),
      ...(resolvedPtyWorkerPath ? { workerPath: resolvedPtyWorkerPath } : {}),
      stallDetectionEnabled: true,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      onStallClassify: async (
        sessionId: string,
        recentOutput: string,
        _stallDurationMs: number,
      ) => {
        return ctx.classifyStall(sessionId, recentOutput);
      },
    });

    // Set up event forwarding for worker-based manager. session_ready means
    // the PTY prompt is visible again — it does NOT mean the agent is done
    // (see the forwardReadyAsTaskComplete note above).
    bunManager.on("session_ready", (session: WorkerSessionHandle) => {
      ctx.log(
        `session_ready event received for ${session.id} (type: ${session.type}, status: ${session.status})`,
      );
      ctx.emitEvent(session.id, "ready", { session, source: "pty_manager" });
      ctx.markTaskDelivered?.(session.id);
    });

    const handleWorkerStopped = async (
      sessionOrId: WorkerSessionHandle | string,
      reasonOrCode?: string | number,
      signal?: string | number,
    ): Promise<void> => {
      const metadata =
        typeof sessionOrId === "string"
          ? ctx.sessionMetadata.get(sessionOrId)
          : undefined;
      const session =
        typeof sessionOrId === "string"
          ? ({
              id: sessionOrId,
              type:
                typeof metadata?.agentType === "string"
                  ? metadata.agentType
                  : "unknown",
              status: "stopped",
            } as WorkerSessionHandle)
          : sessionOrId;
      const id = session.id;
      const code =
        typeof reasonOrCode === "number"
          ? reasonOrCode
          : typeof session.exitCode === "number"
            ? session.exitCode
            : undefined;
      const reason =
        typeof reasonOrCode === "string"
          ? reasonOrCode
          : typeof code === "number"
            ? `exit code ${code}`
            : signal
              ? `signal ${String(signal)}`
              : "session stopped";
      const cleanExit = code === 0 || /\bexit code 0\b/i.test(reason);

      if (cleanExit && ctx.sessionMetadata.get(id)?.codexExecMode === true) {
        const response = await captureFastPathTaskResponse(ctx, id);
        ctx.metricsTracker.recordCompletion("codex", "fast-path", 0);
        ctx.log(
          `Task complete for ${id} (codex exec exit), response: ${response.length} chars`,
        );
        ctx.emitEvent(id, "task_complete", {
          session,
          response,
          source: "adapter_fast_path",
        });
        return;
      }

      ctx.emitEvent(id, "stopped", {
        reason,
        source: "pty_manager",
      });
    };

    bunManager.on(
      "session_stopped",
      (
        session: WorkerSessionHandle,
        reasonOrCode?: string | number,
        signal?: string | number,
      ) => {
        void handleWorkerStopped(session, reasonOrCode, signal);
      },
    );

    // Older pty-manager builds exposed this event name.
    bunManager.on("session_exit", (id: string, code: number) => {
      void handleWorkerStopped(id, code);
    });

    bunManager.on("session_error", (id: string, error: string) => {
      ctx.emitEvent(id, "error", { message: error, source: "pty_manager" });
    });

    bunManager.on(
      "blocking_prompt",
      (
        session: WorkerSessionHandle,
        promptInfo: unknown,
        autoResponded: boolean,
      ) => {
        const info = promptInfo as
          | { type?: string; prompt?: string }
          | undefined;
        ctx.log(
          `blocking_prompt for ${session.id}: type=${info?.type}, autoResponded=${autoResponded}, prompt="${(info?.prompt ?? "").slice(0, 80)}"`,
        );
        ctx.emitEvent(session.id, "blocked", {
          promptInfo,
          autoResponded,
          source: "pty_manager",
        });
      },
    );

    bunManager.on(
      "auth_required",
      (session: WorkerSessionHandle, info: AuthRequiredInfo) => {
        emitStructuredAuthRequired(session, info);
      },
    );

    bunManager.on(
      "login_required",
      (session: WorkerSessionHandle, instructions?: string, url?: string) => {
        if (shouldSuppressLegacyLoginRequired(session.id)) {
          return;
        }
        // Auto-handle Gemini auth flow
        if (session.type === "gemini") {
          ctx.handleGeminiAuth(session.id);
        }
        ctx.emitEvent(session.id, "login_required", {
          instructions,
          url,
          source: "pty_manager",
        });
      },
    );

    bunManager.on("task_complete", async (session: WorkerSessionHandle) => {
      const response = await captureFastPathTaskResponse(ctx, session.id);
      const durationMs = session.startedAt
        ? Date.now() - new Date(session.startedAt).getTime()
        : 0;
      ctx.metricsTracker.recordCompletion(
        session.type,
        "fast-path",
        durationMs,
      );
      ctx.log(
        `Task complete for ${session.id} (adapter fast-path), response: ${response.length} chars`,
      );
      ctx.emitEvent(session.id, "task_complete", {
        session,
        response,
        source: "adapter_fast_path",
      });
    });

    bunManager.on(
      "tool_running",
      (session: WorkerSessionHandle, info: ToolRunningInfo) => {
        ctx.log(
          `tool_running for ${session.id}: ${info.toolName}${info.description ? ` — ${info.description}` : ""}`,
        );
        ctx.emitEvent(session.id, "tool_running", {
          session,
          ...info,
          source: "pty_manager",
        });
      },
    );

    bunManager.on("message", (message: SessionMessage) => {
      ctx.emitEvent(message.sessionId, "message", {
        ...message,
        source: "pty_manager",
      });
    });

    // Log worker-level stderr (pino logs from pty-manager worker process).
    // Strip the "Invalid JSON from worker:" prefix that BunCompatiblePTYManager
    // adds when stderr lines aren't valid JSON-RPC responses.
    bunManager.on("worker_error", (err: unknown) => {
      const raw = typeof err === "string" ? err : String(err);
      const msg = raw.replace(/^Invalid JSON from worker:\s*/i, "").trim();
      if (!msg) return;
      // Capture task completion trace entries for timeline analysis
      if (msg.includes("Task completion trace")) {
        ctx.traceEntries.push(msg);
        if (ctx.traceEntries.length > ctx.maxTraceEntries) {
          ctx.traceEntries.splice(
            0,
            ctx.traceEntries.length - ctx.maxTraceEntries,
          );
        }
      }
      // Show operational logs at info level (suppress noisy loading-suppression messages)
      if (msg.includes("suppressing stall emission")) {
        // Loading pattern suppression fires every few seconds — too noisy for console
        return;
      }
      if (
        msg.includes("ready") ||
        msg.includes("blocking") ||
        msg.includes("auto-response") ||
        msg.includes("Auto-responding") ||
        msg.includes("detectReady") ||
        msg.includes("stall") ||
        msg.includes("Stall") ||
        msg.includes("Task completion") ||
        msg.includes("Spawning") ||
        msg.includes("PTY session")
      ) {
        console.log("[PTYService/Worker]", msg);
      } else {
        console.error("[PTYService/Worker]", msg.slice(0, 200));
      }
    });

    bunManager.on(
      "worker_exit",
      (info: { code: number | null; signal: string | null }) => {
        ctx.handleWorkerExit?.(info);
        console.error("[PTYService] Worker exited:", info);
      },
    );

    await bunManager.waitForReady();
    return { manager: bunManager, usingBunWorker: true };
  }

  // Use native PTYManager directly in Node
  ctx.log("Using native PTYManager");
  const managerConfig: PTYManagerConfig = {
    maxLogLines: ctx.serviceConfig.maxLogLines,
    stallDetectionEnabled: true,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    onStallClassify: async (
      sessionId: string,
      recentOutput: string,
      _stallDurationMs: number,
    ) => {
      return ctx.classifyStall(sessionId, recentOutput);
    },
  };

  const nodeManager = new PTYManager(managerConfig);

  // Register built-in adapters
  nodeManager.registerAdapter(new ShellAdapter());

  // Register coding agent adapters (claude, gemini, codex, aider).
  // Pi currently routes through the generic shell adapter.
  if (ctx.serviceConfig.registerCodingAdapters) {
    const codingAdapters = createAllAdapters();
    for (const adapter of codingAdapters) {
      nodeManager.registerAdapter(adapter);
      ctx.log(`Registered ${adapter.adapterType} adapter`);
    }
  }

  // Set up event forwarding. session_ready means the PTY prompt is visible
  // again — NOT that the agent is done (see the forwardReadyAsTaskComplete
  // note above).
  nodeManager.on("session_ready", (session: SessionHandle) => {
    ctx.emitEvent(session.id, "ready", { session, source: "pty_manager" });
    ctx.markTaskDelivered?.(session.id);
  });

  nodeManager.on(
    "blocking_prompt",
    (session: SessionHandle, promptInfo: unknown, autoResponded: boolean) => {
      ctx.emitEvent(session.id, "blocked", {
        promptInfo,
        autoResponded,
        source: "pty_manager",
      });
    },
  );

  nodeManager.on(
    "auth_required",
    (session: SessionHandle, info: AuthRequiredInfo) => {
      emitStructuredAuthRequired(session, info);
    },
  );

  nodeManager.on(
    "login_required",
    (session: SessionHandle, instructions?: string, url?: string) => {
      if (shouldSuppressLegacyLoginRequired(session.id)) {
        return;
      }
      if (session.type === "gemini") {
        ctx.handleGeminiAuth(session.id);
      }
      ctx.emitEvent(session.id, "login_required", {
        instructions,
        url,
        source: "pty_manager",
      });
    },
  );

  nodeManager.on("task_complete", async (session: SessionHandle) => {
    const response = await captureFastPathTaskResponse(ctx, session.id);
    const durationMs = session.startedAt
      ? Date.now() - new Date(session.startedAt).getTime()
      : 0;
    ctx.metricsTracker.recordCompletion(session.type, "fast-path", durationMs);
    ctx.log(
      `Task complete for ${session.id} (adapter fast-path), response: ${response.length} chars`,
    );
    ctx.emitEvent(session.id, "task_complete", {
      session,
      response,
      source: "adapter_fast_path",
    });
  });

  nodeManager.on(
    "tool_running",
    (session: SessionHandle, info: ToolRunningInfo) => {
      ctx.log(
        `tool_running for ${session.id}: ${info.toolName}${info.description ? ` — ${info.description}` : ""}`,
      );
      ctx.emitEvent(session.id, "tool_running", {
        session,
        ...info,
        source: "pty_manager",
      });
    },
  );

  nodeManager.on(
    "session_stopped",
    async (session: SessionHandle, reason: string) => {
      const stoppedCleanly =
        (session as { exitCode?: number }).exitCode === 0 ||
        /exit code 0/i.test(reason);
      if (
        session.type === "codex" &&
        ctx.sessionMetadata.get(session.id)?.codexExecMode === true &&
        stoppedCleanly
      ) {
        const response = await captureFastPathTaskResponse(ctx, session.id);
        const durationMs = session.startedAt
          ? Date.now() - new Date(session.startedAt).getTime()
          : 0;
        ctx.metricsTracker.recordCompletion("codex", "fast-path", durationMs);
        ctx.log(
          `Task complete for ${session.id} (codex exec stopped), response: ${response.length} chars`,
        );
        ctx.emitEvent(session.id, "task_complete", {
          session,
          response,
          source: "adapter_fast_path",
        });
        return;
      }
      ctx.emitEvent(session.id, "stopped", { reason, source: "pty_manager" });
    },
  );

  nodeManager.on("session_error", (session: SessionHandle, error: string) => {
    ctx.emitEvent(session.id, "error", {
      message: error,
      source: "pty_manager",
    });
  });

  nodeManager.on("message", (message: SessionMessage) => {
    ctx.emitEvent(message.sessionId, "message", {
      ...message,
      source: "pty_manager",
    });
  });

  return { manager: nodeManager, usingBunWorker: false };
}
