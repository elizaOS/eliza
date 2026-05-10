/**
 * Enhanced Shell Service with PTY, background execution, and session management
 * Migrated from otto bash-tools.exec.ts, bash-tools.process.ts
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import spawn from "cross-spawn";
import type {
  CommandHistoryEntry,
  CommandResult,
  ExecResult,
  ExecuteOptions,
  FileOperation,
  FileOperationType,
  FinishedSession,
  ProcessActionParams,
  ProcessSession,
  PtyHandle,
  PtySpawn,
  ShellConfig,
} from "../types";
import { isForbiddenCommand, isSafeCommand, loadShellConfig, validatePath } from "../utils";
import {
  buildCursorPositionResponse,
  encodeKeySequence,
  encodePaste,
  stripDsrRequests,
} from "../utils/ptyKeys";
import {
  chunkString,
  clampNumber,
  coerceEnv,
  deriveSessionName,
  formatDuration,
  getShellConfig,
  killSession,
  pad,
  readEnvInt,
  resolveWorkdir,
  sanitizeBinaryOutput,
  sliceLogLines,
  truncateMiddle,
} from "../utils/shellUtils";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
} from "./processRegistry";
import { isCloudExecutionMode, shouldUseSandboxExecution } from "@elizaos/shared";

const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("SHELL_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000
);
const DEFAULT_PENDING_MAX_OUTPUT = clampNumber(
  readEnvInt("SHELL_PENDING_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000
);
const DEFAULT_BACKGROUND_MS = clampNumber(readEnvInt("SHELL_BACKGROUND_MS"), 10_000, 10, 120_000);
const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes

interface RuntimeSandboxManager {
  getState?: () => string;
  isReady?: () => boolean;
  start?: () => Promise<void>;
  exec: (options: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
  }) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    executedInSandbox: boolean;
  }>;
}

export class ShellService extends Service {
  public static serviceType = "shell";
  private shellConfig: ShellConfig;
  private currentDirectory: string;
  private commandHistory: Map<string, CommandHistoryEntry[]>;
  private maxHistoryPerConversation = 100;
  private scopeKey?: string;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.shellConfig = loadShellConfig();
    this.currentDirectory = this.shellConfig.allowedDirectory;
    this.commandHistory = new Map();
  }

  static async start(runtime: IAgentRuntime): Promise<ShellService> {
    const instance = new ShellService(runtime);
    logger.info("Shell service initialized with PTY, background execution, and history tracking");
    return instance;
  }

  async stop(): Promise<void> {
    // Clean up all running sessions by killing their processes
    const runningSessions = listRunningSessions();
    for (const session of runningSessions) {
      try {
        killSession(session);
        logger.debug(`Killed shell session: ${session.id}`);
      } catch (err) {
        logger.warn(`Failed to kill shell session ${session.id}: ${err}`);
      }
    }

    // Clear command history
    this.commandHistory.clear();

    logger.info(`Shell service stopped, cleaned up ${runningSessions.length} running sessions`);
  }

  get capabilityDescription(): string {
    return "Execute shell commands with PTY support, background execution, and session management";
  }

  private getSandboxManager(): RuntimeSandboxManager | null {
    const candidate = (this.runtime as unknown as {
      getSandboxManager?: () => RuntimeSandboxManager | null;
    }).getSandboxManager?.();
    return candidate ?? null;
  }

  private toSandboxWorkdir(workdir: string): string | undefined {
    const relative = path.relative(process.cwd(), path.resolve(workdir));
    if (relative === "") return "/workspace";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `/workspace/${relative}`;
    }
    return undefined;
  }

  private async runSandboxCommand(
    command: string,
    workdir: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<CommandResult> {
    const sandboxManager = this.getSandboxManager();
    if (!sandboxManager) {
      logger.error("[shell:sandbox] local-safe denied: SandboxManager unavailable");
      return {
        success: false,
        stdout: "",
        stderr:
          "local-safe mode requires SandboxManager, but no sandbox manager is available for command execution.",
        exitCode: 1,
        error: "Sandbox unavailable",
        executedIn: workdir,
      };
    }

    const sandboxWorkdir = this.toSandboxWorkdir(workdir);
    if (!sandboxWorkdir) {
      return {
        success: false,
        stdout: "",
        stderr: `local-safe mode can only execute inside the sandbox workspace; cwd is outside process workspace: ${workdir}`,
        exitCode: 1,
        error: "Sandbox unavailable",
        executedIn: workdir,
      };
    }

    logger.info(`[shell:sandbox] routing exec via SandboxManager: ${command.substring(0, 100)}`);
    const result = await sandboxManager.exec({
      command,
      workdir: sandboxWorkdir,
      timeoutMs,
      env,
    });
    logger.info(
      `[shell:sandbox] exec completed: exit=${result.exitCode} duration=${result.durationMs}ms executedInSandbox=${result.executedInSandbox}`
    );
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      executedIn: workdir,
    };
  }

  /**
   * Set scope key for session isolation
   */
  setScopeKey(scopeKey: string): void {
    this.scopeKey = scopeKey;
  }

  /**
   * Simple command execution (original API for backward compatibility)
   */
  async executeCommand(command: string, conversationId?: string): Promise<CommandResult> {
    if (!command || typeof command !== "string") {
      return {
        success: false,
        stdout: "",
        stderr: "Invalid command",
        exitCode: 1,
        error: "Command must be a non-empty string",
        executedIn: this.currentDirectory,
      };
    }

    if (isCloudExecutionMode(this.runtime)) {
      logger.error("[shell:cloud] local exec disabled in cloud mode");
      return {
        success: false,
        stdout: "",
        stderr: "Local shell execution disabled in cloud mode.",
        exitCode: 1,
        error: "Local shell execution disabled in cloud mode.",
        executedIn: this.currentDirectory,
      };
    }

    // Sandbox remote mode: route to host capability API
    if (
      !shouldUseSandboxExecution(this.runtime) &&
      this.runtime &&
      "sandboxMode" in this.runtime &&
      this.runtime.sandboxMode
    ) {
      const hostApiUrl =
        (this.runtime.getSetting("SANDBOX_HOST_API_URL") as string | null) ??
        "http://localhost:2138";
      const runtimeFetch = this.runtime.fetch ?? globalThis.fetch;
      logger.info(`[shell:sandbox] routing exec to ${hostApiUrl}: ${command.substring(0, 100)}`);
      try {
        const response = await runtimeFetch(`${hostApiUrl}/api/sandbox/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            workdir: this.currentDirectory,
            timeoutMs: 30000,
          }),
        });
        const result = (await response.json()) as {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
          executedInSandbox: boolean;
        };
        logger.info(
          `[shell:sandbox] exec completed: exit=${result.exitCode} duration=${result.durationMs}ms`
        );
        return {
          success: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          executedIn: this.currentDirectory,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[shell:sandbox] exec failed: ${errMsg}`);
        return {
          success: false,
          stdout: "",
          stderr: `Sandbox exec failed: ${errMsg}`,
          exitCode: 1,
          error: "Sandbox remote execution failed",
          executedIn: this.currentDirectory,
        };
      }
    }

    const trimmedCommand = command.trim();

    if (!isSafeCommand(trimmedCommand)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command contains forbidden patterns",
        exitCode: 1,
        error: "Security policy violation",
        executedIn: this.currentDirectory,
      };
    }

    if (isForbiddenCommand(trimmedCommand, this.shellConfig.forbiddenCommands)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command is forbidden by security policy",
        exitCode: 1,
        error: "Forbidden command",
        executedIn: this.currentDirectory,
      };
    }

    if (trimmedCommand.startsWith("cd ")) {
      const result = await this.handleCdCommand(trimmedCommand);
      this.addToHistory(conversationId, trimmedCommand, result);
      return result;
    }

    const result = shouldUseSandboxExecution(this.runtime)
      ? await this.runSandboxCommand(trimmedCommand, this.currentDirectory, 30_000)
      : await this.runCommandSimple(trimmedCommand);

    if (result.success) {
      const fileOps = this.detectFileOperations(trimmedCommand, this.currentDirectory);
      if (fileOps && conversationId) {
        this.addToHistory(conversationId, trimmedCommand, result, fileOps);
      } else {
        this.addToHistory(conversationId, trimmedCommand, result);
      }
    } else {
      this.addToHistory(conversationId, trimmedCommand, result);
    }

    return result;
  }

  /**
   * Enhanced command execution with PTY, background support, and session management
   * This is the main execution method that supports all advanced features
   */
  async exec(command: string, options: ExecuteOptions = {}): Promise<ExecResult> {
    if (!command || typeof command !== "string") {
      return {
        status: "failed",
        exitCode: 1,
        durationMs: 0,
        aggregated: "Invalid command",
        reason: "Command must be a non-empty string",
      };
    }

    if (isCloudExecutionMode(this.runtime)) {
      logger.error("[shell:cloud] local exec disabled in cloud mode");
      return {
        status: "failed",
        exitCode: 1,
        durationMs: 0,
        aggregated: "",
        reason: "Local shell execution disabled in cloud mode.",
      };
    }

    const trimmedCommand = command.trim();

    if (!isSafeCommand(trimmedCommand)) {
      return {
        status: "failed",
        exitCode: 1,
        durationMs: 0,
        aggregated: "Command contains forbidden patterns",
        reason: "Security policy violation",
      };
    }

    if (isForbiddenCommand(trimmedCommand, this.shellConfig.forbiddenCommands)) {
      return {
        status: "failed",
        exitCode: 1,
        durationMs: 0,
        aggregated: "Command is forbidden by security policy",
        reason: "Forbidden command",
      };
    }

    const warnings: string[] = [];
    const maxOutput = this.shellConfig.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const pendingMaxOutput = this.shellConfig.pendingMaxOutputChars ?? DEFAULT_PENDING_MAX_OUTPUT;
    const defaultBackgroundMs = this.shellConfig.defaultBackgroundMs ?? DEFAULT_BACKGROUND_MS;
    const allowBackground = this.shellConfig.allowBackground ?? true;

    // Resolve background/yield settings
    const backgroundRequested = options.background === true;
    const yieldRequested = typeof options.yieldMs === "number";
    if (!allowBackground && (backgroundRequested || yieldRequested)) {
      warnings.push("Warning: background execution is disabled; running synchronously.");
    }
    const yieldWindow = allowBackground
      ? backgroundRequested
        ? 0
        : clampNumber(options.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 120_000)
      : null;

    // Resolve workdir
    const rawWorkdir = options.workdir?.trim() || this.currentDirectory || process.cwd();
    const workdir = resolveWorkdir(rawWorkdir, warnings);

    // Build environment
    const baseEnv = coerceEnv(process.env);
    const mergedEnv = options.env ? { ...baseEnv, ...options.env } : baseEnv;

    const timeoutSec =
      typeof options.timeout === "number" && options.timeout > 0
        ? options.timeout
        : DEFAULT_TIMEOUT_SEC;
    const usePty = options.pty === true;
    const notifyOnExit = options.notifyOnExit !== false;

    if (shouldUseSandboxExecution(this.runtime)) {
      if (backgroundRequested || yieldRequested || usePty) {
        warnings.push(
          "Warning: local-safe sandbox execution runs synchronously; background, yield, and PTY options are ignored."
        );
      }
      const startedAt = Date.now();
      const sandboxResult = await this.runSandboxCommand(
        trimmedCommand,
        workdir,
        timeoutSec * 1000,
        mergedEnv
      );
      const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
      const aggregated = [sandboxResult.stdout, sandboxResult.stderr].filter(Boolean).join("\n");
      if (!sandboxResult.success) {
        return {
          status: "failed",
          exitCode: sandboxResult.exitCode,
          durationMs: Date.now() - startedAt,
          aggregated,
          cwd: workdir,
          reason: `${warningText}${sandboxResult.error ?? sandboxResult.stderr}`,
        };
      }
      return {
        status: "completed",
        exitCode: sandboxResult.exitCode,
        durationMs: Date.now() - startedAt,
        aggregated: `${warningText}${aggregated || "(no output)"}`,
        cwd: workdir,
      };
    }

    // Run the process
    const handle = await this.runExecProcess({
      command: trimmedCommand,
      workdir,
      env: mergedEnv,
      usePty,
      warnings,
      maxOutput,
      pendingMaxOutput,
      notifyOnExit,
      scopeKey: options.scopeKey ?? this.scopeKey,
      sessionKey: options.sessionKey,
      timeoutSec,
      onUpdate: options.onUpdate,
    });

    // Handle background/yield
    if (allowBackground && yieldWindow !== null) {
      if (yieldWindow === 0) {
        markBackgrounded(handle.session);
        return {
          status: "running",
          sessionId: handle.session.id,
          pid: handle.session.pid,
          startedAt: handle.startedAt,
          cwd: handle.session.cwd,
          tail: handle.session.tail,
        };
      }

      // Wait for yieldWindow or completion
      const raceResult = await Promise.race([
        handle.promise,
        new Promise<"yield">((resolve) => setTimeout(() => resolve("yield"), yieldWindow)),
      ]);

      if (raceResult === "yield" && !handle.session.exited) {
        markBackgrounded(handle.session);
        const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
        return {
          status: "running",
          sessionId: handle.session.id,
          pid: handle.session.pid,
          startedAt: handle.startedAt,
          cwd: handle.session.cwd,
          tail: `${warningText}Command still running (session ${handle.session.id}, pid ${handle.session.pid ?? "n/a"}).`,
        };
      }

      // Process completed within yield window
      const outcome = raceResult === "yield" ? await handle.promise : raceResult;
      const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

      if (outcome.status === "failed") {
        return {
          status: "failed",
          exitCode: outcome.exitCode ?? null,
          durationMs: outcome.durationMs,
          aggregated: outcome.aggregated,
          cwd: workdir,
          timedOut: outcome.timedOut,
          reason: `${warningText}${outcome.reason ?? "Command failed."}`,
        };
      }

      return {
        status: "completed",
        exitCode: outcome.exitCode ?? 0,
        durationMs: outcome.durationMs,
        aggregated: `${warningText}${outcome.aggregated || "(no output)"}`,
        cwd: workdir,
      };
    }

    // Synchronous execution (no yield/background)
    const outcome = await handle.promise;
    const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

    if (outcome.status === "failed") {
      return {
        status: "failed",
        exitCode: outcome.exitCode ?? null,
        durationMs: outcome.durationMs,
        aggregated: outcome.aggregated,
        cwd: workdir,
        timedOut: outcome.timedOut,
        reason: `${warningText}${outcome.reason ?? "Command failed."}`,
      };
    }

    return {
      status: "completed",
      exitCode: outcome.exitCode ?? 0,
      durationMs: outcome.durationMs,
      aggregated: `${warningText}${outcome.aggregated || "(no output)"}`,
      cwd: workdir,
    };
  }

  /**
   * Process management action handler
   * Supports: list, poll, log, write, send-keys, submit, paste, kill, clear, remove
   */
  async processAction(params: ProcessActionParams): Promise<{
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
  }> {
    const scopeKey = this.scopeKey;
    const isInScope = (session?: { scopeKey?: string } | null) =>
      !scopeKey || session?.scopeKey === scopeKey;

    if (params.action === "list") {
      const running = listRunningSessions()
        .filter((s) => isInScope(s))
        .map((s) => ({
          sessionId: s.id,
          status: "running",
          pid: s.pid ?? undefined,
          startedAt: s.startedAt,
          runtimeMs: Date.now() - s.startedAt,
          cwd: s.cwd,
          command: s.command,
          name: deriveSessionName(s.command),
          tail: s.tail,
          truncated: s.truncated,
        }));
      const finished = listFinishedSessions()
        .filter((s) => isInScope(s))
        .map((s) => ({
          sessionId: s.id,
          status: s.status,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          runtimeMs: s.endedAt - s.startedAt,
          cwd: s.cwd,
          command: s.command,
          name: deriveSessionName(s.command),
          tail: s.tail,
          truncated: s.truncated,
          exitCode: s.exitCode ?? undefined,
          exitSignal: s.exitSignal ?? undefined,
        }));
      const sessions = [...running, ...finished]
        .slice()
        .sort(
          (
            a: (typeof running)[number] | (typeof finished)[number],
            b: (typeof running)[number] | (typeof finished)[number]
          ) => b.startedAt - a.startedAt
        );
      const lines = sessions.map((s: (typeof sessions)[number]) => {
        const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
        return `${s.sessionId} ${pad(s.status, 9)} ${formatDuration(s.runtimeMs)} :: ${label}`;
      });
      return {
        success: true,
        message: lines.join("\n") || "No running or recent sessions.",
        data: { sessions },
      };
    }

    if (!params.sessionId) {
      return {
        success: false,
        message: "sessionId is required for this action.",
      };
    }

    const session = getSession(params.sessionId);
    const finished = getFinishedSession(params.sessionId);
    const scopedSession = isInScope(session) ? session : undefined;
    const scopedFinished = isInScope(finished) ? finished : undefined;

    switch (params.action) {
      case "poll": {
        if (!scopedSession) {
          if (scopedFinished) {
            return {
              success: true,
              message:
                (scopedFinished.tail ||
                  `(no output recorded${scopedFinished.truncated ? " — truncated to cap" : ""})`) +
                `\n\nProcess exited with ${
                  scopedFinished.exitSignal
                    ? `signal ${scopedFinished.exitSignal}`
                    : `code ${scopedFinished.exitCode ?? 0}`
                }.`,
              data: {
                status: scopedFinished.status === "completed" ? "completed" : "failed",
                sessionId: params.sessionId,
                exitCode: scopedFinished.exitCode ?? undefined,
                aggregated: scopedFinished.aggregated,
                name: deriveSessionName(scopedFinished.command),
              },
            };
          }
          return {
            success: false,
            message: `No session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        const { stdout, stderr } = drainSession(scopedSession);
        const exited = scopedSession.exited;
        const exitCode = scopedSession.exitCode ?? 0;
        const exitSignal = scopedSession.exitSignal ?? undefined;
        if (exited) {
          const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
          markExited(
            scopedSession,
            scopedSession.exitCode ?? null,
            scopedSession.exitSignal ?? null,
            status
          );
        }
        const status = exited
          ? exitCode === 0 && exitSignal == null
            ? "completed"
            : "failed"
          : "running";
        const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
        return {
          success: true,
          message:
            (output || "(no new output)") +
            (exited
              ? `\n\nProcess exited with ${
                  exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                }.`
              : "\n\nProcess still running."),
          data: {
            status,
            sessionId: params.sessionId,
            exitCode: exited ? exitCode : undefined,
            aggregated: scopedSession.aggregated,
            name: deriveSessionName(scopedSession.command),
          },
        };
      }

      case "log": {
        if (scopedSession) {
          if (!scopedSession.backgrounded) {
            return {
              success: false,
              message: `Session ${params.sessionId} is not backgrounded.`,
            };
          }
          const { slice, totalLines, totalChars } = sliceLogLines(
            scopedSession.aggregated,
            params.offset,
            params.limit
          );
          return {
            success: true,
            message: slice || "(no output yet)",
            data: {
              status: scopedSession.exited ? "completed" : "running",
              sessionId: params.sessionId,
              totalLines,
              totalChars,
              truncated: scopedSession.truncated,
              name: deriveSessionName(scopedSession.command),
            },
          };
        }
        if (scopedFinished) {
          const { slice, totalLines, totalChars } = sliceLogLines(
            scopedFinished.aggregated,
            params.offset,
            params.limit
          );
          const status = scopedFinished.status === "completed" ? "completed" : "failed";
          return {
            success: true,
            message: slice || "(no output recorded)",
            data: {
              status,
              sessionId: params.sessionId,
              totalLines,
              totalChars,
              truncated: scopedFinished.truncated,
              exitCode: scopedFinished.exitCode ?? undefined,
              exitSignal: scopedFinished.exitSignal ?? undefined,
              name: deriveSessionName(scopedFinished.command),
            },
          };
        }
        return {
          success: false,
          message: `No session found for ${params.sessionId}`,
        };
      }

      case "write": {
        if (!scopedSession) {
          return {
            success: false,
            message: `No active session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            success: false,
            message: `Session ${params.sessionId} stdin is not writable.`,
          };
        }
        await new Promise<void>((resolve, reject) => {
          stdin.write(params.data ?? "", (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        if (params.eof) {
          stdin.end();
        }
        return {
          success: true,
          message: `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${
            params.eof ? " (stdin closed)" : ""
          }.`,
          data: {
            sessionId: params.sessionId,
            name: deriveSessionName(scopedSession.command),
          },
        };
      }

      case "send-keys": {
        if (!scopedSession) {
          return {
            success: false,
            message: `No active session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            success: false,
            message: `Session ${params.sessionId} stdin is not writable.`,
          };
        }
        const { data, warnings } = encodeKeySequence({
          keys: params.keys,
          hex: params.hex,
          literal: params.literal,
        });
        if (!data) {
          return { success: false, message: "No key data provided." };
        }
        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return {
          success: true,
          message:
            `Sent ${data.length} bytes to session ${params.sessionId}.` +
            (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
          data: {
            sessionId: params.sessionId,
            name: deriveSessionName(scopedSession.command),
          },
        };
      }

      case "submit": {
        if (!scopedSession) {
          return {
            success: false,
            message: `No active session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            success: false,
            message: `Session ${params.sessionId} stdin is not writable.`,
          };
        }
        await new Promise<void>((resolve, reject) => {
          stdin.write("\r", (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return {
          success: true,
          message: `Submitted session ${params.sessionId} (sent CR).`,
          data: {
            sessionId: params.sessionId,
            name: deriveSessionName(scopedSession.command),
          },
        };
      }

      case "paste": {
        if (!scopedSession) {
          return {
            success: false,
            message: `No active session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            success: false,
            message: `Session ${params.sessionId} stdin is not writable.`,
          };
        }
        const payload = encodePaste(params.text ?? "", params.bracketed !== false);
        if (!payload) {
          return { success: false, message: "No paste text provided." };
        }
        await new Promise<void>((resolve, reject) => {
          stdin.write(payload, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return {
          success: true,
          message: `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`,
          data: {
            sessionId: params.sessionId,
            name: deriveSessionName(scopedSession.command),
          },
        };
      }

      case "kill": {
        if (!scopedSession) {
          return {
            success: false,
            message: `No active session found for ${params.sessionId}`,
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            success: false,
            message: `Session ${params.sessionId} is not backgrounded.`,
          };
        }
        killSession(scopedSession);
        markExited(scopedSession, null, "SIGKILL", "failed");
        return {
          success: true,
          message: `Killed session ${params.sessionId}.`,
          data: { name: deriveSessionName(scopedSession.command) },
        };
      }

      case "clear": {
        if (scopedFinished) {
          deleteSession(params.sessionId);
          return {
            success: true,
            message: `Cleared session ${params.sessionId}.`,
          };
        }
        return {
          success: false,
          message: `No finished session found for ${params.sessionId}`,
        };
      }

      case "remove": {
        if (scopedSession) {
          killSession(scopedSession);
          markExited(scopedSession, null, "SIGKILL", "failed");
          return {
            success: true,
            message: `Removed session ${params.sessionId}.`,
            data: { name: deriveSessionName(scopedSession.command) },
          };
        }
        if (scopedFinished) {
          deleteSession(params.sessionId);
          return {
            success: true,
            message: `Removed session ${params.sessionId}.`,
          };
        }
        return {
          success: false,
          message: `No session found for ${params.sessionId}`,
        };
      }
    }

    return {
      success: false,
      message: `Unknown action ${params.action as string}`,
    };
  }

  // ===== Public Service Methods for External Use =====

  /**
   * List all running sessions
   */
  listRunningSessions(): ProcessSession[] {
    const scopeKey = this.scopeKey;
    return listRunningSessions().filter((s) => !scopeKey || s.scopeKey === scopeKey);
  }

  /**
   * List all finished sessions
   */
  listFinishedSessions(): FinishedSession[] {
    const scopeKey = this.scopeKey;
    return listFinishedSessions().filter((s) => !scopeKey || s.scopeKey === scopeKey);
  }

  /**
   * Get a specific session by ID
   */
  getSession(id: string): ProcessSession | undefined {
    const session = getSession(id);
    if (!session) return undefined;
    if (this.scopeKey && session.scopeKey !== this.scopeKey) return undefined;
    return session;
  }

  /**
   * Get a specific finished session by ID
   */
  getFinishedSession(id: string): FinishedSession | undefined {
    const session = getFinishedSession(id);
    if (!session) return undefined;
    if (this.scopeKey && session.scopeKey !== this.scopeKey) return undefined;
    return session;
  }

  /**
   * Kill a session by ID
   */
  killSessionById(id: string): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    killSession(session);
    markExited(session, null, "SIGKILL", "killed");
    return true;
  }

  /**
   * Get command history for a conversation
   */
  getCommandHistory(conversationId: string, limit?: number): CommandHistoryEntry[] {
    const history = this.commandHistory.get(conversationId) || [];
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  /**
   * Clear command history for a conversation
   */
  clearCommandHistory(conversationId: string): void {
    this.commandHistory.delete(conversationId);
    logger.info(`Cleared command history for conversation: ${conversationId}`);
  }

  /**
   * Get current working directory
   */
  getCurrentDirectory(_conversationId?: string): string {
    return this.currentDirectory;
  }

  /**
   * Set current working directory
   */
  setCurrentDirectory(directory: string): boolean {
    const validatedPath = validatePath(
      directory,
      this.shellConfig.allowedDirectory,
      this.currentDirectory
    );
    if (!validatedPath) {
      return false;
    }
    this.currentDirectory = validatedPath;
    return true;
  }

  /**
   * Get allowed directory
   */
  getAllowedDirectory(): string {
    return this.shellConfig.allowedDirectory;
  }

  /**
   * Get shell configuration
   */
  getShellConfig(): ShellConfig {
    return { ...this.shellConfig };
  }

  // ===== Private Methods =====

  private async handleCdCommand(command: string): Promise<CommandResult> {
    const parts = command.split(/\s+/);
    if (parts.length < 2) {
      this.currentDirectory = this.shellConfig.allowedDirectory;
      return {
        success: true,
        stdout: `Changed directory to: ${this.currentDirectory}`,
        stderr: "",
        exitCode: 0,
        executedIn: this.currentDirectory,
      };
    }

    const targetPath = parts.slice(1).join(" ");
    const validatedPath = validatePath(
      targetPath,
      this.shellConfig.allowedDirectory,
      this.currentDirectory
    );

    if (!validatedPath) {
      return {
        success: false,
        stdout: "",
        stderr: "Cannot navigate outside allowed directory",
        exitCode: 1,
        error: "Permission denied",
        executedIn: this.currentDirectory,
      };
    }

    this.currentDirectory = validatedPath;
    return {
      success: true,
      stdout: `Changed directory to: ${this.currentDirectory}`,
      stderr: "",
      exitCode: 0,
      executedIn: this.currentDirectory,
    };
  }

  private async runCommandSimple(command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const useShell = command.includes(">") || command.includes("<") || command.includes("|");

      let cmd: string;
      let args: string[];

      if (useShell) {
        cmd = "sh";
        args = ["-c", command];
        logger.info(`Executing shell command: sh -c "${command}" in ${this.currentDirectory}`);
      } else {
        const parts = command.split(/\s+/);
        cmd = parts[0];
        args = parts.slice(1);
        logger.info(`Executing command: ${cmd} ${args.join(" ")} in ${this.currentDirectory}`);
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(cmd, args, {
        cwd: this.currentDirectory,
        env: process.env,
        shell: false,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, this.shellConfig.timeout);

      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      }

      child.on("exit", (code) => {
        clearTimeout(timeout);

        if (timedOut) {
          resolve({
            success: false,
            stdout,
            stderr: `${stderr}\nCommand timed out`,
            exitCode: code,
            error: "Command execution timeout",
            executedIn: this.currentDirectory,
          });
          return;
        }

        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          executedIn: this.currentDirectory,
        });
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: 1,
          error: "Failed to execute command",
          executedIn: this.currentDirectory,
        });
      });
    });
  }

  private async runExecProcess(opts: {
    command: string;
    workdir: string;
    env: Record<string, string>;
    usePty: boolean;
    warnings: string[];
    maxOutput: number;
    pendingMaxOutput: number;
    notifyOnExit: boolean;
    scopeKey?: string;
    sessionKey?: string;
    timeoutSec: number;
    onUpdate?: (session: ProcessSession) => void;
  }): Promise<{
    session: ProcessSession;
    startedAt: number;
    promise: Promise<{
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      reason?: string;
    }>;
    kill: () => void;
  }> {
    const startedAt = Date.now();
    const sessionId = createSessionSlug();
    let child: ChildProcessWithoutNullStreams | null = null;
    let pty: PtyHandle | null = null;
    let stdin: ProcessSession["stdin"] | undefined;

    if (opts.usePty) {
      const { shell, args: shellArgs } = getShellConfig();
      try {
        const ptyModule = (await import("@lydell/node-pty")) as {
          spawn?: PtySpawn;
          default?: { spawn?: PtySpawn };
        };
        const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
        if (!spawnPty) {
          throw new Error("PTY support is unavailable (node-pty spawn not found).");
        }
        pty = spawnPty(shell, [...shellArgs, opts.command], {
          cwd: opts.workdir,
          env: opts.env,
          name: process.env.TERM ?? "xterm-256color",
          cols: 120,
          rows: 30,
        });
        stdin = {
          destroyed: false,
          write: (data, cb) => {
            try {
              pty?.write(data);
              cb?.(null);
            } catch (err) {
              cb?.(err as Error);
            }
          },
          end: () => {
            try {
              const eof = process.platform === "win32" ? "\x1a" : "\x04";
              pty?.write(eof);
            } catch {
              // ignore EOF errors
            }
          },
        };
      } catch (err) {
        const errText = String(err);
        const warning = `Warning: PTY spawn failed (${errText}); retrying without PTY.`;
        logger.warn(`exec: PTY spawn failed (${errText}); retrying without PTY.`);
        opts.warnings.push(warning);
        // Fall through to non-PTY execution
      }
    }

    if (!pty) {
      const { shell, args: shellArgs } = getShellConfig();
      const proc = spawn(shell, [...shellArgs, opts.command], {
        cwd: opts.workdir,
        env: opts.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      child = proc;
      stdin = child.stdin;
    }

    const session: ProcessSession = {
      id: sessionId,
      command: opts.command,
      scopeKey: opts.scopeKey,
      sessionKey: opts.sessionKey,
      notifyOnExit: opts.notifyOnExit,
      exitNotified: false,
      child: child ?? undefined,
      stdin,
      pid: child?.pid ?? pty?.pid,
      startedAt,
      cwd: opts.workdir,
      maxOutputChars: opts.maxOutput,
      pendingMaxOutputChars: opts.pendingMaxOutput,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };
    addSession(session);

    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let timeoutFinalizeTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeoutFinalizeMs = 1000;
    let resolveFn:
      | ((outcome: {
          status: "completed" | "failed";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          aggregated: string;
          timedOut: boolean;
          reason?: string;
        }) => void)
      | null = null;

    const settle = (outcome: {
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      reason?: string;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveFn?.(outcome);
    };

    const finalizeTimeout = () => {
      if (session.exited) {
        return;
      }
      markExited(session, null, "SIGKILL", "failed");
      const aggregated = session.aggregated.trim();
      const reason = `Command timed out after ${opts.timeoutSec} seconds`;
      settle({
        status: "failed",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: Date.now() - startedAt,
        aggregated,
        timedOut: true,
        reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
      });
    };

    const onTimeout = () => {
      timedOut = true;
      killSession(session);
      if (!timeoutFinalizeTimer) {
        timeoutFinalizeTimer = setTimeout(() => {
          finalizeTimeout();
        }, timeoutFinalizeMs);
      }
    };

    if (opts.timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        onTimeout();
      }, opts.timeoutSec * 1000);
    }

    const emitUpdate = () => {
      if (opts.onUpdate) {
        opts.onUpdate(session);
      }
    };

    const handleStdout = (data: string) => {
      const str = sanitizeBinaryOutput(data.toString());
      for (const chunk of chunkString(str)) {
        appendOutput(session, "stdout", chunk);
        emitUpdate();
      }
    };

    const handleStderr = (data: string) => {
      const str = sanitizeBinaryOutput(data.toString());
      for (const chunk of chunkString(str)) {
        appendOutput(session, "stderr", chunk);
        emitUpdate();
      }
    };

    if (pty) {
      const cursorResponse = buildCursorPositionResponse();
      pty.onData((data) => {
        const raw = data.toString();
        const { cleaned, requests } = stripDsrRequests(raw);
        if (requests > 0) {
          for (let i = 0; i < requests; i += 1) {
            pty.write(cursorResponse);
          }
        }
        handleStdout(cleaned);
      });
    } else if (child) {
      child.stdout.on("data", handleStdout);
      child.stderr.on("data", handleStderr);
    }

    const promise = new Promise<{
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      reason?: string;
    }>((resolve) => {
      resolveFn = resolve;
      const handleExit = (code: number | null, exitSignal: NodeJS.Signals | number | null) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (timeoutFinalizeTimer) {
          clearTimeout(timeoutFinalizeTimer);
        }
        const durationMs = Date.now() - startedAt;
        const wasSignal = exitSignal != null;
        const isSuccess = code === 0 && !wasSignal && !timedOut;
        const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
        markExited(session, code, exitSignal, status);
        if (!session.child && session.stdin) {
          session.stdin.destroyed = true;
        }

        if (settled) {
          return;
        }
        const aggregated = session.aggregated.trim();
        if (!isSuccess) {
          const reason = timedOut
            ? `Command timed out after ${opts.timeoutSec} seconds`
            : wasSignal && exitSignal
              ? `Command aborted by signal ${exitSignal}`
              : code === null
                ? "Command aborted before exit code was captured"
                : `Command exited with code ${code}`;
          const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
          settle({
            status: "failed",
            exitCode: code ?? null,
            exitSignal: exitSignal ?? null,
            durationMs,
            aggregated,
            timedOut,
            reason: message,
          });
          return;
        }
        settle({
          status: "completed",
          exitCode: code ?? 0,
          exitSignal: exitSignal ?? null,
          durationMs,
          aggregated,
          timedOut: false,
        });
      };

      if (pty) {
        pty.onExit((event) => {
          const rawSignal = event.signal ?? null;
          const normalizedSignal = rawSignal === 0 ? null : rawSignal;
          handleExit(event.exitCode ?? null, normalizedSignal);
        });
      } else if (child) {
        child.once("close", (code, exitSignal) => {
          handleExit(code, exitSignal);
        });

        child.once("error", (err) => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          if (timeoutFinalizeTimer) {
            clearTimeout(timeoutFinalizeTimer);
          }
          markExited(session, null, null, "failed");
          const aggregated = session.aggregated.trim();
          const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
          settle({
            status: "failed",
            exitCode: null,
            exitSignal: null,
            durationMs: Date.now() - startedAt,
            aggregated,
            timedOut,
            reason: message,
          });
        });
      }
    });

    return {
      session,
      startedAt,
      promise,
      kill: () => killSession(session),
    };
  }

  private addToHistory(
    conversationId: string | undefined,
    command: string,
    result: CommandResult,
    fileOperations?: FileOperation[]
  ): void {
    if (!conversationId) return;

    const historyEntry: CommandHistoryEntry = {
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timestamp: Date.now(),
      workingDirectory: result.executedIn,
      fileOperations,
    };

    if (!this.commandHistory.has(conversationId)) {
      this.commandHistory.set(conversationId, []);
    }

    const history = this.commandHistory.get(conversationId);
    if (!history) {
      throw new Error(`No history found for conversation ${conversationId}`);
    }
    history.push(historyEntry);

    if (history.length > this.maxHistoryPerConversation) {
      history.shift();
    }
  }

  private detectFileOperations(command: string, cwd: string): FileOperation[] | undefined {
    const operations: FileOperation[] = [];
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "touch" && parts.length > 1) {
      operations.push({
        type: "create" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "echo" && command.includes(">")) {
      const match = command.match(/>\s*([^\s]+)$/);
      if (match) {
        operations.push({
          type: "write" as FileOperationType,
          target: this.resolvePath(match[1], cwd),
        });
      }
    } else if (cmd === "mkdir" && parts.length > 1) {
      operations.push({
        type: "mkdir" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "cat" && parts.length > 1 && !command.includes(">")) {
      operations.push({
        type: "read" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
      });
    } else if (cmd === "mv" && parts.length > 2) {
      operations.push({
        type: "move" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd),
      });
    } else if (cmd === "cp" && parts.length > 2) {
      operations.push({
        type: "copy" as FileOperationType,
        target: this.resolvePath(parts[1], cwd),
        secondaryTarget: this.resolvePath(parts[2], cwd),
      });
    }

    return operations.length > 0 ? operations : undefined;
  }

  private resolvePath(filePath: string, cwd: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(cwd, filePath);
  }
}
