/** @module services/pty-service */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type IAgentRuntime, logger, type Service } from "@elizaos/core";
import {
  type AdapterType,
  type AgentFileDescriptor,
  type ApprovalConfig,
  type ApprovalPreset,
  type BaseCodingAdapter,
  checkAdapters,
  createAdapter,
  generateApprovalConfig,
  type PreflightResult,
  type WriteMemoryOptions,
} from "coding-agent-adapters";
import { PTYConsoleBridge } from "pty-console";
import type {
  BunCompatiblePTYManager,
  PTYManager,
  SessionFilter,
  SessionHandle,
  SessionMessage,
  SpawnConfig,
  StallClassification,
  WorkerSessionHandle,
} from "pty-manager";
import { AgentMetricsTracker } from "./agent-metrics.ts";
import type { AgentSelectionStrategy } from "./agent-selection.ts";
import {
  captureTaskResponse,
  cleanForChat,
  extractCompletionSummary,
  peekTaskResponse,
} from "./ansi-utils.ts";
import { readConfigEnvKey } from "./config-env.ts";
import {
  type CoordinatorNormalizedEvent,
  normalizeCoordinatorEvent,
} from "./coordinator-event-normalizer.ts";
import {
  captureFeed,
  captureLifecycle,
  captureSessionOpen,
  isDebugCaptureEnabled,
} from "./debug-capture.ts";
import {
  handleGeminiAuth as handleGeminiAuthFlow,
  pushDefaultRules as pushDefaultAutoResponseRules,
} from "./pty-auto-response.ts";
import { initializePTYManager } from "./pty-init.ts";
import {
  getSessionOutput as getSessionOutputIO,
  type SessionIOContext,
  sendKeysToSession as sendKeysToSessionIO,
  sendToSession as sendToSessionIO,
  stopSession as stopSessionIO,
  subscribeToOutput as subscribeToOutputIO,
} from "./pty-session-io.ts";
import {
  buildSpawnConfig,
  setupDeferredTaskDelivery,
  setupOutputBuffer,
} from "./pty-spawn.ts";
import type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventCallback,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.ts";
import { isPiAgentType, toPiCommand } from "./pty-types.ts";
import {
  classifyAndDecideForCoordinator,
  classifyStallOutput,
} from "./stall-classifier.ts";
import { SwarmCoordinator } from "./swarm-coordinator.ts";
import { POST_SEND_COOLDOWN_MS } from "./swarm-decision-loop.ts";
import {
  assistTaskAgentBrowserLogin,
  augmentTaskAgentPreflightResults,
  getTaskAgentLoginHint,
  launchTaskAgentAuthFlow,
  probeTaskAgentAuth,
  type TaskAgentAuthFlowHandle,
  type TaskAgentAuthLaunchResult,
  type TaskAgentAuthStatus,
} from "./task-agent-auth.ts";
import {
  buildTaskAgentTaskProfile,
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
  type SupportedTaskAgentAdapter,
  type TaskAgentFrameworkState,
  type TaskAgentTaskProfileInput,
} from "./task-agent-frameworks.ts";

/**
 * Grace period after `task_complete` before auto-stopping a PTY session.
 * Short enough that stale subagents don't linger (and trigger spurious
 * stall classifications that fire phantom heartbeats in downstream
 * streamers), long enough that any backgrounded processes spawned by
 * the agent can detach from the PTY parent before it exits.
 *
 * Previously 5000 ms in our nubs/full-working-state fork branch
 * (commit 66a9a74); upstream alpha removed the auto-stop entirely in a
 * later refactor which caused subagents to sit around for minutes after
 * finishing their turn.
 */
const TASK_COMPLETE_STOP_DELAY_MS = 5_000;

/**
 * Portable safety floor injected into every spawned coding-agent's memory
 * file. Locks the agent to its allocated workspace dir so it never wanders
 * into $HOME or /tmp regardless of caller-supplied memoryContent. Deployment-
 * specific conventions (hosting, URLs, etc.) belong in caller memoryContent.
 */
function buildWorkspaceLockMemory(workdir: string): string {
  return `# Workspace

Your working directory is \`${workdir}\`. Stay inside it: do not \`cd\` to \`/tmp\`, \`/\`, \`$HOME\`, or any other path outside the workspace. Create all files, run all builds, and start all servers from this directory. If you need scratch space, make a subdirectory here.`;
}

function prependWorkspaceLockToTask(
  task: string | undefined,
  workspaceLock: string,
): string | undefined {
  if (!task?.trim()) {
    return undefined;
  }
  return `${workspaceLock}\n\n---\n\n${task}`;
}

export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.ts";
// Re-export for backward compatibility
export { normalizeAgentType } from "./pty-types.ts";

/**
 * Retrieve the SwarmCoordinator from the PTYService registered on the runtime.
 * Returns undefined if PTYService or coordinator is not available.
 */
export function getCoordinator(
  runtime: IAgentRuntime,
): SwarmCoordinator | undefined {
  const ptyService = runtime.getService("PTY_SERVICE") as unknown as
    | PTYService
    | undefined;
  return ptyService?.coordinator ?? undefined;
}

export class PTYService {
  static serviceType = "PTY_SERVICE";
  capabilityDescription =
    "Manages asynchronous PTY task-agent sessions for open-ended background work";

  private runtime: IAgentRuntime;
  private manager: PTYManager | BunCompatiblePTYManager | null = null;
  private usingBunWorker: boolean = false;
  private serviceConfig: PTYServiceConfig;
  private sessionNames: Map<string, string> = new Map();
  private sessionMetadata: Map<string, Record<string, unknown>> = new Map();
  private sessionWorkdirs: Map<string, string> = new Map();
  private eventCallbacks: SessionEventCallback[] = [];
  private normalizedEventCallbacks: Array<
    (event: CoordinatorNormalizedEvent) => void
  > = [];
  private outputUnsubscribers: Map<string, () => void> = new Map();
  private transcriptUnsubscribers: Map<string, () => void> = new Map();
  private sessionOutputBuffers: Map<string, string[]> = new Map();
  private completionReconcileTimers: Map<
    string,
    ReturnType<typeof setInterval>
  > = new Map();
  private completionSignalSince: Map<string, number> = new Map();
  private terminalSessionStates: Map<
    string,
    {
      status: SessionInfo["status"];
      createdAt: Date;
      lastActivityAt: Date;
      reason?: string;
    }
  > = new Map();
  private adapterCache: Map<string, BaseCodingAdapter> = new Map();
  /** Tracks the buffer index when a task was sent, so we can capture the response on completion */
  private taskResponseMarkers: Map<string, number> = new Map();
  /** Captures "Task completion trace" log entries from worker stderr (rolling, capped at 200) */
  private traceEntries: Array<string | Record<string, unknown>> = [];
  private static readonly MAX_TRACE_ENTRIES = 200;
  /** Lightweight per-agent-type metrics for observability */
  private metricsTracker = new AgentMetricsTracker();
  /** Active provider auth helper processes keyed by agent type. */
  private activeAuthFlows: Map<string, TaskAgentAuthFlowHandle> = new Map();
  /** Background auth-recovery watchers keyed by blocked session id. */
  private authRecoveryTimers: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  /** Console bridge for terminal output streaming and buffered hydration */
  consoleBridge: PTYConsoleBridge | null = null;
  /** Swarm coordinator instance (if active). Accessed via getCoordinator(runtime). */
  coordinator: SwarmCoordinator | null = null;

  constructor(runtime: IAgentRuntime, config: PTYServiceConfig = {}) {
    this.runtime = runtime;
    this.serviceConfig = {
      maxLogLines: config.maxLogLines ?? 1000,
      debug: config.debug ?? false,
      registerCodingAdapters: config.registerCodingAdapters ?? true,
      maxConcurrentSessions: config.maxConcurrentSessions ?? 8,
      defaultApprovalPreset: config.defaultApprovalPreset ?? "autonomous",
    };
  }

