import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Service, type IAgentRuntime } from "@elizaos/core";
import {
  buildOpencodeAcpEnv,
  resolveVendoredOpencodeAcpCommand,
} from "./opencode-config.js";
import { normalizeTaskAgentAdapter } from "./task-agent-routing.js";
import {
  AcpSessionStore,
  InMemorySessionStore,
  type SessionStoreBackend,
} from "./session-store.js";
import type {
  AcpEventCallback,
  AcpJsonRpcMessage,
  AcpToolCall,
  AgentType,
  ApprovalPreset,
  AvailableAgentInfo,
  PromptResult,
  SendOptions,
  SessionEventCallback,
  SessionEventName,
  SessionInfo,
  SessionStore,
  SpawnOptions,
  SpawnResult,
} from "./types.js";

type RuntimeLike = IAgentRuntime & {
  logger?: Partial<
    Record<
      "debug" | "info" | "warn" | "error",
      (message: string, data?: unknown) => void
    >
  >;
  services?: Map<string, unknown[]>;
  databaseAdapter?: unknown;
  getSetting?: (key: string) => string | undefined | null;
};
type RuntimeLogger = NonNullable<RuntimeLike["logger"]>;
type ProcessRecord = {
  proc: ChildProcessWithoutNullStreams;
  stderr: string;
  stdoutBuffer: string;
  killedByService: boolean;
  cancelled: boolean;
  exited: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
};

type RunOptions = {
  sessionId?: string;
  sessionName?: string;
  agentType: AgentType;
  workdir: string;
  args: string[];
  env?: Record<string, string | undefined>;
  promptPreview?: string;
  promptLength?: number;
  timeoutMs?: number;
  activeForSession?: boolean;
};

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  finalText: string;
  stopReason?: string;
  cancelled?: boolean;
  durationMs: number;
};

const STDERR_CAP_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const DEFAULT_WORKDIR_ROOT = join(tmpdir(), "eliza-acp");
const MAX_CAPTURED_TOOL_OUTPUT_CHARS = 12_000;
const TOOL_OUTPUT_END_MARKER = "[/tool output]";
const DEFAULT_AGENTS: AgentType[] = ["codex", "claude", "opencode"];
const DENY_ENV_PATTERNS = [
  /DISCORD.*TOKEN/i,
  /TELEGRAM.*TOKEN/i,
  /SLACK.*TOKEN/i,
  /BOT.*TOKEN/i,
  /ELIZA_VAULT_PASSPHRASE/i,
];

export class AcpService extends Service {
  static serviceType = "ACP_SUBPROCESS_SERVICE";

  capabilityDescription =
    "Manages asynchronous ACPX task-agent sessions for open-ended background work";

  readonly defaultApprovalPreset: ApprovalPreset;
  readonly agentSelectionStrategy: string;

  protected readonly runtime: RuntimeLike;
  private readonly logger: RuntimeLogger;
  private readonly store: SessionStore;
  private readonly cliPath: string;
  private readonly defaultAgent: AgentType;
  private readonly maxSessions: number;
  private readonly sessionTimeoutMs?: number;
  private readonly sessionCallbacks: SessionEventCallback[] = [];
  private readonly acpCallbacks: AcpEventCallback[] = [];
  private readonly activeProcesses = new Map<string, ProcessRecord>();
  private readonly outputBuffers = new Map<string, string[]>();
  private started = false;

  constructor(runtime: IAgentRuntime, opts: { store?: SessionStore } = {}) {
    super(runtime);
    this.runtime = runtime as RuntimeLike;
    this.logger = (this.runtime.logger ?? {}) as RuntimeLogger;
    this.store = opts.store ?? new InMemorySessionStore();
    this.cliPath = this.setting("ELIZA_ACP_CLI") ?? "acpx";
    this.defaultAgent =
      normalizeTaskAgentAdapter(
        this.setting("BENCHMARK_TASK_AGENT") ??
          this.setting("ELIZA_ACP_DEFAULT_AGENT") ??
          this.setting("ELIZA_DEFAULT_AGENT_TYPE"),
      ) ?? "codex";
    this.defaultApprovalPreset = normalizeApprovalPreset(
      boolSetting(this.setting("ACPX_APPROVE_ALL")) === true
        ? "approve-all"
        : (this.setting("ELIZA_ACP_DEFAULT_APPROVAL") ??
            this.setting("ELIZA_DEFAULT_APPROVAL_PRESET")),
    );
    this.agentSelectionStrategy =
      this.setting("ELIZA_ACP_AGENT_SELECTION_STRATEGY") ??
      this.setting("ELIZA_AGENT_SELECTION_STRATEGY") ??
      "fixed";
    this.maxSessions =
      parsePositiveInt(this.setting("ELIZA_ACP_MAX_SESSIONS")) ?? 8;
    this.sessionTimeoutMs = parsePositiveInt(
      this.setting("ACPX_DEFAULT_TIMEOUT_MS") ??
        this.setting("ELIZA_ACP_PROMPT_TIMEOUT_MS"),
    );
  }