  static async start(runtime: IAgentRuntime): Promise<PTYService> {
    const config = runtime.getSetting("PTY_SERVICE_CONFIG") as
      | PTYServiceConfig
      | null
      | undefined;
    const service = new PTYService(runtime, config ?? {});
    await service.initialize();

    // Wire the SwarmCoordinator — done here instead of plugin init()
    // because ElizaOS calls Service.start() reliably but may not call
    // plugin.init() depending on the registration path.
    // Guard: the framework may call start() more than once — skip if
    // a coordinator is already registered on this runtime.
    const servicesMap = runtime.services as Map<string, Service[]> | undefined;
    const existing = servicesMap?.get?.("SWARM_COORDINATOR");
    if (existing && existing.length > 0) {
      service.coordinator = existing[0] as unknown as SwarmCoordinator;
      logger.info(
        "[PTYService] SwarmCoordinator already registered, skipping duplicate start",
      );
    } else {
      try {
        const coordinator = new SwarmCoordinator(runtime);
        await coordinator.start(service);
        service.coordinator = coordinator;

        // Register the coordinator as a discoverable runtime service so
        // server.ts can find it via runtime.getService("SWARM_COORDINATOR")
        // without a hard import from this plugin package.
        // We bypass registerService() (which would call start() again) and
        // write directly to the services map that getService() reads from.
        servicesMap?.set?.("SWARM_COORDINATOR", [
          coordinator as unknown as Service,
        ]);

        logger.info("[PTYService] SwarmCoordinator wired and started");
      } catch (err) {
        logger.error(`[PTYService] Failed to wire SwarmCoordinator: ${err}`);
      }
    }

    return service;
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  private async initialize(): Promise<void> {
    const result = await initializePTYManager({
      serviceConfig: this.serviceConfig,
      classifyStall: (id, out) => this.classifyStall(id, out),
      emitEvent: (id, event, data) => this.emitEvent(id, event, data),
      handleGeminiAuth: (id) => this.handleGeminiAuth(id),
      sessionOutputBuffers: this.sessionOutputBuffers,
      taskResponseMarkers: this.taskResponseMarkers,
      metricsTracker: this.metricsTracker,
      traceEntries: this.traceEntries,
      maxTraceEntries: PTYService.MAX_TRACE_ENTRIES,
      log: (msg) => this.log(msg),
      handleWorkerExit: (info) => this.handleWorkerExit(info),
      hasActiveTask: (sessionId) => {
        const coordinator = this.coordinator;
        if (!coordinator) return false;
        const taskCtx = coordinator.getTaskContext(sessionId);
        // tool_running counts as active for PTY purposes — the task is
        // still alive, just executing a tool. matches the same expansion
        // applied to handleTurnComplete and drainPendingTurnComplete so
        // tool-heavy scratch tasks aren't treated as inactive mid-run.
        return (
          taskCtx?.status === "active" || taskCtx?.status === "tool_running"
        );
      },
      hasTaskActivity: (sessionId) => {
        const coordinator = this.coordinator;
        if (!coordinator) return false;
        const taskCtx = coordinator.getTaskContext(sessionId);
        if (!taskCtx) return false;
        // Task has activity if the initial task was delivered (agent started
        // working) OR coordinator made decisions. The taskDelivered flag
        // covers agents that finish without hitting any blocking prompts.
        return taskCtx.taskDelivered || taskCtx.decisions.length > 0;
      },
      markTaskDelivered: (sessionId) => {
        const coordinator = this.coordinator;
        if (!coordinator) return;
        void coordinator.setTaskDelivered(sessionId);
      },
    });
    this.manager = result.manager;
    this.usingBunWorker = result.usingBunWorker;

    // Wire console bridge for terminal output streaming / hydration
    try {
      this.consoleBridge = new PTYConsoleBridge(this.manager, {
        maxBufferedCharsPerSession: 100_000,
      });
      this.log("PTYConsoleBridge wired");
    } catch (err) {
      this.log(`Failed to wire PTYConsoleBridge: ${err}`);
    }

    this.log("PTYService initialized");
  }

  async stop(): Promise<void> {
    // Stop the coordinator if one was wired to this service
    if (this.coordinator) {
      await this.coordinator.stop();
      // Remove from runtime services map
      (this.runtime.services as Map<string, Service[]>).delete(
        "SWARM_COORDINATOR",
      );
      this.coordinator = null;
    }

    if (this.consoleBridge) {
      this.consoleBridge.close();
      this.consoleBridge = null;
    }

    for (const unsubscribe of this.outputUnsubscribers.values()) {
      unsubscribe();
    }
    this.outputUnsubscribers.clear();
    for (const unsubscribe of this.transcriptUnsubscribers.values()) {
      unsubscribe();
    }
    this.transcriptUnsubscribers.clear();
    for (const timer of this.completionReconcileTimers.values()) {
      clearInterval(timer);
    }
    this.completionReconcileTimers.clear();
    this.completionSignalSince.clear();
    for (const timer of this.authRecoveryTimers.values()) {
      clearInterval(timer);
    }
    this.authRecoveryTimers.clear();
    for (const flow of this.activeAuthFlows.values()) {
      try {
        flow.stop();
      } catch {
        // Ignore auth-helper cleanup failures on shutdown.
      }
    }
    this.activeAuthFlows.clear();

    if (this.manager) {
      await this.manager.shutdown();
      this.manager = null;
    }
    this.sessionMetadata.clear();
    this.sessionNames.clear();
    this.sessionWorkdirs.clear();
    this.sessionOutputBuffers.clear();
    this.log("PTYService shutdown complete");
  }

  private generateSessionId(): string {
    return `pty-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Build a SessionIOContext from current instance state. */
  private ioContext(): SessionIOContext {
    return {
      manager: this.manager as PTYManager | BunCompatiblePTYManager,
      usingBunWorker: this.usingBunWorker,
      sessionOutputBuffers: this.sessionOutputBuffers,
      taskResponseMarkers: this.taskResponseMarkers,
      outputUnsubscribers: this.outputUnsubscribers,
    };
  }

  /**
   * Spawn a new PTY session for a coding agent
   */
  async spawnSession(options: SpawnSessionOptions): Promise<SessionInfo> {
    if (!this.manager) {
      throw new Error("PTYService not initialized");
    }

    const piRequested = isPiAgentType(options.agentType);
    const resolvedAgentType: CodingAgentType = piRequested
      ? "shell"
      : options.agentType;
    const effectiveApprovalPreset =
      options.approvalPreset ??
      (resolvedAgentType !== "shell" ? this.defaultApprovalPreset : undefined);

    const maxSessions = this.serviceConfig.maxConcurrentSessions ?? 8;
    const activeSessions = (await this.listSessions()).length;
    if (activeSessions >= maxSessions) {
      throw new Error(`Concurrent session limit reached (${maxSessions})`);
    }

    const sessionId = this.generateSessionId();
    const workdir = options.workdir ?? process.cwd();
    const workspaceLock = buildWorkspaceLockMemory(workdir);
    const shouldWriteMemoryFile =
      resolvedAgentType !== "shell" && Boolean(options.memoryContent?.trim());
    const effectiveInitialTask = shouldWriteMemoryFile
      ? options.initialTask
      : prependWorkspaceLockToTask(options.initialTask, workspaceLock);
    const resolvedInitialTask = piRequested
      ? toPiCommand(effectiveInitialTask)
      : effectiveInitialTask;

    // Store workdir for later retrieval
    this.sessionWorkdirs.set(sessionId, workdir);

    // Write memory content before spawning so the agent reads it on startup.
    // Always prepend the workspace lock so the spawned agent stays inside its
    // allocated workdir even when the caller passes nothing or unrelated rules.
    if (shouldWriteMemoryFile) {
      const fullMemory = options.memoryContent
        ? `${workspaceLock}\n\n---\n\n${options.memoryContent}`
        : workspaceLock;
      try {
        const writtenPath = await this.writeMemoryFile(
          resolvedAgentType as AdapterType,
          workdir,
          fullMemory,
        );
        this.log(`Wrote memory file for ${resolvedAgentType}: ${writtenPath}`);
      } catch (err) {
        this.log(
          `Failed to write memory file for ${resolvedAgentType}: ${err}`,
        );
      }
    }

    // Write approval config files to workspace before spawn
    if (effectiveApprovalPreset && resolvedAgentType !== "shell") {
      try {
        const written = await this.getAdapter(
          resolvedAgentType as AdapterType,
        ).writeApprovalConfig(workdir, {
          name: options.name,
          type: resolvedAgentType,
          workdir,
          adapterConfig: { approvalPreset: effectiveApprovalPreset },
        } as SpawnConfig);
        this.log(
          `Wrote approval config (${effectiveApprovalPreset}) for ${resolvedAgentType}: ${written.join(", ")}`,
        );
      } catch (err) {
        this.log(`Failed to write approval config: ${err}`);
      }
    }

    // Inject agent-specific settings and HTTP hooks
    const hookUrl = `http://localhost:${(this.runtime.getSetting("SERVER_PORT") as string | undefined) ?? "2138"}/api/coding-agents/hooks`;

    if (resolvedAgentType === "claude") {
      try {
        const settingsPath = join(workdir, ".claude", "settings.json");
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await readFile(settingsPath, "utf-8"));
        } catch {
          // File may not exist yet
        }
        const permissions =
          (settings.permissions as Record<string, unknown>) ?? {};
        permissions.allowedDirectories = [workdir];
        settings.permissions = permissions;

        // Inject HTTP hooks for deterministic state detection.
        // Merge with existing hooks to preserve workspace-owned hook entries.
        const adapter = this.getAdapter("claude");
        const hookProtocol = adapter.getHookTelemetryProtocol({
          httpUrl: hookUrl,
          sessionId,
        });
        if (hookProtocol) {
          const existingHooks = (settings.hooks ?? {}) as Record<
            string,
            unknown
          >;
          settings.hooks = { ...existingHooks, ...hookProtocol.settingsHooks };
          this.log(`Injecting HTTP hooks for session ${sessionId}`);
        }

        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(
          settingsPath,
          JSON.stringify(settings, null, 2),
          "utf-8",
        );
        this.log(`Wrote allowedDirectories [${workdir}] to ${settingsPath}`);
      } catch (err) {
        this.log(`Failed to write Claude settings: ${err}`);
      }
    }