  static async start(runtime: IAgentRuntime): Promise<AcpService> {
    const service = new AcpService(runtime, {
      store: createDefaultSessionStore(runtime as RuntimeLike),
    });
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    this.started = true;
    this.log("debug", "AcpService initialized", {
      cliPath: this.cliPath,
      defaultAgent: this.defaultAgent,
      defaultApprovalPreset: this.defaultApprovalPreset,
    });
  }

  async stop(): Promise<void> {
    const stops = Array.from(this.activeProcesses.keys()).map((sessionId) =>
      this.stopTrackedProcess(sessionId),
    );
    await Promise.allSettled(stops);
    this.started = false;
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    this.ensureStarted();
    const id = randomUUID();
    const name = opts.name?.trim() || id;
    const agentType =
      normalizeTaskAgentAdapter(opts.agentType ?? this.defaultAgent) ??
      this.defaultAgent;
    const approvalPreset = opts.approvalPreset ?? this.defaultApprovalPreset;
    const workdir = resolve(
      opts.workdir ??
        this.setting("ELIZA_ACP_WORKSPACE_ROOT") ??
        this.setting("ACPX_DEFAULT_CWD") ??
        DEFAULT_WORKDIR_ROOT,
    );
    await mkdir(workdir, { recursive: true });
    await this.enforceSessionLimit();

    const now = new Date();
    const session: SessionInfo = {
      id,
      name,
      agentType,
      workdir,
      status: "running",
      approvalPreset,
      createdAt: now,
      lastActivityAt: now,
      metadata: opts.metadata,
    };
    await this.store.create(session);

    const args = this.baseArgs({
      workdir,
      approvalPreset,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
    });
    args.push(
      ...this.agentCommandArgs(agentType, ["sessions", "new", "--name", name]),
    );
    const result = await this.runAcpx({
      sessionId: id,
      sessionName: name,
      agentType,
      workdir,
      args,
      env: this.buildEnv(
        opts.env,
        opts.customCredentials,
        opts.model,
        agentType,
      ),
    });

    if (result.code !== 0) {
      const message = this.classifyExitError(result.code, result.stderr);
      await this.store.updateStatus(id, "errored", message);
      this.emitSessionEvent(id, "error", {
        message,
        exitCode: result.code,
        stderr: result.stderr,
      });
      throw new Error(message);
    }

    const readyPatch: Partial<SessionInfo> = {
      status: "ready",
      pid: undefined,
      lastActivityAt: new Date(),
    };
    await this.store.update(id, readyPatch);
    this.emitSessionEvent(id, "ready", {
      sessionId: id,
      name,
      agentType,
      workdir,
    });

    if (opts.initialTask?.trim()) {
      const keepAliveAfterComplete =
        (opts.metadata as Record<string, unknown> | undefined)
          ?.keepAliveAfterComplete === true;
      void this.sendPrompt(id, opts.initialTask, {
        timeoutMs: opts.timeoutMs,
        model: opts.model,
      })
        .catch((err: unknown) => {
          this.log("error", "initial prompt failed", {
            sessionId: id,
            agentType,
            promptLength: opts.initialTask?.length ?? 0,
            promptPreview: preview(opts.initialTask ?? ""),
            error: errorMessage(err),
          });
        })
        .finally(() => {
          if (keepAliveAfterComplete) return;
          void this.closeInitialTaskSession(id);
        });
    }

    const updated = await this.store.get(id);
    const sessionSnapshot: SessionInfo = { ...session, status: "ready" };
    return toSpawnResult(updated ?? sessionSnapshot);
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<PromptResult> {
    this.ensureStarted();
    const session = await this.requireSession(sessionId);
    const startedAt = Date.now();
    await this.store.updateStatus(sessionId, "busy");
    const args = this.baseArgs({
      workdir: session.workdir,
      approvalPreset: session.approvalPreset,
      timeoutMs: opts.timeoutMs ?? this.sessionTimeoutMs,
      model: opts.model,
    });
    args.push(
      ...this.agentCommandArgs(session.agentType, [
        "prompt",
        "-s",
        session.name ?? session.id,
        "--",
        text,
      ]),
    );

    const result = await this.runAcpx({
      sessionId,
      sessionName: session.name ?? session.id,
      agentType: session.agentType,
      workdir: session.workdir,
      args,
      env: this.buildEnv(opts.env, undefined, opts.model, session.agentType),
      promptPreview: preview(text),
      promptLength: text.length,
      timeoutMs: opts.timeoutMs,
      activeForSession: true,
    });

    const stopReason =
      result.stopReason ??
      (result.cancelled
        ? "cancelled"
        : result.code === 0
          ? "end_turn"
          : "error");
    const promptResult: PromptResult = {
      sessionId,
      response: result.finalText,
      finalText: result.finalText,
      stopReason,
      durationMs: result.durationMs || Date.now() - startedAt,
      exitCode: result.code,
      signal: result.signal,
      ...(result.code !== 0 && !result.cancelled
        ? { error: this.classifyExitError(result.code, result.stderr) }
        : {}),
    };

    if (result.cancelled || stopReason === "cancelled") {
      await this.store.updateStatus(sessionId, "cancelled");
      return promptResult;
    }

    if (result.code === 0 && stopReason !== "error") {
      await this.store.update(sessionId, {
        status: "ready",
        lastActivityAt: new Date(),
      });
      return promptResult;
    }

    const message =
      promptResult.error ?? `acpx prompt failed with stopReason ${stopReason}`;
    await this.store.updateStatus(sessionId, "errored", message);
    this.emitSessionEvent(sessionId, "error", {
      message,
      stopReason,
      failureKind: isAuthText(result.stderr) ? "auth" : undefined,
    });
    return promptResult;
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      active.cancelled = true;
      this.terminateProcess(sessionId, active);
    } else {
      const args = this.agentCommandArgs(session.agentType, [
        "cancel",
        "-s",
        session.name ?? session.id,
      ]);
      await this.runAcpx({
        sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
        args,
      });
    }
    await this.store.updateStatus(sessionId, "cancelled");
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    await this.stopTrackedProcess(sessionId);
    const args = [
      "--format",
      "json",
      "--cwd",
      session.workdir,
      ...this.agentCommandArgs(session.agentType, [
        "sessions",
        "close",
        session.name ?? session.id,
      ]),
    ];
    await this.runAcpx({
      sessionId,
      agentType: session.agentType,
      workdir: session.workdir,
      args,
    });
    await this.store.updateStatus(sessionId, "stopped");
    this.emitSessionEvent(sessionId, "stopped", {
      sessionId,
      response: this.lastOutput(sessionId),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.closeSession(sessionId).catch((err: unknown) => {
      this.log("warn", "deleteSession close failed", {
        sessionId,
        error: errorMessage(err),
      });
    });
    await this.store.delete(sessionId);
    this.outputBuffers.delete(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.store.list();
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    const session = await this.store.get(sessionId);
    return session ?? undefined;
  }

  onSessionEvent(handler: SessionEventCallback): () => void {
    this.sessionCallbacks.push(handler);
    return () => {
      const index = this.sessionCallbacks.indexOf(handler);
      if (index >= 0) this.sessionCallbacks.splice(index, 1);
    };
  }

  onAcpEvent(handler: AcpEventCallback): () => void {
    this.acpCallbacks.push(handler);
    return () => {
      const index = this.acpCallbacks.indexOf(handler);
      if (index >= 0) this.acpCallbacks.splice(index, 1);
    };
  }

  async reattachSession(sessionId: string): Promise<SpawnResult> {
    const session = await this.requireSession(sessionId);
    if (session.pid && isPidAlive(session.pid)) {
      await this.store.updateStatus(sessionId, "ready");
      return toSpawnResult({ ...session, status: "ready" });
    }
    const respawn = await this.spawnSession({
      name: session.name ?? session.id,
      agentType: session.agentType,
      workdir: session.workdir,
      approvalPreset: session.approvalPreset,
      metadata: { ...session.metadata, reattachedFrom: session.id },
    });
    await this.store.update(sessionId, {
      status: "stopped",
      lastActivityAt: new Date(),
    });
    this.emitSessionEvent(respawn.sessionId, "reconnected", {
      previousSessionId: sessionId,
    });
    return respawn;
  }

  async getAvailableAgents(): Promise<AvailableAgentInfo[]> {
    return DEFAULT_AGENTS.map((agentType) => ({
      adapter: agentType,
      agentType,
      installed: true,
      auth: { status: "unknown" },
    }));
  }

  async checkAvailableAgents(types?: string[]): Promise<AvailableAgentInfo[]> {
    const available = await this.getAvailableAgents();
    return types?.length
      ? available.filter((a) => types.includes(String(a.agentType)))
      : available;
  }

  async resolveAgentType(): Promise<string> {
    return String(this.defaultAgent);
  }

  async sendToSession(sessionId: string, input: string): Promise<PromptResult> {
    return this.sendPrompt(sessionId, input);
  }

  async sendKeysToSession(sessionId: string): Promise<void> {
    await this.requireSession(sessionId);
    throw new Error("ACP sessions do not support raw key input.");
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.closeSession(sessionId);
  }

  private async closeInitialTaskSession(sessionId: string): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) return;
    if (
      ["stopped", "errored", "completed", "cancelled"].includes(session.status)
    ) {
      return;
    }
    await this.closeSession(sessionId).catch((err: unknown) => {
      this.log("warn", "initial task session close failed", {
        sessionId,
        error: errorMessage(err),
      });
    });
  }

  subscribeToOutput(
    sessionId: string,
    callback: (data: string) => void,
  ): () => void {
    for (const line of this.outputBuffers.get(sessionId) ?? []) callback(line);
    return () => undefined;
  }

  async getSessionOutput(sessionId: string, lines = 200): Promise<string> {
    return (this.outputBuffers.get(sessionId) ?? []).slice(-lines).join("");
  }

  private baseArgs(opts: {
    workdir: string;
    approvalPreset: ApprovalPreset;
    timeoutMs?: number;
    model?: string;
  }): string[] {
    const format = this.setting("ACPX_FORMAT") ?? "json";
    const args = [
      "--format",
      format,
      "--cwd",
      opts.workdir,
      ...approvalArgs(opts.approvalPreset),
    ];
    if (this.shouldDisableTerminalCapability()) args.push("--no-terminal");
    const timeoutMs = opts.timeoutMs ?? this.sessionTimeoutMs;
    if (timeoutMs && timeoutMs > 0)
      args.push("--timeout", String(timeoutMs / 1000));
    if (opts.model) args.push("--model", opts.model);
    return args;
  }

  private opencodeAgentCommand(): string | undefined {
    const configured = this.setting("ELIZA_OPENCODE_ACP_COMMAND")?.trim();
    if (configured) return configured;
    return resolveVendoredOpencodeAcpCommand();
  }

  private agentCommandArgs(agentType: AgentType, args: string[]): string[] {
    const normalizedAgentType =
      normalizeTaskAgentAdapter(agentType) ?? agentType;
    if (normalizedAgentType !== "opencode")
      return [normalizedAgentType, ...args];
    const command = this.opencodeAgentCommand();
    if (!command) return [normalizedAgentType, ...args];
    return ["--agent", command, ...args];
  }

  private runAcpx(opts: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    let finalText = "";
    let stopReason: string | undefined;
    const capturedToolOutputs = new Set<string>();
    return new Promise((resolveRun) => {
      const proc = spawn(this.cliPath, opts.args, {
        cwd: opts.workdir,
        env: this.buildEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const record: ProcessRecord = {
        proc,
        stderr: "",
        stdoutBuffer: "",
        killedByService: false,
        cancelled: false,
        exited: false,
      };
      if (opts.activeForSession && opts.sessionId)
        this.activeProcesses.set(opts.sessionId, record);

      proc.stdout.on("data", (chunk: Buffer) => {
        record.stdoutBuffer += chunk.toString("utf8");
        let newlineIndex = record.stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = record.stdoutBuffer.slice(0, newlineIndex).trim();
          record.stdoutBuffer = record.stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            const parsed = this.parseNdjson(line, opts.sessionId);
            if (parsed) {
              const handled = this.handleAcpEvent(
                parsed,
                opts.sessionId,
                finalText,
                startedAt,
                opts.activeForSession === true,
                capturedToolOutputs,
              );
              finalText = handled.finalText;
              stopReason = handled.stopReason ?? stopReason;
            }
          }
          newlineIndex = record.stdoutBuffer.indexOf("\n");
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        record.stderr = capStderr(record.stderr + chunk.toString("utf8"));
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        record.stderr = capStderr(record.stderr + errorMessage(err));
        if (err.code === "ENOENT") {
          const message = `acpx CLI not found at ${this.cliPath}. Set ELIZA_ACP_CLI or npm install -g acpx@latest.`;
          record.stderr = capStderr(`${record.stderr}\n${message}`);
          if (opts.sessionId)
            this.emitSessionEvent(opts.sessionId, "error", {
              message,
              failureKind: "not_found",
            });
        }
      });

      proc.on("close", (code, signal) => {
        record.exited = true;
        if (record.stdoutBuffer.trim()) {
          const parsed = this.parseNdjson(
            record.stdoutBuffer.trim(),
            opts.sessionId,
          );
          if (parsed) {
            const handled = this.handleAcpEvent(
              parsed,
              opts.sessionId,
              finalText,
              startedAt,
              opts.activeForSession === true,
              capturedToolOutputs,
            );
            finalText = handled.finalText;
            stopReason = handled.stopReason ?? stopReason;
          }
        }
        if (
          opts.sessionId &&
          this.activeProcesses.get(opts.sessionId) === record
        ) {
          this.activeProcesses.delete(opts.sessionId);
        }
        if (record.killTimer) clearTimeout(record.killTimer);
        if (
          opts.sessionId &&
          !record.cancelled &&
          code !== 0 &&
          isAuthText(record.stderr)
        ) {
          this.emitSessionEvent(opts.sessionId, "error", {
            message: this.classifyExitError(code, record.stderr),
            failureKind: "auth",
          });
        }
        if (opts.sessionId && opts.activeForSession) {
          const event = record.cancelled ? "cancelled" : "stopped";
          this.emitSessionEvent(opts.sessionId, event, {
            sessionId: opts.sessionId,
            response: finalText,
            exitCode: code,
            signal,
          });
        }
        resolveRun({
          code,
          signal,
          stderr: record.stderr,
          finalText,
          stopReason: record.cancelled ? "cancelled" : stopReason,
          cancelled: record.cancelled,
          durationMs: Date.now() - startedAt,
        });
      });

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        setTimeout(() => {
          if (!proc.killed) this.terminateProcess(opts.sessionId ?? "", record);
        }, opts.timeoutMs).unref?.();
      }
    });
  }

  private parseNdjson(
    line: string,
    sessionId?: string,
  ): AcpJsonRpcMessage | null {
    try {
      return JSON.parse(line) as AcpJsonRpcMessage;
    } catch {
      this.log("warn", "malformed acpx NDJSON line ignored", {
        sessionId,
        line: line.slice(0, 200),
      });
      return null;
    }
  }

  private handleAcpEvent(
    event: AcpJsonRpcMessage,
    localSessionId: string | undefined,
    currentFinalText: string,
    startedAt: number,
    emitPromptTerminalEvents: boolean,
    capturedToolOutputs: Set<string>,
  ): { finalText: string; stopReason?: string } {
    const protocolSessionId = extractSessionId(event);
    const sessionId = localSessionId ?? protocolSessionId;
    if (
      localSessionId &&
      protocolSessionId &&
      protocolSessionId !== localSessionId
    ) {
      void this.store
        .update(localSessionId, { acpxSessionId: protocolSessionId })
        .catch(() => undefined);
    }
    for (const callback of this.acpCallbacks) callback(event, sessionId);
    const method = typeof event.method === "string" ? event.method : undefined;
    const params = asRecord(event.params);
    const result = asRecord(event.result);
    let finalText = currentFinalText;
    let stopReason: string | undefined;

    // Real ACP wraps session/update payload under params.update.{sessionUpdate,...}
    // Some adapters put fields at params.* directly. Look in both places.
    const updateBlock = asRecord(params?.update) ?? params;
    const sessionUpdate = updateBlock?.sessionUpdate ?? params?.sessionUpdate;

    if (
      sessionId &&
      (method === "session_started" || sessionUpdate === "session_started")
    ) {
      this.emitSessionEvent(sessionId, "ready", { event });
    }

    if (sessionId && method === "permission/request") {
      const description = stringifyMaybe(
        params?.description ?? params?.message ?? "permission required",
      );
      this.emitSessionEvent(sessionId, "blocked", {
        message: description,
        request: params,
      });
      if (isAuthText(description))
        this.emitSessionEvent(sessionId, "login_required", {
          message: description,
          request: params,
        });
      void this.store.updateStatus(sessionId, "blocked").catch(() => undefined);
    }

    if (sessionId && method === "session/update") {
      // agent_message_chunk: content.text streams
      const content = asRecord(updateBlock?.content);
      const role = stringifyMaybe(
        updateBlock?.role ?? params?.role ?? asRecord(params?.message)?.role,
      );
      if (
        sessionUpdate === "agent_message_chunk" &&
        content?.type === "text" &&
        typeof content.text === "string"
      ) {
        finalText += content.text;
        this.appendOutput(sessionId, content.text);
        this.emitSessionEvent(sessionId, "message", { text: content.text });
      }
      // Some adapters put text directly at content level.
      else if (
        !sessionUpdate &&
        role === "assistant" &&
        content?.type === "text" &&
        typeof content.text === "string"
      ) {
        finalText += content.text;
        this.appendOutput(sessionId, content.text);
        this.emitSessionEvent(sessionId, "message", { text: content.text });
      }
      // tool_call: emit tool_running while in_progress; ignore in_progress -> failed/completed transitions don't need re-emit
      if (
        sessionUpdate === "tool_call" ||
        sessionUpdate === "tool_call_update"
      ) {
        const status = stringifyMaybe(updateBlock?.status);
        const toolOutput = updateBlock?.rawOutput ?? updateBlock?.content;
        const toolCall: AcpToolCall = {
          id: stringifyMaybe(updateBlock?.toolCallId ?? updateBlock?.id) ?? "",
          title: stringifyMaybe(updateBlock?.title) ?? "",
          status: (status as AcpToolCall["status"]) ?? "running",
          output: stringifyMaybe(toolOutput),
        };
        if (status === "in_progress" || status === "running") {
          this.emitSessionEvent(sessionId, "tool_running", { toolCall });
          void this.store
            .updateStatus(sessionId, "tool_running")
            .catch(() => undefined);
        } else {
          const captured = captureTerminalToolOutput(
            toolCall,
            toolOutput,
            capturedToolOutputs,
          );
          if (captured) {
            finalText = appendTextBlock(finalText, captured);
            this.appendOutput(sessionId, captured);
          }
        }
      }
      // usage_update is informational; we don't currently surface it but could log
      // available_commands_update is metadata; ignore for now
    }

    if (sessionId && result && typeof result.stopReason === "string") {
      stopReason = result.stopReason;
      if (emitPromptTerminalEvents && stopReason === "end_turn") {
        this.emitSessionEvent(sessionId, "task_complete", {
          response: finalText,
          durationMs: Date.now() - startedAt,
          stopReason,
        });
      } else if (emitPromptTerminalEvents && stopReason === "error") {
        this.emitSessionEvent(sessionId, "error", {
          message: "acpx prompt ended with stopReason error",
          stopReason,
        });
      }
    }

    if (sessionId && event.error && typeof event.error === "object") {
      const message = errorMessage(
        (event.error as { message?: unknown }).message ?? event.error,
      );
      this.emitSessionEvent(sessionId, "error", { message });
    }

    return { finalText, stopReason };
  }

  emitSessionEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): void {
    for (const callback of [...this.sessionCallbacks]) {
      try {
        callback(sessionId, event, data);
      } catch (err) {
        this.log("warn", "session event callback failed", {
          sessionId,
          event,
          error: errorMessage(err),
        });
      }
    }
  }

  private async requireSession(sessionId: string): Promise<SessionInfo> {
    const session = await this.store.get(sessionId);
    if (!session) throw new Error(`acpx session not found: ${sessionId}`);
    return session;
  }

  private async enforceSessionLimit(): Promise<void> {
    const sessions = await this.store.list();
    const active = sessions.filter(
      (s) =>
        !["stopped", "errored", "completed", "cancelled"].includes(s.status),
    );
    if (active.length >= this.maxSessions)
      throw new Error(`acpx max session limit reached (${this.maxSessions})`);
  }

  private async stopTrackedProcess(sessionId: string): Promise<void> {
    const active = this.activeProcesses.get(sessionId);
    if (!active) return;
    this.terminateProcess(sessionId, active);
    await new Promise<void>((resolveStop) =>
      active.proc.once("close", () => resolveStop()),
    );
  }

  private terminateProcess(_sessionId: string, record: ProcessRecord): void {
    record.killedByService = true;
    if (!record.exited) record.proc.kill("SIGTERM");
    record.killTimer = setTimeout(() => {
      if (!record.exited) record.proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  private buildEnv(
    extra?: Record<string, string | undefined>,
    customCredentials?: Record<string, string | undefined>,
    model?: string,
    agentType?: AgentType,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== "string") continue;
      if (DENY_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
      if (shouldForwardEnv(key)) env[key] = value;
    }
    for (const [key, value] of Object.entries(customCredentials ?? {})) {
      if (typeof value === "string") env[key] = value;
    }
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === "string") env[key] = value;
    }
    if (model) {
      env.OPENAI_MODEL = model;
      if (agentType === "claude") env.ANTHROPIC_MODEL = model;
      if (agentType === "opencode") env.OPENCODE_MODEL = model;
    }
    if (agentType === "opencode") {
      const opencode = buildOpencodeAcpEnv(this.runtime, env, model);
      Object.assign(env, opencode.env);
      if (opencode.config) {
        this.log("info", "OpenCode ACP provider configured", {
          provider: opencode.config.providerLabel,
          model: opencode.config.model,
          smallModel: opencode.config.smallModel,
          vendored: Boolean(opencode.vendoredShimDir),
        });
      }
    }
    return env;
  }