    if (resolvedAgentType === "gemini") {
      try {
        const settingsPath = join(workdir, ".gemini", "settings.json");
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await readFile(settingsPath, "utf-8"));
        } catch {
          // File may not exist yet
        }

        // Inject command hooks that curl the orchestrator endpoint.
        // Merge with existing hooks to preserve workspace-owned hook entries.
        const adapter = this.getAdapter("gemini");
        const hookProtocol = adapter.getHookTelemetryProtocol({
          httpUrl: hookUrl,
          sessionId,
        });
        if (hookProtocol) {
          const existingHooks = (settings.hooks ?? {}) as Record<
            string,
            unknown
          >;
          settings.hooks = { ...existingHooks, ...hookProtocol.settingsHooks };
          this.log(`Injecting Gemini CLI hooks for session ${sessionId}`);
        }

        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(
          settingsPath,
          JSON.stringify(settings, null, 2),
          "utf-8",
        );
      } catch (err) {
        this.log(`Failed to write Gemini settings: ${err}`);
      }
    }

    // Ensure injected config/memory files are gitignored so agents don't
    // commit them. Appends to existing .gitignore if present.
    if (resolvedAgentType !== "shell" && workdir !== process.cwd()) {
      await this.ensureOrchestratorGitignore(workdir);
    }

    const spawnConfig = buildSpawnConfig(
      sessionId,
      {
        ...options,
        agentType: resolvedAgentType,
        initialTask: resolvedInitialTask,
        approvalPreset: effectiveApprovalPreset,
      },
      workdir,
    );
    const session = await this.manager.spawn(spawnConfig);
    this.terminalSessionStates.delete(session.id);
    this.sessionNames.set(session.id, options.name);

    // Store metadata separately (always include agentType for stall classification)
    this.sessionMetadata.set(session.id, {
      ...options.metadata,
      requestedType: options.metadata?.requestedType ?? options.agentType,
      agentType: resolvedAgentType,
      coordinatorManaged: !!options.skipAdapterAutoResponse,
    });

    // Build spawn context for delegating to extracted spawn modules
    const ctx = {
      manager: this.manager as PTYManager | BunCompatiblePTYManager,
      usingBunWorker: this.usingBunWorker,
      serviceConfig: this.serviceConfig,
      sessionMetadata: this.sessionMetadata,
      sessionWorkdirs: this.sessionWorkdirs,
      sessionOutputBuffers: this.sessionOutputBuffers,
      outputUnsubscribers: this.outputUnsubscribers,
      taskResponseMarkers: this.taskResponseMarkers,
      getAdapter: (t: AdapterType) => this.getAdapter(t),
      sendToSession: (id: string, input: string) =>
        this.sendToSession(id, input),
      sendKeysToSession: (id: string, keys: string | string[]) =>
        this.sendKeysToSession(id, keys),
      writeRawToSession: async (id: string, data: string) => {
        if (!this.manager) return;
        if (this.usingBunWorker) {
          await (this.manager as BunCompatiblePTYManager).writeRaw(id, data);
          return;
        }
        const ptySession = (this.manager as PTYManager).getSession(id);
        ptySession?.writeRaw(data);
      },
      pushDefaultRules: (id: string, type: string) =>
        this.pushDefaultRules(id, type),
      toSessionInfo: (s: SessionHandle | WorkerSessionHandle, w?: string) =>
        this.toSessionInfo(s, w),
      log: (msg: string) => this.log(msg),
      markTaskDelivered: (sessionId: string) => {
        const coordinator = this.coordinator;
        if (!coordinator) return;
        void coordinator.setTaskDelivered(sessionId);
      },
    };

    // Buffer output for Bun worker path (no logs() method available)
    if (this.usingBunWorker) {
      setupOutputBuffer(ctx, session.id);
    }

    // Debug capture: open a capture session and wire stdout feed.
    // Capture files persist after the agent is killed for offline analysis.
    if (isDebugCaptureEnabled()) {
      captureSessionOpen(session.id, resolvedAgentType).catch(() => {});
      if (this.usingBunWorker) {
        (this.manager as BunCompatiblePTYManager).onSessionData(
          session.id,
          (data: string) => {
            captureFeed(session.id, data, "stdout");
          },
        );
      } else {
        const ptySession = (this.manager as PTYManager).getSession(session.id);
        if (ptySession) {
          ptySession.on("output", (data: string) => {
            captureFeed(session.id, data, "stdout");
          });
        }
      }
    }

    this.wireTranscriptCapture(session.id);

    // Defer initial task until session is ready.
    // IMPORTANT: Set up the listener BEFORE pushDefaultRules (which has a 1500ms sleep),
    // otherwise session_ready fires during pushDefaultRules and the listener misses it.
    if (resolvedInitialTask) {
      setupDeferredTaskDelivery(
        ctx,
        session,
        resolvedInitialTask,
        resolvedAgentType,
      );
    }

    await this.pushDefaultRules(session.id, resolvedAgentType);
    this.metricsTracker.get(resolvedAgentType).spawned++;
    this.log(`Spawned session ${session.id} (${resolvedAgentType})`);
    return this.toSessionInfo(session, workdir);
  }

  private autoResponseContext() {
    return {
      manager: this.manager as PTYManager | BunCompatiblePTYManager,
      usingBunWorker: this.usingBunWorker,
      runtime: this.runtime,
      log: (msg: string) => this.log(msg),
    };
  }

  private async pushDefaultRules(
    sessionId: string,
    agentType: string,
  ): Promise<void> {
    if (!this.manager) return;
    await pushDefaultAutoResponseRules(
      this.autoResponseContext(),
      sessionId,
      agentType,
    );
  }

  private async handleGeminiAuth(sessionId: string): Promise<void> {
    await handleGeminiAuthFlow(
      this.autoResponseContext(),
      sessionId,
      (id, keys) => this.sendKeysToSession(id, keys),
    );
  }

  async sendToSession(
    sessionId: string,
    input: string,
  ): Promise<SessionMessage | undefined> {
    if (!this.manager) throw new Error("PTYService not initialized");
    captureFeed(sessionId, input, "stdin");
    void this.persistTranscript(sessionId, "stdin", input);
    const metadata = this.sessionMetadata.get(sessionId);
    if (metadata) {
      metadata.lastSentInput = input;
    }
    const message = await sendToSessionIO(this.ioContext(), sessionId, input);
    this.scheduleCompletionReconcile(sessionId);
    return message;
  }

  async sendKeysToSession(
    sessionId: string,
    keys: string | string[],
  ): Promise<void> {
    if (!this.manager) throw new Error("PTYService not initialized");
    const content = Array.isArray(keys) ? keys.join(",") : keys;
    void this.persistTranscript(sessionId, "keys", content);
    return sendKeysToSessionIO(this.ioContext(), sessionId, keys);
  }

  async stopSession(sessionId: string, force = false): Promise<void> {
    if (!this.manager) throw new Error("PTYService not initialized");
    captureLifecycle(sessionId, "session_stopped", force ? "force" : undefined);
    try {
      return await stopSessionIO(
        this.ioContext(),
        sessionId,
        this.sessionMetadata,
        this.sessionWorkdirs,
        (msg) => this.log(msg),
        force,
      );
    } finally {
      this.clearCompletionReconcile(sessionId);
      const authRecoveryTimer = this.authRecoveryTimers.get(sessionId);
      if (authRecoveryTimer) {
        clearInterval(authRecoveryTimer);
        this.authRecoveryTimers.delete(sessionId);
      }
      this.clearTranscriptCapture(sessionId);
    }
  }

  /** Default approval preset — runtime env var takes precedence over config. */
  get defaultApprovalPreset(): ApprovalPreset {
    const fromEnv = this.runtime.getSetting(
      "PARALLAX_DEFAULT_APPROVAL_PRESET",
    ) as string | undefined;
    if (
      fromEnv &&
      ["readonly", "standard", "permissive", "autonomous"].includes(fromEnv)
    ) {
      return fromEnv as ApprovalPreset;
    }
    return this.serviceConfig.defaultApprovalPreset ?? "autonomous";
  }

  /** Agent selection strategy — env var takes precedence. */
  get agentSelectionStrategy(): AgentSelectionStrategy {
    const fromEnv = this.runtime.getSetting(
      "PARALLAX_AGENT_SELECTION_STRATEGY",
    ) as string | undefined;
    if (fromEnv && (fromEnv === "fixed" || fromEnv === "ranked")) {
      return fromEnv;
    }
    return "fixed";
  }

  /**
   * Default agent type when strategy is "fixed".
   * Precedence: config file (`eliza.json` env section, written by the UI)
   * > runtime/env setting > "claude" fallback.
   */
  get defaultAgentType(): AdapterType {
    return this.explicitDefaultAgentType ?? "claude";
  }

  private get explicitDefaultAgentType(): AdapterType | null {
    const fromConfig = readConfigEnvKey("PARALLAX_DEFAULT_AGENT_TYPE");
    const fromRuntimeOrEnv =
      fromConfig ||
      (this.runtime.getSetting("PARALLAX_DEFAULT_AGENT_TYPE") as
        | string
        | undefined);
    if (
      fromRuntimeOrEnv &&
      ["claude", "gemini", "codex", "aider"].includes(
        fromRuntimeOrEnv.toLowerCase(),
      )
    ) {
      return fromRuntimeOrEnv.toLowerCase() as AdapterType;
    }
    return null;
  }

  /**
   * Resolve which agent type to use when the caller didn't specify one.
   *
   * When the caller explicitly configured a fixed default agent type, fixed
   * mode returns that pinned framework. Otherwise the resolver scores the
   * available frameworks from task shape, auth/install state, and recent
   * metrics so dynamic routing still works on unconfigured installs.
   */
  async resolveAgentType(
    selection?: TaskAgentTaskProfileInput,
  ): Promise<string> {
    if (
      this.agentSelectionStrategy === "fixed" &&
      this.explicitDefaultAgentType
    ) {
      return this.explicitDefaultAgentType;
    }
    const frameworkState = await this.getFrameworkState(selection);
    return frameworkState.preferred.id;
  }

  async getFrameworkState(
    selection?: TaskAgentTaskProfileInput,
  ): Promise<TaskAgentFrameworkState> {
    const profile = selection
      ? buildTaskAgentTaskProfile(selection)
      : undefined;
    return getTaskAgentFrameworkState(
      this.runtime,
      {
        checkAvailableAgents: (types) => this.checkAvailableAgents(types),
        getAgentMetrics: () => this.metricsTracker.getAll(),
      },
      profile
        ? {
            task: selection?.task,
            repo: selection?.repo,
            workdir: selection?.workdir,
            threadKind: profile.kind,
            subtaskCount: profile.subtaskCount,
            acceptanceCriteria: selection?.acceptanceCriteria,
          }
        : selection,
    );
  }

  getSession(sessionId: string): SessionInfo | undefined {
    if (!this.manager) return undefined;
    const session = this.manager.get(sessionId);
    if (!session) return this.toTerminalSessionInfo(sessionId);
    return this.toSessionInfo(session, this.sessionWorkdirs.get(sessionId));
  }

  async listSessions(filter?: SessionFilter): Promise<SessionInfo[]> {
    if (!this.manager) return [];
    const sessions = this.usingBunWorker
      ? await (this.manager as BunCompatiblePTYManager).list()
      : (this.manager as PTYManager).list(filter);
    const liveSessions = sessions.map((session) => {
      const cached = this.manager?.get(session.id);
      return this.toSessionInfo(
        cached ?? session,
        this.sessionWorkdirs.get(session.id),
      );
    });
    const terminalSessions = Array.from(this.terminalSessionStates.keys())
      .filter(
        (sessionId) => !sessions.some((session) => session.id === sessionId),
      )
      .map((sessionId) => this.toTerminalSessionInfo(sessionId))
      .filter((session): session is SessionInfo => session !== undefined);
    return [...liveSessions, ...terminalSessions];
  }

  subscribeToOutput(
    sessionId: string,
    callback: (data: string) => void,
  ): () => void {
    if (!this.manager) throw new Error("PTYService not initialized");
    return subscribeToOutputIO(this.ioContext(), sessionId, callback);
  }

  async getSessionOutput(sessionId: string, lines?: number): Promise<string> {
    if (!this.manager) throw new Error("PTYService not initialized");
    return getSessionOutputIO(this.ioContext(), sessionId, lines);
  }

  /**
   * Whether the adapter currently classifies the session as actively
   * processing work (e.g. Codex's "esc to interrupt" status row).
   *
   * The swarm idle watchdog consults this before assuming a session is
   * idle based on output byte diffs, which are fooled by TUIs that
   * redraw the same status row in place via cursor positioning.
   *
   * Returns `false` for unknown sessions or adapters that don't
   * implement `detectLoading`. For Bun-compat mode this round-trips to
   * the worker; for in-process mode it reads the session directly.
   */
  async isSessionLoading(sessionId: string): Promise<boolean> {
    if (!this.manager) return false;
    if (this.usingBunWorker) {
      return (
        (
          this.manager as BunCompatiblePTYManager & {
            isSessionLoading?: (id: string) => Promise<boolean>;
          }
        ).isSessionLoading?.(sessionId) ?? false
      );
    }
    return (
      (
        this.manager as PTYManager & {
          isSessionLoading?: (id: string) => Promise<boolean>;
        }
      ).isSessionLoading?.(sessionId) ?? false
    );
  }

  private clearTranscriptCapture(sessionId: string): void {
    const unsubscribe = this.transcriptUnsubscribers.get(sessionId);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Ignore cleanup failures on dead sessions.
      }
    }
    this.transcriptUnsubscribers.delete(sessionId);
  }

  private async resolveTaskThreadId(sessionId: string): Promise<string | null> {
    const liveThreadId = this.coordinator?.getTaskContext(sessionId)?.threadId;
    if (liveThreadId) return liveThreadId;
    const metadataThreadId = this.sessionMetadata.get(sessionId)?.threadId;
    if (typeof metadataThreadId === "string" && metadataThreadId.trim()) {
      return metadataThreadId;
    }
    return (
      (await this.coordinator?.taskRegistry.findThreadIdBySessionId(
        sessionId,
      )) ?? null
    );
  }

  private async persistTranscript(
    sessionId: string,
    direction: "stdout" | "stderr" | "stdin" | "keys" | "system",
    content: string,
  ): Promise<void> {
    if (!content || !this.coordinator) return;
    const threadId = await this.resolveTaskThreadId(sessionId);
    if (!threadId) return;
    await this.coordinator.taskRegistry.recordTranscript({
      threadId,
      sessionId,
      direction,
      content,
    });
  }

  private wireTranscriptCapture(sessionId: string): void {
    if (!this.manager) return;
    this.clearTranscriptCapture(sessionId);

    if (this.usingBunWorker) {
      const unsubscribe = (
        this.manager as BunCompatiblePTYManager
      ).onSessionData(sessionId, (data: string) => {
        void this.persistTranscript(sessionId, "stdout", data);
      });
      this.transcriptUnsubscribers.set(sessionId, unsubscribe);
      return;
    }

    const ptySession = (this.manager as PTYManager).getSession(sessionId);
    if (
      !ptySession ||
      typeof (ptySession as { on?: unknown }).on !== "function" ||
      typeof (ptySession as { off?: unknown }).off !== "function"
    ) {
      return;
    }
    const onOutput = (data: string) => {
      void this.persistTranscript(sessionId, "stdout", data);
    };
    ptySession.on("output", onOutput);
    this.transcriptUnsubscribers.set(sessionId, () => {
      ptySession.off("output", onOutput);
    });
  }

  isSessionBlocked(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    return session?.status === "authenticating";
  }

  /**
   * Find a PTY session ID by its working directory.
   * Used by the HTTP hooks endpoint to correlate Claude's cwd with our session.
   */
  findSessionIdByCwd(cwd: string): string | undefined {
    for (const [sessionId, workdir] of this.sessionWorkdirs) {
      if (workdir === cwd) return sessionId;
    }
    return undefined;
  }

  /**
   * Handle an incoming hook event from Claude Code's HTTP hooks.
   * Translates hook events into PTY service events.
   */
  handleHookEvent(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
  ): void {
    // Log high-frequency events (tool_running, permission) at debug level;
    // completion events at info level.
    const summary =
      event === "tool_running"
        ? `tool=${(data as { toolName?: string }).toolName ?? "?"}`
        : event === "permission_approved"
          ? `tool=${(data as { tool?: string }).tool ?? "?"}`
          : JSON.stringify(data);
    if (event === "tool_running" || event === "permission_approved") {
      logger.debug(
        `[PTYService] Hook event for ${sessionId}: ${event} ${summary}`,
      );
    } else {
      this.log(`Hook event for ${sessionId}: ${event} ${summary}`);
    }

    // Forward hook event to the underlying PTY session so it can reset its
    // stall timer and update internal status. Without this, the stall detector
    // runs independently of hooks and can falsely escalate hook-managed sessions.
    if (this.manager && this.usingBunWorker) {
      (this.manager as BunCompatiblePTYManager)
        .notifyHookEvent(sessionId, event)
        .catch((err) =>
          logger.debug(
            `[PTYService] Failed to forward hook event to session: ${err}`,
          ),
        );
    }

    switch (event) {
      case "tool_running":
        this.emitEvent(sessionId, "tool_running", { ...data, source: "hook" });
        break;
      case "task_complete":
        this.emitEvent(sessionId, "task_complete", { ...data, source: "hook" });
        // Auto-stop the PTY after a short grace period. Without this,
        // subagents sit around firing stall classifications that then
        // trigger phantom heartbeats in downstream streamers minutes
        // after the user already got their answer. The grace period
        // lets any backgrounded processes detach from the PTY parent
        // before it exits.
        setTimeout(() => {
          this.stopSession(sessionId).catch(() => {});
        }, TASK_COMPLETE_STOP_DELAY_MS);
        break;
      case "permission_approved":
        // Permission was auto-approved via PermissionRequest hook.
        // No PTY event needed — the hook response already allowed it.
        break;
      case "notification":
        this.emitEvent(sessionId, "message", { ...data, source: "hook" });
        break;
      case "session_end":
        // CLI session is ending — treat as a stopped event so the coordinator
        // and frontend see the session transition to terminal state.
        this.emitEvent(sessionId, "stopped", {
          ...data,
          reason: "session_end",
          source: "hook",
        });
        break;
      default:
        break;
    }
  }

  async checkAvailableAgents(
    types?: AdapterType[],
  ): Promise<PreflightResult[]> {
    const agentTypes =
      types ?? (["claude", "gemini", "codex", "aider"] as AdapterType[]);
    const results = await checkAdapters(agentTypes);
    return await augmentTaskAgentPreflightResults(results, {
      runtime: this.runtime,
    });
  }

  async getAgentAuthStatus(
    agentType: SupportedTaskAgentAdapter,
  ): Promise<TaskAgentAuthStatus> {
    return await probeTaskAgentAuth(agentType, { runtime: this.runtime });
  }

  async triggerAgentAuth(
    agentType: SupportedTaskAgentAdapter,
  ): Promise<TaskAgentAuthLaunchResult> {
    const existing = this.activeAuthFlows.get(agentType);
    if (existing) {
      return existing.snapshot();
    }

    clearTaskAgentFrameworkStateCache();
    const currentStatus = await this.getAgentAuthStatus(agentType);
    if (currentStatus.status === "authenticated") {
      return {
        launched: true,
        instructions: `${agentType} is already authenticated.`,
      };
    }

    const launched = await launchTaskAgentAuthFlow(agentType, {
      runtime: this.runtime,
    });
    if (!launched.handle) {
      return launched.result;
    }

    this.activeAuthFlows.set(agentType, launched.handle);
    void launched.handle.completion.finally(() => {
      const active = this.activeAuthFlows.get(agentType);
      if (active === launched.handle) {
        this.activeAuthFlows.delete(agentType);
      }
      clearTaskAgentFrameworkStateCache();
    });

    let result = launched.result;
    if (result.url) {
      const browserAssist = await assistTaskAgentBrowserLogin(
        agentType,
        result.url,
        { runtime: this.runtime },
      );
      result = {
        ...result,
        browserOpened: browserAssist.opened,
        browserClicked: browserAssist.clicked,
        browserDetail: browserAssist.detail,
      };
    }
    return result;
  }

  async startSessionAuthRecovery(
    sessionId: string,
    agentType: SupportedTaskAgentAdapter,
    login: {
      instructions?: string;
      url?: string;
      deviceCode?: string;
      method?: string;
      promptSnippet?: string;
    },
  ): Promise<
    TaskAgentAuthLaunchResult & {
      recoveryStarted: boolean;
      status: "recovered" | "recovering" | "failed";
    }
  > {
    clearTaskAgentFrameworkStateCache();
    const status = await this.getAgentAuthStatus(agentType);
    if (status.status === "authenticated") {
      const resumed = await this.resumeSessionAfterRecoveredAuth(
        sessionId,
        agentType,
      );
      if (resumed) {
        return {
          launched: true,
          instructions: `${agentType} authentication is already valid. Eliza resumed the blocked session.`,
          recoveryStarted: true,
          status: "recovered",
          recoveryTarget: "same_session",
        };
      }

      const replacement = await this.coordinator?.resumeTaskAfterProviderAuth?.(
        sessionId,
        `${agentType} authentication was refreshed`,
      );
      if (replacement) {
        return {
          launched: true,
          instructions: `${agentType} authentication is already valid. Eliza restarted the task on a fresh session.`,
          recoveryStarted: true,
          status: "recovered",
          recoveryTarget: "replacement_session",
          replacementSessionId: replacement.replacementSessionId,
          replacementFramework: replacement.replacementFramework,
        };
      }

      return {
        launched: false,
        instructions: `${agentType} authentication is valid, but Eliza could not resume the task automatically.`,
        recoveryStarted: false,
        status: "failed",
      };
    }

    let launch: TaskAgentAuthLaunchResult = {
      launched: false,
      instructions:
        login.instructions?.trim() ||
        getTaskAgentLoginHint(agentType) ||
        `Authentication is required for ${agentType}.`,
      ...(login.url ? { url: login.url } : {}),
      ...(login.deviceCode ? { deviceCode: login.deviceCode } : {}),
    };

    if (!launch.url && !launch.deviceCode) {
      launch = await this.triggerAgentAuth(agentType);
    } else if (launch.url) {
      const browserAssist = await assistTaskAgentBrowserLogin(
        agentType,
        launch.url,
        { runtime: this.runtime },
      );
      launch = {
        ...launch,
        launched: true,
        browserOpened: browserAssist.opened,
        browserClicked: browserAssist.clicked,
        browserDetail: browserAssist.detail,
      };
    }

    this.monitorSessionAuthRecovery(sessionId, agentType);

    return {
      ...launch,
      recoveryStarted: true,
      status: launch.launched ? "recovering" : "failed",
    };
  }

  private monitorSessionAuthRecovery(
    sessionId: string,
    agentType: SupportedTaskAgentAdapter,
  ): void {
    const existing = this.authRecoveryTimers.get(sessionId);
    if (existing) return;

    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        const session = this.getSession(sessionId);
        if (
          !session ||
          session.status === "stopped" ||
          session.status === "error"
        ) {
          clearInterval(timer);
          this.authRecoveryTimers.delete(sessionId);
          return;
        }

        const auth = await this.getAgentAuthStatus(agentType);
        if (auth.status === "authenticated") {
          clearInterval(timer);
          this.authRecoveryTimers.delete(sessionId);
          clearTaskAgentFrameworkStateCache();
          const resumed = await this.resumeSessionAfterRecoveredAuth(
            sessionId,
            agentType,
          );
          if (resumed) {
            await this.coordinator?.markTaskResumedAfterProviderAuth?.(
              sessionId,
            );
            return;
          }
          await this.coordinator?.resumeTaskAfterProviderAuth?.(
            sessionId,
            `${agentType} authentication was refreshed`,
          );
          return;
        }

        if (Date.now() - startedAt > 5 * 60_000) {
          clearInterval(timer);
          this.authRecoveryTimers.delete(sessionId);
        }
      })().catch((error) => {
        this.log(`Auth recovery watcher failed for ${sessionId}: ${error}`);
        clearInterval(timer);
        this.authRecoveryTimers.delete(sessionId);
      });
    }, 2_500);

    this.authRecoveryTimers.set(sessionId, timer);
  }

  private async resumeSessionAfterRecoveredAuth(
    sessionId: string,
    agentType: SupportedTaskAgentAdapter,
  ): Promise<boolean> {
    const session = this.getSession(sessionId);
    if (!session) return false;
    if (session.status === "ready" || session.status === "busy") {
      return true;
    }

    try {
      await this.sendKeysToSession(sessionId, "enter");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.sendKeysToSession(sessionId, "enter");
    } catch (error) {
      this.log(
        `Failed to nudge ${agentType} session ${sessionId} after auth recovery: ${error}`,
      );
      return false;
    }

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const current = this.getSession(sessionId);
      if (!current) return false;
      if (current.status === "ready" || current.status === "busy") {
        return true;
      }
      if (current.status === "stopped" || current.status === "error") {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return false;
  }

  getSupportedAgentTypes(): CodingAgentType[] {
    return ["shell", "claude", "gemini", "codex", "aider", "pi"];
  }

  private async classifyStall(
    sessionId: string,
    recentOutput: string,
  ): Promise<StallClassification | null> {
    const meta = this.sessionMetadata.get(sessionId);
    const agentType = (meta?.agentType as string) ?? "unknown";

    // For coordinator-managed sessions in autonomous mode: use combined
    // classify+decide in a single LLM call. The suggestedResponse is kept
    // intact so pty-manager auto-responds, and the coordinator receives
    // autoResponded: true — skipping the second LLM call in handleBlocked().
    if (
      meta?.coordinatorManaged &&
      this.coordinator?.getSupervisionLevel() === "autonomous"
    ) {
      const taskCtx = this.coordinator.getTaskContext(sessionId);
      if (taskCtx) {
        // Suppress stall classification during the post-send cooldown.
        // The agent is processing coordinator input — the output buffer
        // still contains the previous response, so classifying now would
        // produce a stale "task_complete" that triggers cascading follow-ups.
        if (taskCtx.lastInputSentAt) {
          const elapsed = Date.now() - taskCtx.lastInputSentAt;
          if (elapsed < POST_SEND_COOLDOWN_MS) {
            this.log(
              `Suppressing stall classification for ${sessionId} — ` +
                `${Math.round(elapsed / 1000)}s since coordinator sent input`,
            );
            return null;
          }
        }
        return classifyAndDecideForCoordinator({
          sessionId,
          recentOutput,
          agentType,
          buffers: this.sessionOutputBuffers,
          traceEntries: this.traceEntries,
          runtime: this.runtime,
          manager: this.manager,
          metricsTracker: this.metricsTracker,
          debugSnapshots: this.serviceConfig.debug === true,
          lastSentInput:
            typeof meta?.lastSentInput === "string"
              ? meta.lastSentInput
              : undefined,
          log: (msg: string) => this.log(msg),
          taskContext: {
            sessionId: taskCtx.sessionId,
            agentType: taskCtx.agentType,
            label: taskCtx.label,
            originalTask: taskCtx.originalTask,
            workdir: taskCtx.workdir,
            repo: taskCtx.repo,
          },
          decisionHistory: taskCtx.decisions
            .filter((d) => d.decision !== "auto_resolved")
            .slice(-5)
            .map((d) => ({
              event: d.event,
              promptText: d.promptText,
              action: d.decision,
              response: d.response,
              reasoning: d.reasoning,
            })),
        });
      }
    }

    const classification = await classifyStallOutput({
      sessionId,
      recentOutput,
      agentType,
      buffers: this.sessionOutputBuffers,
      traceEntries: this.traceEntries,
      runtime: this.runtime,
      manager: this.manager,
      metricsTracker: this.metricsTracker,
      debugSnapshots: this.serviceConfig.debug === true,
      lastSentInput:
        typeof meta?.lastSentInput === "string"
          ? meta.lastSentInput
          : undefined,
      log: (msg: string) => this.log(msg),
    });

    // When the SwarmCoordinator manages this session (non-autonomous mode),
    // strip suggestedResponse so the PTY worker doesn't auto-respond.
    // The coordinator's LLM decision loop will handle blocked prompts instead.
    if (
      classification &&
      meta?.coordinatorManaged &&
      classification.suggestedResponse
    ) {
      this.log(
        `Suppressing stall auto-response for coordinator-managed session ${sessionId} ` +
          `(would have sent: "${classification.suggestedResponse}")`,
      );
      classification.suggestedResponse = undefined;
    }

    return classification;
  }

  // ─── Workspace Files ───

  private getAdapter(agentType: AdapterType): BaseCodingAdapter {
    let adapter = this.adapterCache.get(agentType);
    if (!adapter) {
      adapter = createAdapter(agentType);
      this.adapterCache.set(agentType, adapter);
    }
    return adapter;
  }

  getWorkspaceFiles(agentType: AdapterType): AgentFileDescriptor[] {
    return this.getAdapter(agentType).getWorkspaceFiles();
  }

  getMemoryFilePath(agentType: AdapterType): string {
    return this.getAdapter(agentType).memoryFilePath;
  }

  getApprovalConfig(
    agentType: AdapterType,
    preset: ApprovalPreset,
  ): ApprovalConfig {
    return generateApprovalConfig(agentType, preset);
  }

  async writeMemoryFile(
    agentType: AdapterType,
    workspacePath: string,
    content: string,
    options?: WriteMemoryOptions,
  ): Promise<string> {
    return this.getAdapter(agentType).writeMemoryFile(
      workspacePath,
      content,
      options,
    );
  }

  // ─── Gitignore for Orchestrator Files ───

  /** Marker comment used to detect orchestrator-managed gitignore entries. */
  private static readonly GITIGNORE_MARKER =
    "# orchestrator-injected (do not commit agent config/memory files)";

  /** Per-path lock to serialize concurrent gitignore updates for the same workdir. */
  private static gitignoreLocks = new Map<string, Promise<void>>();

  /**
   * Ensure that orchestrator-injected files (CLAUDE.md, .claude/, GEMINI.md, etc.)
   * are listed in the workspace .gitignore so agents don't commit them.
   * Appends to an existing .gitignore or creates one. Idempotent — skips if
   * the marker comment is already present. Serialized per-path to prevent
   * duplicate entries from concurrent spawns.
   */
  private async ensureOrchestratorGitignore(workdir: string): Promise<void> {
    const gitignorePath = join(workdir, ".gitignore");

    // Serialize per-path: wait for any in-flight update to the same file.
    const existing_lock = PTYService.gitignoreLocks.get(gitignorePath);
    if (existing_lock) await existing_lock;

    const task = this.doEnsureGitignore(gitignorePath, workdir);
    PTYService.gitignoreLocks.set(gitignorePath, task);
    try {
      await task;
    } finally {
      // Only delete if we're still the current holder
      if (PTYService.gitignoreLocks.get(gitignorePath) === task) {
        PTYService.gitignoreLocks.delete(gitignorePath);
      }
    }
  }

  private async doEnsureGitignore(
    gitignorePath: string,
    workdir: string,
  ): Promise<void> {
    let existing = "";
    try {
      existing = await readFile(gitignorePath, "utf-8");
    } catch {
      // No .gitignore yet — we'll create one
    }

    // Idempotent: skip if we already added our entries
    if (existing.includes(PTYService.GITIGNORE_MARKER)) return;

    // Include all common patterns so multi-agent swarms with mixed types are covered.
    const entries = [
      "",
      PTYService.GITIGNORE_MARKER,
      "CLAUDE.md",
      ".claude/",
      "GEMINI.md",
      ".gemini/",
      ".aider*",
    ];

    try {
      if (existing.length === 0) {
        // No .gitignore yet — create with just our entries
        await writeFile(gitignorePath, `${entries.join("\n")}\n`, "utf-8");
      } else {
        // Append-only to avoid clobbering concurrent edits
        const separator = existing.endsWith("\n") ? "" : "\n";
        await appendFile(
          gitignorePath,
          `${separator + entries.join("\n")}\n`,
          "utf-8",
        );
      }
    } catch (err) {
      this.log(`Failed to update .gitignore in ${workdir}: ${err}`);
    }
  }

  // ─── Event & Adapter Registration ───

  onSessionEvent(callback: SessionEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx !== -1) this.eventCallbacks.splice(idx, 1);
    };
  }

  onNormalizedSessionEvent(
    callback: (event: CoordinatorNormalizedEvent) => void,
  ): () => void {
    this.normalizedEventCallbacks.push(callback);
    return () => {
      const idx = this.normalizedEventCallbacks.indexOf(callback);
      if (idx !== -1) this.normalizedEventCallbacks.splice(idx, 1);
    };
  }

  registerAdapter(adapter: unknown): void {
    if (!this.manager) {
      throw new Error("PTYService not initialized");
    }

    if (this.usingBunWorker) {
      this.log(
        "registerAdapter not available with Bun worker - adapters must be in the worker",
      );
      return;
    }

    (this.manager as PTYManager).registerAdapter(
      adapter as Parameters<PTYManager["registerAdapter"]>[0],
    );
    this.log(`Registered adapter`);
  }

  private toSessionInfo(
    session: SessionHandle | WorkerSessionHandle,
    workdir?: string,
  ): SessionInfo {
    const metadata = this.sessionMetadata.get(session.id);
    const requestedType =
      typeof metadata?.requestedType === "string"
        ? metadata.requestedType
        : undefined;
    const displayAgentType =
      session.type === "shell" && isPiAgentType(requestedType)
        ? "pi"
        : session.type;
    return {
      id: session.id,
      name: session.name,
      agentType: displayAgentType,
      workdir: workdir ?? process.cwd(),
      status: session.status,
      createdAt: session.startedAt ? new Date(session.startedAt) : new Date(),
      lastActivityAt: session.lastActivityAt
        ? new Date(session.lastActivityAt)
        : new Date(),
      metadata,
    };
  }

  private toTerminalSessionInfo(sessionId: string): SessionInfo | undefined {
    const terminal = this.terminalSessionStates.get(sessionId);
    if (!terminal) return undefined;
    const metadata = this.sessionMetadata.get(sessionId);
    const requestedType =
      typeof metadata?.requestedType === "string"
        ? metadata.requestedType
        : undefined;
    const storedAgentType =
      typeof metadata?.agentType === "string" ? metadata.agentType : "unknown";
    const displayAgentType =
      storedAgentType === "shell" && isPiAgentType(requestedType)
        ? "pi"
        : storedAgentType;
    return {
      id: sessionId,
      name: this.sessionNames.get(sessionId) ?? sessionId,
      agentType: displayAgentType,
      workdir: this.sessionWorkdirs.get(sessionId) ?? process.cwd(),
      status: terminal.status,
      createdAt: terminal.createdAt,
      lastActivityAt: terminal.lastActivityAt,
      metadata,
    };
  }

  private emitEvent(sessionId: string, event: string, data: unknown): void {
    if (
      event === "blocked" &&
      this.shouldSuppressBlockedEvent(sessionId, data)
    ) {
      return;
    }
    if (
      event === "ready" ||
      event === "task_complete" ||
      event === "stopped" ||
      event === "error"
    ) {
      this.clearCompletionReconcile(sessionId);
    }
    if (event === "stopped" || event === "error") {
      const authRecoveryTimer = this.authRecoveryTimers.get(sessionId);
      if (authRecoveryTimer) {
        clearInterval(authRecoveryTimer);
        this.authRecoveryTimers.delete(sessionId);
      }
      const liveSession = this.manager?.get(sessionId);
      const createdAt =
        liveSession?.startedAt instanceof Date
          ? liveSession.startedAt
          : liveSession?.startedAt
            ? new Date(liveSession.startedAt)
            : new Date();
      const lastActivityAt =
        liveSession?.lastActivityAt instanceof Date
          ? liveSession.lastActivityAt
          : liveSession?.lastActivityAt
            ? new Date(liveSession.lastActivityAt)
            : new Date();
      const reason =
        event === "stopped"
          ? (data as { reason?: string } | undefined)?.reason
          : (data as { message?: string } | undefined)?.message;
      this.terminalSessionStates.set(sessionId, {
        status: event,
        createdAt,
        lastActivityAt,
        reason,
      });
    }

    for (const callback of this.eventCallbacks) {
      try {
        callback(sessionId, event, data);
      } catch (err) {
        this.log(`Event callback error: ${err}`);
      }
    }
    const normalized = normalizeCoordinatorEvent(sessionId, event, data);
    if (!normalized) return;
    for (const callback of this.normalizedEventCallbacks) {
      try {
        callback(normalized);
      } catch (err) {
        this.log(`Normalized event callback error: ${err}`);
      }
    }
  }

  // ─── Metrics ───

  getAgentMetrics() {
    return this.metricsTracker.getAll();
  }

  private log(message: string): void {
    logger.debug(`[PTYService] ${message}`);
  }

  private handleWorkerExit(info: {
    code: number | null;
    signal: string | null;
  }): void {
    const trackedSessionIds = new Set([
      ...this.sessionMetadata.keys(),
      ...this.sessionWorkdirs.keys(),
    ]);
    if (trackedSessionIds.size === 0) {
      return;
    }

    const reason = info.signal
      ? `PTY worker exited unexpectedly (signal ${info.signal})`
      : `PTY worker exited unexpectedly (code ${info.code ?? "unknown"})`;

    for (const sessionId of trackedSessionIds) {
      const terminalState = this.terminalSessionStates.get(sessionId);
      if (
        terminalState?.status === "stopped" ||
        terminalState?.status === "error"
      ) {
        continue;
      }
      this.emitEvent(sessionId, "error", {
        message: reason,
        workerExit: info,
        source: "pty_manager",
      });
    }
  }

  private clearCompletionReconcile(sessionId: string): void {
    const timer = this.completionReconcileTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.completionReconcileTimers.delete(sessionId);
    }
    this.completionSignalSince.delete(sessionId);
  }

  private scheduleCompletionReconcile(sessionId: string): void {
    this.clearCompletionReconcile(sessionId);
    const timer = setInterval(() => {
      void this.reconcileBusySessionFromOutput(sessionId);
    }, 1000);
    this.completionReconcileTimers.set(sessionId, timer);
    void this.reconcileBusySessionFromOutput(sessionId);
  }

  private isAdapterBackedAgentType(value: unknown): value is AdapterType {
    return (
      value === "claude" ||
      value === "gemini" ||
      value === "codex" ||
      value === "aider" ||
      value === "hermes"
    );
  }

  private shouldSuppressBlockedEvent(
    sessionId: string,
    data: unknown,
  ): boolean {
    const payload = data as
      | {
          promptInfo?: unknown;
          source?: unknown;
        }
      | undefined;
    if (payload?.source !== "pty_manager") {
      return false;
    }
    const promptInfo =
      payload.promptInfo &&
      typeof payload.promptInfo === "object" &&
      !Array.isArray(payload.promptInfo)
        ? (payload.promptInfo as Record<string, unknown>)
        : undefined;
    if (!promptInfo) {
      return false;
    }
    const promptType =
      typeof promptInfo.type === "string" ? promptInfo.type.toLowerCase() : "";
    if (promptType && promptType !== "unknown") {
      return false;
    }
    const promptText =
      typeof promptInfo.prompt === "string"
        ? cleanForChat(promptInfo.prompt)
        : "";
    if (!promptText) {
      return false;
    }
    const compactPrompt = promptText.replace(/\s+/g, " ").trim();
    const hasWorkspacePath = /(\/private\/|\/var\/folders\/)/.test(
      compactPrompt,
    );
    const looksLikeWorkingStatus =
      /working \(\d+s .*esc to interrupt\)/i.test(compactPrompt) ||
      /messages to be submitted after next tool call/i.test(compactPrompt) ||
      /find and fix a bug in @filename/i.test(compactPrompt) ||
      /use \/skills to list available skills/i.test(compactPrompt);
    const looksLikeSpinnerTail =
      /\b\d+% left\b/i.test(compactPrompt) && hasWorkspacePath;
    const looksLikeSpinnerFragments =
      hasWorkspacePath &&
      /(?:\bW Wo\b|• Wor|• Work|Worki|Workin|Working)/i.test(compactPrompt);
    if (
      !looksLikeWorkingStatus &&
      !looksLikeSpinnerTail &&
      !looksLikeSpinnerFragments
    ) {
      return false;
    }
    this.log(
      `Suppressing false blocked prompt noise for ${sessionId}: ${compactPrompt.slice(0, 160)}`,
    );
    return true;
  }

  private responseLooksMeaningful(
    response: string,
    rawOutput: string,
  ): boolean {
    if (extractCompletionSummary(rawOutput).trim().length > 0) {
      return true;
    }
    const cleaned = response.trim();
    if (!cleaned) return false;
    const substantiveLines = cleaned
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter(
        (line) =>
          !line.startsWith("› ") &&
          !/^Work(?:i|in|ing)?(?:\s+\d+)?$/i.test(line) &&
          !/^\d+% left\b/i.test(line) &&
          !/context left/i.test(line) &&
          !/esc to interrupt/i.test(line) &&
          !/Use \/skills/i.test(line) &&
          !/Messages to be submitted after next tool call/i.test(line),
      );
    if (
      substantiveLines.some((line) =>
        /\b(Added|Created|Creating|Updated|Wrote|Deleted|Renamed|Verified|Completed|Finished|Saved|Ran|LIVE_)\b/i.test(
          line,
        ),
      )
    ) {
      return true;
    }
    return false;
  }

  private async reconcileBusySessionFromOutput(
    sessionId: string,
  ): Promise<void> {
    if (!this.manager) {
      this.clearCompletionReconcile(sessionId);
      return;
    }

    const liveSession = this.manager.get(sessionId);
    if (!liveSession) {
      this.clearCompletionReconcile(sessionId);
      return;
    }

    if (liveSession.status !== "busy") {
      this.clearCompletionReconcile(sessionId);
      return;
    }

    const agentType = this.sessionMetadata.get(sessionId)?.agentType;
    if (!this.isAdapterBackedAgentType(agentType)) {
      this.clearCompletionReconcile(sessionId);
      return;
    }

    const adapter = this.getAdapter(agentType);
    const rawOutput = await this.getSessionOutput(sessionId);
    if (!rawOutput.trim()) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    if (adapter.detectLoading?.(rawOutput)) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    if (adapter.detectLogin(rawOutput).required) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    if (adapter.detectBlockingPrompt(rawOutput).detected) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    const completionSignal = adapter.detectTaskComplete
      ? adapter.detectTaskComplete(rawOutput)
      : adapter.detectReady(rawOutput);
    if (!completionSignal) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    const previewResponse = this.taskResponseMarkers.has(sessionId)
      ? peekTaskResponse(
          sessionId,
          this.sessionOutputBuffers,
          this.taskResponseMarkers,
        )
      : cleanForChat(rawOutput);
    if (!this.responseLooksMeaningful(previewResponse, rawOutput)) {
      this.completionSignalSince.delete(sessionId);
      return;
    }

    const firstSeenAt = this.completionSignalSince.get(sessionId);
    if (firstSeenAt === undefined) {
      this.completionSignalSince.set(sessionId, Date.now());
      return;
    }

    if (Date.now() - firstSeenAt < 2500) {
      return;
    }

    const response = this.taskResponseMarkers.has(sessionId)
      ? captureTaskResponse(
          sessionId,
          this.sessionOutputBuffers,
          this.taskResponseMarkers,
        )
      : previewResponse;
    const durationMs = liveSession.startedAt
      ? Date.now() - new Date(liveSession.startedAt).getTime()
      : 0;
    liveSession.status = "ready";
    liveSession.lastActivityAt = new Date();
    this.metricsTracker.recordCompletion(
      agentType,
      "output-reconcile",
      durationMs,
    );
    this.log(
      `Reconciled ${sessionId} from busy to task_complete using stable adapter output`,
    );
    this.emitEvent(sessionId, "task_complete", {
      session: liveSession,
      response,
      source: "output_reconcile",
    });
  }
}