  private classifyExitError(code: number | null, stderr: string): string {
    if (code === 1 && isAuthText(stderr))
      return "acpx auth failed. Re-authenticate the selected agent or set ACPX_AUTH_* credentials.";
    if (code === 4)
      return "acpx session was not found. This is likely an internal session bookkeeping error.";
    if (code === 5) return "acpx permission denied.";
    if (code === 3) return "acpx prompt timed out.";
    if (stderr.trim()) return stderr.trim().slice(0, 500);
    return `acpx subprocess exited with code ${code ?? "unknown"}`;
  }

  private lastOutput(sessionId: string): string {
    return (this.outputBuffers.get(sessionId) ?? []).join("");
  }

  private appendOutput(sessionId: string, text: string): void {
    const buffer = this.outputBuffers.get(sessionId) ?? [];
    buffer.push(text);
    if (buffer.length > 2_000) buffer.splice(0, buffer.length - 2_000);
    this.outputBuffers.set(sessionId, buffer);
  }

  private setting(key: string): string | undefined {
    const fromRuntime = this.runtime.getSetting?.(key);
    if (typeof fromRuntime === "string" && fromRuntime.length > 0)
      return fromRuntime;
    const fromEnv = process.env[key];
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }

  private ensureStarted(): void {
    if (!this.started) throw new Error("AcpService not started");
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void {
    const loggerFn = this.logger[level] as
      | ((message: string, data?: unknown) => void)
      | undefined;
    loggerFn?.call(this.logger, `[AcpService] ${message}`, data);
  }

  private shouldDisableTerminalCapability(): boolean {
    const configured = boolSetting(
      this.setting("ELIZA_ACP_NO_TERMINAL") ?? this.setting("ACPX_NO_TERMINAL"),
    );
    return configured === true;
  }
}

function approvalArgs(preset: ApprovalPreset): string[] {
  switch (preset) {
    case "autonomous":
    case "permissive":
      return ["--approve-all"];
    case "readonly":
      return ["--deny-all"];
    default:
      return ["--approve-reads", "--non-interactive-permissions", "deny"];
  }
}

function normalizeApprovalPreset(value: string | undefined): ApprovalPreset {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "readonly" ||
    normalized === "read-only" ||
    normalized === "deny-all"
  )
    return "readonly";
  if (
    normalized === "standard" ||
    normalized === "auto" ||
    normalized === "default"
  )
    return "standard";
  if (
    normalized === "permissive" ||
    normalized === "approve-all" ||
    normalized === "full-access"
  )
    return "permissive";
  if (normalized === "autonomous") return "autonomous";
  return "autonomous";
}

function shouldForwardEnv(key: string): boolean {
  return (
    key === "PATH" ||
    key === "HOME" ||
    key === "USER" ||
    key === "LANG" ||
    key === "LC_ALL" ||
    key === "LC_CTYPE" ||
    key === "TZ" ||
    key === "TERM" ||
    key.startsWith("ACPX_AUTH_") ||
    key.startsWith("ELIZA_") ||
    [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CEREBRAS_API_KEY",
      "CEREBRAS_BASE_URL",
      "CEREBRAS_MODEL",
      "OPENAI_MODEL",
      "ANTHROPIC_MODEL",
      "OPENCODE_MODEL",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_TERMINAL_TITLE",
      "CODEX_HOME",
    ].includes(key)
  );
}

function extractSessionId(event: AcpJsonRpcMessage): string | undefined {
  const params = asRecord(event.params);
  const result = asRecord(event.result);
  const candidates = [
    params?.sessionId,
    params?.session_id,
    result?.sessionId,
    result?.acpxSessionId,
    (event as Record<string, unknown>).sessionId,
  ];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringifyMaybe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function appendTextBlock(current: string, block: string): string {
  if (!current) return block;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${block}`;
}

function captureTerminalToolOutput(
  toolCall: AcpToolCall,
  rawOutput: unknown,
  capturedToolOutputs: Set<string>,
): string | undefined {
  const output = normalizeToolOutput(rawOutput);
  if (!output) return undefined;
  const key = `${toolCall.id}\0${output}`;
  if (capturedToolOutputs.has(key)) return undefined;
  capturedToolOutputs.add(key);
  const truncated =
    output.length > MAX_CAPTURED_TOOL_OUTPUT_CHARS
      ? `${output.slice(0, MAX_CAPTURED_TOOL_OUTPUT_CHARS)}\n[tool output truncated]`
      : output;
  const title = toolCall.title?.trim() || "tool output";
  return `[tool output: ${title}]\n${truncated}\n${TOOL_OUTPUT_END_MARKER}`;
}

function normalizeToolOutput(rawOutput: unknown): string {
  if (typeof rawOutput === "string") {
    const trimmed = rawOutput.trim();
    const parsed = parseJsonRecord(trimmed);
    return extractToolOutputText(parsed)?.trim() || trimmed;
  }
  if (rawOutput === undefined || rawOutput === null) return "";
  const extracted = extractToolOutputText(rawOutput);
  return extracted?.trim() || JSON.stringify(rawOutput).trim();
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function extractToolOutputText(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): string | undefined {
  if (value === undefined || value === null || depth > 4) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractToolOutputText(entry, depth + 1, seen))
      .filter((entry): entry is string => Boolean(entry));
    return uniqueStrings(parts).join("\n") || undefined;
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const parts = [
    "output",
    "stdout",
    "stderr",
    "content",
    "text",
    "message",
    "result",
    "response",
    "value",
  ]
    .filter((key) => key in record)
    .map((key) => extractToolOutputText(record[key], depth + 1, seen))
    .filter((entry): entry is string => Boolean(entry));
  return uniqueStrings(parts).join("\n") || undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function isAuthText(text: string): boolean {
  return /authenticate|unauthorized|\b401\b|login|required auth|api key|invalid_grant/i.test(
    text,
  );
}

function capStderr(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= STDERR_CAP_BYTES) return text;
  return text.slice(-STDERR_CAP_BYTES);
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 80);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function boolSetting(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function createDefaultSessionStore(runtime: RuntimeLike): SessionStore {
  const runtimeForStore = {
    databaseAdapter: runtime.databaseAdapter,
    logger: runtime.logger,
    getSetting: (key: string) => {
      const value = runtime.getSetting?.(key);
      return typeof value === "string" ? value : undefined;
    },
  };
  return new AcpSessionStore({
    runtime: runtimeForStore,
    backend: parseSessionStoreBackend(
      runtimeForStore.getSetting("ELIZA_ACP_SESSION_STORE_BACKEND") ??
        process.env.ELIZA_ACP_SESSION_STORE_BACKEND,
    ),
  });
}

function parseSessionStoreBackend(
  value: string | undefined | null,
): SessionStoreBackend | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "runtime-db" ||
    normalized === "file" ||
    normalized === "memory"
  ) {
    return normalized;
  }
  return undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toSpawnResult(session: SessionInfo): SpawnResult {
  return {
    sessionId: session.id,
    id: session.id,
    name: session.name ?? session.id,
    agentType: session.agentType,
    workdir: session.workdir,
    status: session.status,
    acpxRecordId: session.acpxRecordId,
    acpxSessionId: session.acpxSessionId,
    agentSessionId: session.agentSessionId,
    pid: session.pid,
    authReady: session.status !== "errored",
    metadata: session.metadata,
  };
}
