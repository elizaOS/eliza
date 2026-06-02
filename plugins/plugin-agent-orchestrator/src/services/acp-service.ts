import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { NativeAcpClient } from "./acp-native-transport.js";
import {
  buildOpencodeAcpEnv,
  resolveVendoredOpencodeAcpCommand,
} from "./opencode-config.js";
import {
  AcpSessionStore,
  InMemorySessionStore,
  type SessionStoreBackend,
} from "./session-store.js";
import { writeWorkspaceIdentity } from "./sub-agent-identity.js";
import { normalizeTaskAgentAdapter } from "./task-agent-routing.js";
import {
  type AcpEventCallback,
  type AcpJsonRpcMessage,
  type AcpToolCall,
  type AgentType,
  type ApprovalPreset,
  type AvailableAgentInfo,
  type PromptResult,
  type SendOptions,
  type SessionEventCallback,
  type SessionEventName,
  type SessionInfo,
  type SessionStore,
  type SpawnOptions,
  type SpawnResult,
  TERMINAL_SESSION_STATUSES,
} from "./types.js";
import { captureBaselineDirty, captureBaselineSha } from "./workspace-diff.js";

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
const ACP_HEALTH_CHECK_INTERVAL_MS = 60_000;
// Terminal (stopped/errored) sessions are kept this long for any post-completion
// reference, then reclaimed by the health-check sweep so the durable session
// store and the per-session maps don't grow without bound on a long-lived bot.
const ACP_SESSION_RETENTION_MS = 60 * 60_000;
// Sessions that are genuinely mid-flight (have in-progress work that could be
// lost if the process died). "ready" is idle/finished and must NOT be treated
// as a crash by the health-check — see runHealthCheck.
const ACP_MIDFLIGHT_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "busy",
  "tool_running",
]);
const ACP_STALE_LOCK_MAX_AGE_MS = 10 * 60_000;
// Untracked acpx stream files older than this get unlinked. Real spawns
// finalize their store entry in seconds; 24h is grace for in-flight spawns.
const ACP_REVERSE_ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000;
// On startup, a session whose acpx stream file was written within this window
// is treated as still-alive (the subprocess survived the orchestrator
// restart) and kept in its current status. Older sessions are reconciled
// to errored. 90s covers tsx hot-reload latency + acpx subprocess flush
// cadence; well below normal sub-agent silence stretches.
const RECONCILE_LIVE_WINDOW_MS = 90_000;
// Statuses where the sub-agent was actively working when the restart hit —
// these are the resume candidates. Idle states (`ready`, `blocked`,
// `authenticating`) mean the subprocess was waiting for input, not running,
// so there's nothing to resume.
const ORPHAN_RESUME_STATUSES: ReadonlySet<string> = new Set([
  "busy",
  "tool_running",
  "running",
]);
const ORPHAN_RESUME_PROMPT =
  "[System] Your previous turn was interrupted by a runtime restart. Continue where you left off on the original task and report results as usual.";
const DEFAULT_AGENTS: AgentType[] = ["elizaos", "codex", "claude", "opencode"];
const DENY_ENV_PATTERNS = [
  /DISCORD.*TOKEN/i,
  /TELEGRAM.*TOKEN/i,
  /SLACK.*TOKEN/i,
  /BOT.*TOKEN/i,
  /ELIZA_VAULT_PASSPHRASE/i,
  // Host-API shell-exec / stdio-MCP auth secret — consumed only by
  // packages/agent/src/api/*, never by a coding sub-agent. Forwarding it would
  // hand a child process a credential that re-authorizes arbitrary host command
  // execution with zero legitimate use for it.
  /TERMINAL_RUN_TOKEN/i,
];

/**
 * A key that must never reach a sub-agent, regardless of source — parent
 * process.env forwarding OR caller-supplied customCredentials. Both paths run
 * through this so a spawn request cannot inject a secret (connector bot token,
 * vault passphrase) the deny-list exists to keep out of sub-agents.
 */
export function isDeniedSubAgentEnvKey(key: string): boolean {
  return DENY_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

export class AcpService extends Service {
  static serviceType = "ACP_SUBPROCESS_SERVICE";

  // Process-wide registry of live AcpService instances. The SIGTERM/SIGINT
  // listener is registered exactly ONCE per Node process and fans out to
  // every live instance. This avoids:
  //  - MaxListenersExceededWarning when multiple AcpServices run in the same
  //    process (multi-tenant elizaOS, test runners that create + destroy
  //    instances back-to-back, hot-reload cycles).
  //  - Per-instance `process.once` handler closures leaking after stop() if
  //    the signal never fires (tests, short-lived workers).
  private static readonly liveInstances = new Set<AcpService>();
  private static shutdownHookInstalled = false;
  private static readonly sharedShutdownHandler = (): void => {
    // Snapshot to avoid mutation-during-iteration if stop() removes the
    // instance from the set.
    const instances = [...AcpService.liveInstances];
    for (const inst of instances) void inst.stop();
  };

  capabilityDescription =
    "Manages asynchronous ACPX task-agent sessions for open-ended background work";

  readonly defaultApprovalPreset: ApprovalPreset;
  readonly agentSelectionStrategy: string;

  protected override readonly runtime: RuntimeLike;
  private readonly logger: RuntimeLogger;
  private readonly store: SessionStore;
  private readonly cliPath: string;
  private readonly transportMode: "native" | "cli";
  private readonly defaultAgent: AgentType;
  private readonly maxSessions: number;
  // Serializes the session-limit check-and-reserve so concurrent spawns can't
  // each pass the limit check before any has inserted (which would overshoot
  // ELIZA_ACP_MAX_SESSIONS). A promise-chain mutex: each reservation awaits the
  // previous one's completion. See reserveSessionSlot.
  private spawnReservationLock: Promise<void> = Promise.resolve();
  private readonly sessionTimeoutMs?: number;
  private readonly sessionCallbacks: SessionEventCallback[] = [];
  private readonly acpCallbacks: AcpEventCallback[] = [];
  private readonly activeProcesses = new Map<string, ProcessRecord>();
  private readonly nativeClients = new Map<string, NativeAcpClient>();
  private readonly nativePromptSessionIds = new Set<string>();
  private readonly nativeCancelledPromptSessionIds = new Set<string>();
  private readonly nativeStoppingSessionIds = new Set<string>();
  private readonly outputBuffers = new Map<string, string[]>();
  // Per-session set of file paths the agent wrote via edit/write tool calls.
  // The only signal that distinguishes a gitignored deploy target the agent
  // authored from gitignored install output git never sees. Accumulated live
  // (the ACP stream is gone by completion) and consumed at task_complete.
  private readonly changedPathsBySession = new Map<string, Set<string>>();
  private started = false;
  private healthCheckTimer: NodeJS.Timeout | undefined;

  constructor(runtime: IAgentRuntime, opts: { store?: SessionStore } = {}) {
    super(runtime);
    this.runtime = runtime as RuntimeLike;
    this.logger = this.runtime.logger as RuntimeLogger;
    this.store = opts.store ?? new InMemorySessionStore();
    this.cliPath = this.setting("ELIZA_ACP_CLI") ?? "acpx";
    this.transportMode =
      normalizeTransportMode(
        this.setting("ELIZA_ACP_TRANSPORT") ?? this.setting("ACPX_TRANSPORT"),
      ) ?? "native";
    this.defaultAgent =
      normalizeTaskAgentAdapter(
        this.setting("BENCHMARK_TASK_AGENT") ??
          this.setting("ELIZA_ACP_DEFAULT_AGENT") ??
          this.setting("ELIZA_DEFAULT_AGENT_TYPE"),
      ) ?? (this.transportMode === "native" ? "elizaos" : "codex");
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
    // Idempotent: a double-start (hot reload, retry path) without an
    // intervening stop() would otherwise re-register a second SIGTERM/SIGINT
    // handler, leak the prior healthCheckTimer, and leave the first
    // shutdownHandler stuck on the process forever (only the latest one
    // ever gets passed to process.off in stop()).
    if (this.started) return;
    this.started = true;
    this.log("debug", "AcpService initialized", {
      cliPath: this.cliPath,
      transportMode: this.transportMode,
      defaultAgent: this.defaultAgent,
      defaultApprovalPreset: this.defaultApprovalPreset,
    });
    await this.reconcileOrphanedSessions();
    await this.cleanReverseOrphanedAcpxFiles();
    await this.cleanStaleLocks();
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, ACP_HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckTimer.unref?.();
    // Catch SIGTERM/SIGINT so the orchestrator's exit triggers stop() and we
    // kill spawned subprocess trees before dying. Without this, tsx watch's
    // SIGTERM tears down the parent without giving us a chance to clean up,
    // and `claude-agent-acp` / `npm exec` grandchildren leak as zombies.
    //
    // One signal hook per process, fanning out to every live instance via
    // the static `liveInstances` registry. Per-instance handlers would hit
    // Node's MaxListenersExceededWarning (default 10) under multi-tenant
    // elizaOS or rapid test create/destroy cycles, and stale closures would
    // leak if the instance was destroyed without a SIGTERM ever firing.
    AcpService.liveInstances.add(this);
    if (!AcpService.shutdownHookInstalled) {
      process.once("SIGTERM", AcpService.sharedShutdownHandler);
      process.once("SIGINT", AcpService.sharedShutdownHandler);
      AcpService.shutdownHookInstalled = true;
    }
  }

  private async reconcileOrphanedSessions(): Promise<void> {
    const all = await this.store.list().catch(() => [] as SessionInfo[]);
    const orphaned = all.filter(
      (s) => !TERMINAL_SESSION_STATUSES.has(s.status),
    );
    if (orphaned.length === 0) return;
    const liveCutoffMs = Date.now() - RECONCILE_LIVE_WINDOW_MS;
    const verdicts = await Promise.all(
      orphaned.map(async (s) => {
        if (!s.acpxSessionId) return { session: s, alive: false };
        // Probe the real `<acpxSessionId>.json` artifact, not the never-written
        // `.stream.ndjson` (which made every session look dead on restart).
        const { exists, mtimeMs } = await this.acpxSessionStateStat(
          s.acpxSessionId,
        );
        return { session: s, alive: exists && mtimeMs > liveCutoffMs };
      }),
    );
    const dead = verdicts.filter((v) => !v.alive).map((v) => v.session);
    const live = verdicts.filter((v) => v.alive).map((v) => v.session);
    if (live.length > 0) {
      this.log(
        "info",
        "reconcile: keeping recently-active sessions as-is (acpx stream still writing)",
        {
          count: live.length,
          ids: live.map((s) => s.id.slice(0, 8)),
          windowMs: RECONCILE_LIVE_WINDOW_MS,
        },
      );
    }
    if (dead.length === 0) return;
    this.log("info", "reconcile: marking stale orphans errored", {
      count: dead.length,
      ids: dead.map((s) => s.id.slice(0, 8)),
    });
    await Promise.allSettled(
      dead.map((s) =>
        this.store
          .updateStatus(
            s.id,
            "errored",
            "Sub-agent was mid-flight when the runtime restarted. No automatic action taken.",
          )
          .catch((err) =>
            this.log("warn", "failed to mark orphaned session errored", {
              sessionId: s.id,
              err,
            }),
          ),
      ),
    );
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    AcpService.liveInstances.delete(this);
    // The shared SIGTERM/SIGINT hook is `process.once` — it self-removes
    // when fired. If nothing fired and the last instance is going away,
    // explicitly off() the hook so a respawned instance later in the
    // process can install a fresh one (otherwise shutdownHookInstalled
    // stays true but the listener is gone).
    if (
      AcpService.liveInstances.size === 0 &&
      AcpService.shutdownHookInstalled
    ) {
      process.off("SIGTERM", AcpService.sharedShutdownHandler);
      process.off("SIGINT", AcpService.sharedShutdownHandler);
      AcpService.shutdownHookInstalled = false;
    }
    const stops = Array.from(this.activeProcesses.keys()).map((sessionId) =>
      this.stopTrackedProcess(sessionId),
    );
    const nativeStops = Array.from(this.nativeClients.keys()).map((sessionId) =>
      this.stopNativeClient(sessionId),
    );
    await Promise.allSettled([...stops, ...nativeStops]);
    this.started = false;
  }

  private acpxStateRoot(): string {
    return join(homedir(), ".acpx");
  }

  private async cleanStaleLocks(): Promise<void> {
    const queuesDir = join(this.acpxStateRoot(), "queues");
    const cleaned = await scanAndUnlinkOlderThan(
      queuesDir,
      (name) => name.endsWith(".lock"),
      ACP_STALE_LOCK_MAX_AGE_MS,
    );
    if (cleaned > 0) {
      this.log("info", "cleaned stale acpx queue locks", {
        cleaned,
        olderThanMs: ACP_STALE_LOCK_MAX_AGE_MS,
      });
    }
  }

  // GC acpx stream files with no SessionStore entry (subprocess started
  // but orchestrator never persisted — crash between spawn and store.create).
  private async cleanReverseOrphanedAcpxFiles(): Promise<void> {
    const sessionsDir = join(this.acpxStateRoot(), "sessions");
    const sessions = await this.store.list().catch(() => [] as SessionInfo[]);
    const trackedAcpxIds = new Set(
      sessions.map((s) => s.acpxSessionId).filter(Boolean) as string[],
    );
    const { deleted, lingering } = await scanAndUnlinkOlderThanDetailed(
      sessionsDir,
      (name) => {
        if (!name.endsWith(".stream.ndjson")) return false;
        const acpxId = name.replace(/\.stream\.ndjson$/, "");
        return !trackedAcpxIds.has(acpxId);
      },
      ACP_REVERSE_ORPHAN_MAX_AGE_MS,
    );
    if (deleted > 0 || lingering > 0) {
      this.log("info", "reverse-orphan acpx scan", {
        deleted,
        lingering,
        olderThanMs: ACP_REVERSE_ORPHAN_MAX_AGE_MS,
      });
    }
  }

  private async runHealthCheck(): Promise<void> {
    if (!this.started) return;
    const sessions = await this.store.list().catch(() => [] as SessionInfo[]);
    const liveCutoffMs = Date.now() - RECONCILE_LIVE_WINDOW_MS;
    let healed = 0;
    for (const s of sessions) {
      if (TERMINAL_SESSION_STATUSES.has(s.status)) continue;
      if (!s.acpxSessionId) continue;
      // Only sessions that are genuinely MID-FLIGHT can lose unrecoverable
      // work. A "ready" session has already finished its prompt and is idle —
      // a missing state file there is not a crash, and emitting a respawn
      // directive for it is exactly what drove the runaway cascade (a session
      // that successfully deployed the dog site got flipped to errored +
      // "spawn a fresh sub-agent"). Skip non-mid-flight sessions.
      if (!ACP_MIDFLIGHT_SESSION_STATUSES.has(s.status)) continue;
      // Grace window: a freshly-spawned session may not have written its state
      // file yet. Mirror reconcileOrphanedSessions' live-window allowance.
      const lastActivityMs = new Date(s.lastActivityAt).getTime();
      if (Number.isFinite(lastActivityMs) && lastActivityMs > liveCutoffMs) {
        continue;
      }
      const { exists } = await this.acpxSessionStateStat(s.acpxSessionId);
      if (!exists) {
        // Descriptive status, NOT an imperative. The old text literally said
        // "spawn a fresh sub-agent to continue", which the planner obeyed
        // verbatim every cycle — the load-bearing line of the respawn loop.
        // The structural signal is failureKind, not the prose.
        const message =
          "Sub-agent state was lost (process exited without persisting). No automatic action taken.";
        const persisted = await this.store
          .updateStatus(s.id, "errored", message)
          .then(() => true)
          .catch((err) => {
            this.log("warn", "health-check: failed to mark errored", {
              sessionId: s.id,
              err,
            });
            return false;
          });
        // Only surface the state-loss (and count it healed) once the terminal
        // status is actually persisted. Emitting unconditionally left the
        // session mid-flight on a transient store failure, so the next tick
        // re-emitted the same error event every 60s until the store recovered.
        if (!persisted) continue;
        this.emitSessionEvent(s.id, "error", {
          message,
          failureKind: "session_state_lost",
        });
        healed++;
      }
    }
    if (healed > 0) {
      this.log("info", "health-check self-healed sessions", { healed });
    }
    // Reclaim terminal sessions past the retention window so the durable store
    // and the per-session maps don't grow without bound. sweepStale removes only
    // stopped/errored sessions older than the window; clear their satellite map
    // entries (output buffers, changed paths, native clients) in lockstep.
    const swept = await this.store
      .sweepStale(ACP_SESSION_RETENTION_MS)
      .catch(() => [] as string[]);
    for (const id of swept) {
      this.outputBuffers.delete(id);
      this.changedPathsBySession.delete(id);
      this.nativeClients.delete(id);
    }
    if (swept.length > 0) {
      this.log("debug", "health-check reclaimed terminal sessions", {
        count: swept.length,
      });
    }
    await this.cleanReverseOrphanedAcpxFiles();
  }

  // The acpx transport persists session state as `<acpxSessionId>.json` under
  // <stateRoot>/sessions. The old probe checked `<acpxSessionId>.stream.ndjson`
  // which NEVER exists for opencode/native sessions (verified: 0 such files on
  // disk, only ses_*.json) — a permanent false-negative that made every healthy
  // session look "state lost", triggering a runaway "spawn a fresh sub-agent"
  // respawn cascade AND spuriously throwing on the first real prompt to any
  // opencode session. Probe the artifact the transport actually writes.
  private acpxSessionStateFile(acpxSessionId: string): string {
    return join(this.acpxStateRoot(), "sessions", `${acpxSessionId}.json`);
  }

  private async acpxSessionStateStat(
    acpxSessionId: string,
  ): Promise<{ exists: boolean; mtimeMs: number }> {
    try {
      const st = await stat(this.acpxSessionStateFile(acpxSessionId));
      return { exists: true, mtimeMs: st.mtimeMs };
    } catch {
      return { exists: false, mtimeMs: 0 };
    }
  }

  private async hasAcpxSessionState(acpxSessionId: string): Promise<boolean> {
    return (await this.acpxSessionStateStat(acpxSessionId)).exists;
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    this.ensureStarted();
    const id = randomUUID();
    const name = opts.name?.trim() || id;
    this.assertTransportAvailable(id);
    const agentType =
      normalizeTaskAgentAdapter(opts.agentType ?? this.defaultAgent) ??
      this.defaultAgent;
    const approvalPreset = opts.approvalPreset ?? this.defaultApprovalPreset;
    // Orchestrated spawns (via tasks.ts → resolveSpawnWorkdir) always pass
    // opts.workdir, which already applies route/convention/explicit resolution
    // and the same ELIZA_ACP_WORKSPACE_ROOT/ACPX_DEFAULT_CWD settings, falling
    // back to process.cwd() to preserve the self-checkout workflow. This env
    // tail is therefore the resolver for DIRECT (non-orchestrated) callers of
    // spawnSession; its last resort is the scratch DEFAULT_WORKDIR_ROOT rather
    // than process.cwd() because a direct caller has no self-checkout intent.
    const workdir = resolve(
      opts.workdir ??
        this.setting("ELIZA_ACP_WORKSPACE_ROOT") ??
        this.setting("ACPX_DEFAULT_CWD") ??
        DEFAULT_WORKDIR_ROOT,
    );
    await mkdir(workdir, { recursive: true });
    // Give the sub-agent its eliza-context + non-interactive operating manual on
    // disk (where every backend reads it) — only when the workspace is bare, so
    // a real repo's own AGENTS.md/CLAUDE.md is never clobbered.
    await writeWorkspaceIdentity(workdir);

    // Record the workspace HEAD + already-dirty files at spawn so the change
    // set captured at task_complete is scoped to exactly what this sub-agent
    // did (and excludes pre-existing churn it never touched). Empty/undefined
    // when the workspace isn't a git repo — capture then relies on the agent's
    // own edit/write tool-call paths.
    const baselineSha = await captureBaselineSha(workdir);
    const baselineDirty = await captureBaselineDirty(workdir);

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
      metadata: baselineSha
        ? {
            ...(opts.metadata ?? {}),
            codingBaselineSha: baselineSha,
            ...(baselineDirty.length > 0
              ? { codingBaselineDirty: baselineDirty }
              : {}),
          }
        : opts.metadata,
    };
    // Atomic check-and-reserve: enforces the session limit and inserts under a
    // single mutex so concurrent spawns can't overshoot maxSessions (the old
    // separate enforceSessionLimit()/store.create() left a read-then-act race).
    await this.reserveSessionSlot(session);

    if (this.transportMode === "native") {
      const result = await this.spawnNativeSession(id, session, opts);
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
      return result;
    }

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
    if (session.acpxSessionId && !this.nativeClients.has(sessionId)) {
      const exists = await this.hasAcpxSessionState(session.acpxSessionId);
      if (!exists) {
        const message =
          "Sub-agent state was lost (process exited without persisting). No automatic action taken.";
        await this.store.updateStatus(sessionId, "errored", message);
        this.emitSessionEvent(sessionId, "error", {
          message,
          failureKind: "session_state_lost",
        });
        throw new Error(message);
      }
    }
    const startedAt = Date.now();
    if (this.transportMode === "native") {
      if (this.nativePromptSessionIds.has(sessionId)) {
        throw new Error(`ACP session is already busy: ${sessionId}`);
      }
      await this.store.updateStatus(sessionId, "busy");
      return this.sendNativePrompt(session, text, opts, startedAt);
    }
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
    if (this.transportMode === "native") {
      const client = this.nativeClients.get(sessionId);
      if (this.nativePromptSessionIds.has(sessionId)) {
        this.nativeCancelledPromptSessionIds.add(sessionId);
      }
      await client?.cancel(
        session.acpxSessionId ?? session.agentSessionId ?? session.id,
      );
      await this.store.updateStatus(sessionId, "cancelled");
      return;
    }
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
    if (this.transportMode === "native") {
      this.nativeStoppingSessionIds.add(sessionId);
      try {
        await this.stopNativeClient(sessionId);
        await this.store.updateStatus(sessionId, "stopped");
        this.emitSessionEvent(sessionId, "stopped", {
          sessionId,
          response: this.lastOutput(sessionId),
        });
      } finally {
        if (!this.nativePromptSessionIds.has(sessionId)) {
          this.nativeStoppingSessionIds.delete(sessionId);
        }
      }
      return;
    }
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
    this.changedPathsBySession.delete(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.store.list();
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    const session = await this.store.get(sessionId);
    return session ?? undefined;
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) return;
    await this.store.update(sessionId, {
      metadata: { ...(session.metadata ?? {}), ...patch },
    });
  }

  // Proactive orphan recovery. Sessions whose status was `busy` /
  // `tool_running` / `running` when the runtime restarted retained that
  // status in the store but lost their subprocess. Fire a synthetic resume
  // prompt at each one (background) so claude-agent-sdk reloads its stream
  // and picks the work back up without waiting for new user input. Mirrors
  // moltbot's recoverOrphanedSubagentSessions pattern.
  async resumeOrphanedBusySessions(): Promise<{
    resumed: number;
    skipped: number;
  }> {
    if (typeof this.sendPrompt !== "function") {
      return { resumed: 0, skipped: 0 };
    }
    const sessions = await this.store.list().catch(() => [] as SessionInfo[]);
    let resumed = 0;
    let skipped = 0;
    for (const session of sessions) {
      if (!ORPHAN_RESUME_STATUSES.has(session.status)) continue;
      if (!session.acpxSessionId) {
        skipped += 1;
        continue;
      }
      const stateOk = await this.hasAcpxSessionState(session.acpxSessionId);
      if (!stateOk) {
        skipped += 1;
        continue;
      }
      this.log("info", "resuming orphaned sub-agent after restart", {
        sessionId: session.id.slice(0, 8),
        status: session.status,
        label:
          typeof session.metadata?.label === "string"
            ? session.metadata.label
            : undefined,
      });
      void this.sendPrompt(session.id, ORPHAN_RESUME_PROMPT).catch(
        (err: unknown) =>
          this.log("warn", "orphan resume sendPrompt failed", {
            sessionId: session.id.slice(0, 8),
            err: err instanceof Error ? err.message : String(err),
          }),
      );
      resumed += 1;
    }
    if (resumed > 0 || skipped > 0) {
      this.log("info", "orphan resume scan complete", { resumed, skipped });
    }
    return { resumed, skipped };
  }

  // Returns a session whose label + workdir match the caller AND whose acpx
  // state ndjson + on-disk workdir are still intact. The next `sendPrompt`
  // against this id resumes the conversation in claude-agent-sdk (acpx
  // invokes `prompt -s <name>` which reloads the persisted stream).
  async findResumableSessionByLabel(
    label: string,
    workdir: string,
  ): Promise<SessionInfo | undefined> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return undefined;
    const resolvedWorkdir = resolve(workdir);
    const sessions = await this.listSessions();
    const candidates = sessions
      .filter((s) => {
        const meta = s.metadata;
        return (
          typeof meta?.label === "string" &&
          meta.label === trimmedLabel &&
          s.workdir === resolvedWorkdir &&
          typeof s.acpxSessionId === "string" &&
          s.status !== "errored" &&
          s.status !== "cancelled" &&
          s.status !== "busy"
        );
      })
      .sort(
        (a, b) =>
          (b.lastActivityAt?.getTime() ?? 0) -
          (a.lastActivityAt?.getTime() ?? 0),
      );
    for (const session of candidates) {
      // acpxSessionId presence guaranteed by the filter above.
      const stateOk = await this.hasAcpxSessionState(
        session.acpxSessionId as string,
      );
      if (!stateOk) continue;
      const workdirOk = await stat(session.workdir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (workdirOk) return session;
    }
    return undefined;
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

  private async spawnNativeSession(
    id: string,
    session: SessionInfo,
    opts: SpawnOptions,
  ): Promise<SpawnResult> {
    const command = this.nativeAgentCommand(session.agentType);
    const stderr: string[] = [];
    const client = new NativeAcpClient({
      command,
      cwd: session.workdir,
      approvalPreset: session.approvalPreset,
      timeoutMs: opts.timeoutMs ?? this.sessionTimeoutMs,
      terminal: !this.shouldDisableTerminalCapability(),
      env: this.buildEnv(
        opts.env,
        opts.customCredentials,
        opts.model,
        session.agentType,
      ),
      onEvent: (event, protocolSessionId) => {
        this.handleAcpEvent(
          event,
          id,
          "",
          Date.now(),
          false,
          new Set<string>(),
        );
        if (protocolSessionId && protocolSessionId !== id) {
          void this.store
            .update(id, { acpxSessionId: protocolSessionId })
            .catch(() => undefined);
        }
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
    });
    try {
      await client.start();
      const nativeSession = await client.createSession(session.workdir);
      this.nativeClients.set(id, client);
      await this.store.update(id, {
        status: "ready",
        pid: undefined,
        acpxSessionId: nativeSession.sessionId,
        agentSessionId: nativeSession.agentSessionId,
        lastActivityAt: new Date(),
      });
      this.emitSessionEvent(id, "ready", {
        sessionId: id,
        name: session.name,
        agentType: session.agentType,
        workdir: session.workdir,
      });
      const updated = await this.store.get(id);
      return toSpawnResult(updated ?? { ...session, status: "ready" });
    } catch (err) {
      await client.close().catch(() => undefined);
      // A failed spawn must not leave a closed client registered: the entry is
      // set above before the store writes that can throw here. Idempotent when
      // the failure happened before the set.
      this.nativeClients.delete(id);
      const message = stderr.join("").trim() || errorMessage(err);
      await this.store.updateStatus(id, "errored", message);
      this.emitSessionEvent(id, "error", {
        message,
        failureKind: isAuthText(message) ? "auth" : undefined,
      });
      throw new Error(message);
    }
  }

  private async sendNativePrompt(
    session: SessionInfo,
    text: string,
    opts: SendOptions,
    startedAt: number,
  ): Promise<PromptResult> {
    const client = this.nativeClients.get(session.id);
    if (!client) {
      await this.store.updateStatus(
        session.id,
        "errored",
        "Native ACP client is not attached",
      );
      throw new Error(`Native ACP client is not attached: ${session.id}`);
    }
    const protocolSessionId =
      session.acpxSessionId ?? session.agentSessionId ?? session.id;
    let finalText = "";
    let eventStopReason: string | undefined;
    const capturedToolOutputs = new Set<string>();
    const previousOnAcp = (event: AcpJsonRpcMessage) => {
      const handled = this.handleAcpEvent(
        event,
        session.id,
        finalText,
        startedAt,
        true,
        capturedToolOutputs,
      );
      finalText = handled.finalText;
      eventStopReason = handled.stopReason ?? eventStopReason;
    };
    this.nativePromptSessionIds.add(session.id);
    client.setEventHandler(previousOnAcp);
    client.setTimeoutMs(opts.timeoutMs ?? this.sessionTimeoutMs);
    try {
      const result = await client.prompt(protocolSessionId, text);
      const stopReason = result.stopReason;
      const cancelled =
        stopReason === "cancelled" ||
        this.nativeCancelledPromptSessionIds.has(session.id);
      const stopped = this.nativeStoppingSessionIds.has(session.id);
      const finalStopReason = stopped
        ? "stopped"
        : cancelled
          ? "cancelled"
          : stopReason;
      const promptResult: PromptResult = {
        sessionId: session.id,
        response: finalText,
        finalText,
        stopReason: finalStopReason,
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        signal: null,
        ...(finalStopReason === "error"
          ? { error: "ACP prompt ended with stopReason error" }
          : {}),
      };
      if (stopped) {
        await this.store.updateStatus(session.id, "stopped");
      } else if (cancelled) {
        await this.store.updateStatus(session.id, "cancelled");
      } else if (finalStopReason === "error") {
        await this.store.updateStatus(
          session.id,
          "errored",
          "ACP prompt ended with stopReason error",
        );
      } else {
        await this.store.update(session.id, {
          status: "ready",
          lastActivityAt: new Date(),
        });
      }
      return promptResult;
    } catch (err) {
      const message = errorMessage(err);
      if (this.nativeStoppingSessionIds.has(session.id)) {
        await this.store.updateStatus(session.id, "stopped");
        return {
          sessionId: session.id,
          response: finalText,
          finalText,
          stopReason: "stopped",
          durationMs: Date.now() - startedAt,
          exitCode: null,
          signal: null,
        };
      }
      if (this.nativeCancelledPromptSessionIds.has(session.id)) {
        await this.store.updateStatus(session.id, "cancelled");
        return {
          sessionId: session.id,
          response: finalText,
          finalText,
          stopReason: "cancelled",
          durationMs: Date.now() - startedAt,
          exitCode: null,
          signal: null,
        };
      }
      await this.store.updateStatus(session.id, "errored", message);
      this.emitSessionEvent(session.id, "error", { message });
      return {
        sessionId: session.id,
        response: finalText,
        finalText,
        stopReason: "error",
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        signal: null,
        error: message,
      };
    } finally {
      client.setEventHandler((event, protocolSessionId) => {
        this.handleAcpEvent(
          event,
          session.id,
          "",
          Date.now(),
          false,
          new Set<string>(),
        );
        if (protocolSessionId && protocolSessionId !== session.id) {
          void this.store
            .update(session.id, { acpxSessionId: protocolSessionId })
            .catch(() => undefined);
        }
      });
      this.nativePromptSessionIds.delete(session.id);
      this.nativeCancelledPromptSessionIds.delete(session.id);
      this.nativeStoppingSessionIds.delete(session.id);
    }
  }

  private nativeAgentCommand(agentType: AgentType): string {
    const normalizedAgentType =
      normalizeTaskAgentAdapter(agentType) ?? agentType;
    if (normalizedAgentType === "opencode") {
      const command = this.opencodeAgentCommand();
      if (command) return command;
      return this.setting("ELIZA_OPENCODE_ACP_COMMAND") ?? "opencode acp";
    }
    const override = this.setting(
      `ELIZA_${String(normalizedAgentType)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")}_ACP_COMMAND`,
    );
    if (override?.trim()) return override.trim();
    if (normalizedAgentType === "codex")
      return (
        this.setting("ELIZA_CODEX_ACP_COMMAND") ??
        "npx -y @zed-industries/codex-acp@0.14.0"
      );
    if (normalizedAgentType === "claude")
      return (
        this.setting("ELIZA_CLAUDE_ACP_COMMAND") ??
        "npx -y @agentclientprotocol/claude-agent-acp@0.34.0"
      );
    return String(normalizedAgentType);
  }

  private async stopNativeClient(sessionId: string): Promise<void> {
    const client = this.nativeClients.get(sessionId);
    if (!client) return;
    this.nativeClients.delete(sessionId);
    const session = await this.store.get(sessionId);
    const protocolSessionId =
      session?.acpxSessionId ?? session?.agentSessionId ?? sessionId;
    await client.closeSession(protocolSessionId).catch(() => undefined);
    await client.close().catch(() => undefined);
  }

  private agentCommandArgs(agentType: AgentType, args: string[]): string[] {
    if (agentType !== "opencode") return [agentType, ...args];
    const command = this.opencodeAgentCommand();
    if (!command) return [agentType, ...args];
    return ["--agent", command, ...args];
  }

  private runAcpx(opts: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    let finalText = "";
    let stopReason: string | undefined;
    const capturedToolOutputs = new Set<string>();
    const missingCliMessage = this.missingCliMessage();
    if (missingCliMessage) {
      if (opts.sessionId) {
        this.emitMissingCli(opts.sessionId, missingCliMessage);
      }
      return Promise.resolve({
        code: 127,
        signal: null,
        stderr: missingCliMessage,
        finalText: "",
        durationMs: Date.now() - startedAt,
      });
    }
    return new Promise((resolveRun) => {
      const proc = spawn(this.cliPath, opts.args, {
        cwd: opts.workdir,
        env: this.buildEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
        // Place the child in its own process group so we can SIGTERM the
        // whole tree (acpx → npm exec → claude-agent-acp) via the negative
        // pid trick on shutdown. Without `detached: true` the grandchildren
        // get re-parented to init on parent death and leak as zombies.
        detached: true,
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
        if (
          opts.sessionId &&
          !record.cancelled &&
          code !== 0 &&
          code !== null
        ) {
          const sessionId = opts.sessionId;
          const exitMessage = this.classifyExitError(code, record.stderr);
          void this.store.get(sessionId).then((session) => {
            if (session && !TERMINAL_SESSION_STATUSES.has(session.status)) {
              void this.store
                .updateStatus(sessionId, "errored", exitMessage)
                .catch(() => undefined);
              this.log(
                "warn",
                "subprocess crashed mid-flight; marked errored",
                {
                  sessionId,
                  priorStatus: session.status,
                  code,
                  signal,
                },
              );
            }
          });
        }
        if (opts.sessionId && opts.activeForSession) {
          // claude-agent-sdk often exits cleanly (code 0) without sending
          // an explicit `{result: {stopReason: "end_turn"}}` ACP message
          // before close. Without that message, `handleAcpEvent` never
          // emits `task_complete`, so the only terminal event the
          // downstream evaluator sees is `stopped` — which it ignores,
          // leaving the user with no Discord summary even though the
          // sub-agent committed real work. Promote a clean exit with
          // captured output to `task_complete` so the response evaluator
          // can route a synthetic completion message back through the
          // pipeline.
          const cleanCompletion =
            !record.cancelled &&
            (code === 0 || code === null) &&
            finalText.trim().length > 0;
          if (record.cancelled) {
            this.emitSessionEvent(opts.sessionId, "cancelled", {
              sessionId: opts.sessionId,
              response: finalText,
              exitCode: code,
              signal,
            });
          } else if (cleanCompletion) {
            // Emit exactly one terminal event per session-exit. Listeners
            // gating on `stopped` must also accept `task_complete` (the
            // evaluator already does); emitting both causes duplicate
            // processing downstream.
            this.emitSessionEvent(opts.sessionId, "task_complete", {
              response: finalText,
              durationMs: Date.now() - startedAt,
              stopReason: stopReason ?? "exit",
              exitCode: code,
            });
          } else {
            this.emitSessionEvent(opts.sessionId, "stopped", {
              sessionId: opts.sessionId,
              response: finalText,
              exitCode: code,
              signal,
            });
          }
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
        }, opts.timeoutMs).unref();
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
        .catch((err) =>
          this.log("warn", "failed to persist acpxSessionId", {
            sessionId: localSessionId,
            protocolSessionId,
            err,
          }),
        );
    }
    for (const callback of [...this.acpCallbacks]) {
      try {
        callback(event, sessionId);
      } catch (err) {
        this.log("warn", "ACP event callback failed", {
          sessionId,
          error: errorMessage(err),
        });
      }
    }
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

    if (
      sessionId &&
      (method === "permission/request" ||
        method === "session/request_permission")
    ) {
      const description = stringifyMaybe(
        params?.description ??
          params?.message ??
          asRecord(params?.toolCall)?.title ??
          asRecord(params?.toolCall)?.kind ??
          "permission required",
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
      void this.store.updateStatus(sessionId, "blocked").catch((err) =>
        this.log("warn", "failed to persist blocked status", {
          sessionId,
          err,
        }),
      );
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
      // tool_call: emit tool_running on first submission OR while in_progress;
      // ignore terminal transitions (completed/failed) — they just need output
      // capture, not re-emit. Some ACP adapters (notably claude-agent-sdk)
      // submit tool_call without ever sending a status="in_progress" update,
      // so gating only on `in_progress|running` misses the activation entirely.
      // Treating the initial `tool_call` (without `_update` suffix) as a
      // running submission catches that case.
      if (
        sessionUpdate === "tool_call" ||
        sessionUpdate === "tool_call_update"
      ) {
        const status = stringifyMaybe(updateBlock?.status);
        const toolOutput = updateBlock?.rawOutput ?? updateBlock?.content;
        const ub = (updateBlock ?? {}) as Record<string, unknown>;
        const rawInput =
          ub.rawInput &&
          typeof ub.rawInput === "object" &&
          !Array.isArray(ub.rawInput)
            ? (ub.rawInput as Record<string, unknown>)
            : undefined;
        const locations = Array.isArray(ub.locations)
          ? (ub.locations as Array<{ path?: string; line?: number }>)
          : undefined;
        const toolCall: AcpToolCall = {
          id: stringifyMaybe(updateBlock?.toolCallId ?? updateBlock?.id),
          title: stringifyMaybe(updateBlock?.title),
          status: (status as AcpToolCall["status"]) ?? "running",
          output: stringifyMaybe(toolOutput),
          kind: stringifyMaybe(ub.kind),
          rawInput,
          locations,
        };
        if (sessionId) this.recordEditedPaths(sessionId, toolCall);
        const isInitialSubmission = sessionUpdate === "tool_call";
        const isRunningStatus =
          status === "in_progress" || status === "running";
        const isTerminalStatus =
          status === "completed" || status === "failed" || status === "error";
        // Claude-agent-acp emits the initial `tool_call` with an empty
        // `rawInput: {}` and a generic title ("Terminal", "Read") — the
        // actual command / file_path lands in a subsequent
        // `tool_call_update` payload that often carries no `status` field.
        // Re-emit `tool_running` whenever an update brings new rawInput so
        // downstream consumers (heartbeat tool history) can replace the
        // bare title with the enriched version.
        const hasRichInput =
          (rawInput && Object.keys(rawInput).length > 0) ||
          (locations && locations.length > 0);
        const isInformativeUpdate =
          sessionUpdate === "tool_call_update" &&
          !isTerminalStatus &&
          hasRichInput;
        if (isInitialSubmission || isRunningStatus || isInformativeUpdate) {
          this.emitSessionEvent(sessionId, "tool_running", { toolCall });
          void this.store.updateStatus(sessionId, "tool_running").catch((err) =>
            this.log("warn", "failed to persist tool_running status", {
              sessionId,
              toolCallId: toolCall.id,
              err,
            }),
          );
        }
        if (isTerminalStatus) {
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
      // Streaming `usage_update` sessionUpdates are intentionally not summed
      // here: the per-turn token total is emitted once from the terminal
      // result below, which keeps the consumer's per-turn summation exact —
      // a streamed cumulative update would double-count. The
      // `available_commands_update` sessionUpdate is metadata; ignore it.
    }

    if (sessionId && result) {
      const resultText = extractPromptResultText(result);
      if (resultText) {
        const merged = mergeTerminalResultText(finalText, resultText);
        if (merged !== finalText) {
          finalText = merged;
          this.appendOutput(sessionId, resultText);
        }
      }
    }

    if (sessionId && result && typeof result.stopReason === "string") {
      stopReason = result.stopReason;
      if (emitPromptTerminalEvents) {
        // Per-turn token usage rides on the terminal result (claude-agent-acp
        // reports it under `result.usage` / `result._meta.usage`). Emit it once
        // per prompt turn so the consumer's summation stays exact. Providers
        // that report no usage simply leave the session "unavailable".
        const usage = extractUsageUpdate(
          result,
          asRecord(result.usage),
          asRecord(result._meta),
          asRecord(asRecord(result._meta)?.usage),
        );
        if (usage) {
          this.emitSessionEvent(sessionId, "usage_update", {
            ...usage,
            sourceEventId: `${sessionId}:${startedAt}`,
          });
        }
        // Treat any non-error terminal stopReason as a completion so
        // downstream evaluators get a chance to summarize the work for
        // the user. claude-agent-sdk emits a variety of stopReasons
        // (`end_turn`, `max_tokens`, `interrupted`, `tool_use`, ...);
        // limiting completion to `end_turn` silently dropped sessions
        // that hit token limits, ran out of turns, or stopped for any
        // other non-error reason — the sub-agent did real work (commits,
        // edits, deploys) and the user got nothing back.
        if (stopReason === "error") {
          this.emitSessionEvent(sessionId, "error", {
            message: "acpx prompt ended with stopReason error",
            stopReason,
          });
        } else {
          this.emitSessionEvent(sessionId, "task_complete", {
            response: finalText,
            durationMs: Date.now() - startedAt,
            stopReason,
          });
        }
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

  /**
   * Atomically enforce the session limit and reserve the slot by inserting the
   * session. Wrapping the check (`enforceSessionLimit`) and the insert
   * (`store.create`) in a single mutex-guarded critical section makes them one
   * indivisible operation, so N concurrent spawns can't all pass the limit
   * check before any has inserted and overshoot `maxSessions`.
   *
   * The mutex is a promise chain: each call awaits the previous reservation's
   * settlement (success OR failure) before running its own check+insert, so
   * the count observed by `enforceSessionLimit` always includes every
   * already-reserved session. Errors propagate to the caller; the chain itself
   * never rejects (we swallow on the tail) so one failed reservation doesn't
   * wedge the lock for later spawns.
   */
  private async reserveSessionSlot(session: SessionInfo): Promise<void> {
    const previous = this.spawnReservationLock;
    let release!: () => void;
    this.spawnReservationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Wait for the prior reservation to finish before observing the count.
    await previous.catch(() => {});
    try {
      await this.enforceSessionLimit();
      await this.store.create(session);
    } finally {
      release();
    }
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
    if (!record.exited) killProcessTree(record.proc, "SIGTERM");
    record.killTimer = setTimeout(() => {
      if (!record.exited) killProcessTree(record.proc, "SIGKILL");
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
      if (isDeniedSubAgentEnvKey(key)) continue;
      if (shouldForwardEnv(key)) env[key] = value;
    }
    for (const [key, value] of Object.entries(customCredentials ?? {})) {
      if (typeof value !== "string") continue;
      // customCredentials arrive with the spawn request, not from the parent's
      // vetted process.env, so they MUST respect the same deny-list — otherwise
      // a caller could inject a secret the deny-list strips from process.env
      // forwarding (connector bot tokens, the vault passphrase).
      if (isDeniedSubAgentEnvKey(key)) {
        this.log("warn", "rejecting customCredential matching env deny-list", {
          key,
        });
        continue;
      }
      env[key] = value;
    }
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === "string") env[key] = value;
    }
    if (model) {
      env.OPENAI_MODEL = model;
      if (agentType === "claude") env.ANTHROPIC_MODEL = model;
      if (agentType === "opencode") env.OPENCODE_MODEL = model;
    }
    if (
      agentType === "claude" &&
      isClaudeOAuthSubscriptionToken(env.ANTHROPIC_API_KEY)
    ) {
      // claude-agent-acp wraps Claude Code, which would try API-key auth with
      // this OAuth token and fail "Invalid API key". Strip it so the sub-agent
      // falls back to native subscription OAuth (~/.claude). See
      // isClaudeOAuthSubscriptionToken for why a real sk-ant-api… key is kept.
      delete env.ANTHROPIC_API_KEY;
      this.log(
        "debug",
        "Stripped OAuth-token ANTHROPIC_API_KEY for claude sub-agent (uses native OAuth)",
      );
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

  // Tool-call arg keys that carry a target file path / signal a write.
  private static readonly EDIT_PATH_KEYS = [
    "filePath",
    "file_path",
    "path",
    "file",
    "target",
    "abspath",
  ];
  private static readonly WRITE_CONTENT_KEYS = [
    "content",
    "contents",
    "new_string",
    "newText",
    "patch",
    "diff",
  ];
  private static readonly MUTATING_TOOL_KINDS = new Set([
    "edit",
    "write",
    "create",
    "patch",
    "move",
    "delete",
  ]);

  /**
   * Record the file path(s) of an edit/write tool call so the change set at
   * completion includes gitignored files the agent authored. Self-gates: only
   * records when the call's kind is mutating OR its args carry write content,
   * so reads/searches/shell calls are ignored.
   */
  private recordEditedPaths(sessionId: string, toolCall: AcpToolCall): void {
    const kind = (toolCall.kind ?? "").toLowerCase();
    const rawInput = toolCall.rawInput ?? {};
    const looksMutating =
      AcpService.MUTATING_TOOL_KINDS.has(kind) ||
      AcpService.WRITE_CONTENT_KEYS.some((key) => key in rawInput);
    if (!looksMutating) return;
    const paths: string[] = [];
    for (const key of AcpService.EDIT_PATH_KEYS) {
      const value = rawInput[key];
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
    for (const location of toolCall.locations ?? []) {
      if (typeof location?.path === "string" && location.path.trim())
        paths.push(location.path.trim());
    }
    if (paths.length === 0) return;
    const set = this.changedPathsBySession.get(sessionId) ?? new Set<string>();
    for (const path of paths) {
      if (set.size >= 500) break;
      set.add(path);
    }
    this.changedPathsBySession.set(sessionId, set);
  }

  /** File paths the agent wrote via edit/write tool calls this session. */
  getChangedPaths(sessionId: string): string[] {
    return [...(this.changedPathsBySession.get(sessionId) ?? [])];
  }

  private setting(key: string): string | undefined {
    const fromRuntime = this.runtime.getSetting(key);
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

  private missingCliMessage(): string | undefined {
    if (!this.cliPath.includes("/") || existsSync(this.cliPath)) {
      return undefined;
    }
    return `acpx CLI is not available at ${this.cliPath}. Install the ACP transport or set ELIZA_ACP_CLI to a valid executable.`;
  }

  private emitMissingCli(sessionId: string, message: string): void {
    this.emitSessionEvent(sessionId, "error", {
      message,
      failureKind: "not_found",
    });
  }

  private assertTransportAvailable(sessionId: string): void {
    if (process.env.ELIZA_PLATFORM !== "android") return;
    const message = this.missingCliMessage();
    if (!message) return;
    this.emitMissingCli(sessionId, message);
    throw new Error(message);
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

function normalizeTransportMode(
  value: string | undefined,
): "native" | "cli" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "native" ||
    normalized === "embedded" ||
    normalized === "direct"
  )
    return "native";
  if (normalized === "cli" || normalized === "legacy" || normalized === "acpx")
    return "cli";
  return undefined;
}

/**
 * True when a value is a Claude subscription OAuth token (`sk-ant-oat…`). Such
 * a token cannot authenticate Claude Code as an API key, so when it is misfiled
 * in `ANTHROPIC_API_KEY` it must be stripped from a claude sub-agent's env (the
 * sub-agent then uses native subscription OAuth). A real API key (`sk-ant-api…`)
 * returns false and is preserved.
 */
export function isClaudeOAuthSubscriptionToken(
  value: string | undefined,
): boolean {
  return value?.startsWith("sk-ant-oat") ?? false;
}

export function shouldForwardEnv(key: string): boolean {
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
    // Parent-context bridge session id (ELIZA_HOOK_PORT already passes via the
    // ELIZA_ prefix). Without this the loopback /api/coding-agents/<id>/* bridge
    // is unreachable from an ACP-spawned sub-agent.
    key === "PARALLAX_SESSION_ID" ||
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

export interface NormalizedUsage {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsd?: number;
  state: "measured";
}

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Normalize a provider usage payload — Anthropic Messages (`input_tokens`,
 * `cache_read_input_tokens`, ...), OpenAI Chat/Responses (`prompt_tokens`,
 * `completion_tokens_details.reasoning_tokens`, ...), or the claude-agent-sdk
 * result `usage` — into the camelCase token shape the orchestrator consumer
 * records. Merges field-by-field across the candidate records and returns
 * undefined when no real token data is present, so a turn that reports nothing
 * never persists a fabricated zero-usage row (it stays "unavailable").
 */
export function extractUsageUpdate(
  ...sources: Array<Record<string, unknown> | undefined>
): NormalizedUsage | undefined {
  const records = sources.filter(
    (source): source is Record<string, unknown> => source !== undefined,
  );
  if (records.length === 0) return undefined;
  const pick = (...keys: string[]): unknown => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null) return value;
      }
    }
    return undefined;
  };
  const nested = (key: string, sub: string): unknown => {
    for (const record of records) {
      const value = asRecord(record[key])?.[sub];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };

  const inputTokens = firstFiniteNumber(
    pick("input_tokens", "inputTokens", "prompt_tokens"),
  );
  const outputTokens = firstFiniteNumber(
    pick("output_tokens", "outputTokens", "completion_tokens"),
  );
  const reasoningTokens = firstFiniteNumber(
    pick("reasoning_tokens", "reasoningTokens"),
    nested("completion_tokens_details", "reasoning_tokens"),
    nested("output_tokens_details", "reasoning_tokens"),
  );
  const cacheTokens =
    firstFiniteNumber(pick("cacheTokens")) ||
    firstFiniteNumber(
      pick("cache_read_input_tokens", "cacheReadInputTokens"),
      nested("prompt_tokens_details", "cached_tokens"),
      nested("input_tokens_details", "cached_tokens"),
    ) +
      firstFiniteNumber(
        pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
      );
  const costRaw = pick("total_cost_usd", "cost_usd", "costUsd");
  const costUsd =
    typeof costRaw === "number" && Number.isFinite(costRaw)
      ? costRaw
      : undefined;

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0 &&
    cacheTokens === 0 &&
    costUsd === undefined
  ) {
    return undefined;
  }

  const providerRaw = pick("provider");
  const modelRaw = pick("model");
  return {
    provider:
      typeof providerRaw === "string" && providerRaw ? providerRaw : "unknown",
    model: typeof modelRaw === "string" && modelRaw ? modelRaw : undefined,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheTokens,
    costUsd,
    state: "measured",
  };
}

function stringifyMaybe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function appendTextBlock(current: string, block: string): string {
  if (!current) return block;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${block}`;
}

function mergeTerminalResultText(current: string, resultText: string): string {
  if (!resultText) return current;
  if (!current) return resultText;
  if (current === resultText || current.endsWith(resultText)) return current;
  if (resultText.startsWith(current)) return resultText;
  return appendTextBlock(current, resultText);
}

function extractPromptResultText(
  result: Record<string, unknown>,
): string | undefined {
  return extractAssistantText(result);
}

function extractAssistantText(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): string | undefined {
  if (value === undefined || value === null || depth > 5) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractAssistantText(entry, depth + 1, seen))
      .filter((entry): entry is string => entry !== undefined);
    return parts.join("") || undefined;
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role && role !== "assistant") return undefined;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  for (const key of [
    "finalText",
    "response",
    "output",
    "text",
    "content",
    "message",
  ]) {
    if (!(key in record)) continue;
    const extracted = extractAssistantText(record[key], depth + 1, seen);
    if (extracted) return extracted;
  }
  return undefined;
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
      const value = runtime.getSetting(key);
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

// SIGTERM the entire process group (negative pid). acpx forks `npm exec`
// which forks `claude-agent-acp`; killing only the immediate child re-parents
// the grandchildren to init and leaks them as zombies. Negative pid sends to
// the group leader set by `detached: true` in the spawn call.
function killProcessTree(
  proc: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Group may already be gone, or the platform doesn't support it
      // (Windows). Fall through to a direct signal on the lead process.
    }
  }
  // Lead-process signal: covers the no-pid case (e.g. unit-test mocks where
  // the child has not actually been forked) and the post-group-kill fallback.
  try {
    proc.kill(signal);
  } catch {
    // best-effort
  }
}

/**
 * Shared `readdir → filter → stat → unlink-if-older-than` scan used by the
 * lock-file GC and the orphaned acpx stream GC. Returns the number of files
 * unlinked. Missing directory is treated as zero work (best-effort cleanup,
 * never throws to the caller).
 *
 * Exported for unit tests only — not part of the plugin's public API.
 */
export async function scanAndUnlinkOlderThan(
  dir: string,
  predicate: (name: string) => boolean,
  maxAgeMs: number,
): Promise<number> {
  const { deleted } = await scanAndUnlinkOlderThanDetailed(
    dir,
    predicate,
    maxAgeMs,
  );
  return deleted;
}

/**
 * Variant that also reports how many matching files were left untouched
 * (younger than the threshold) — `cleanReverseOrphanedAcpxFiles` logs both
 * counts because lingering reverse-orphans are a useful signal even when
 * nothing got deleted on this pass.
 */
export async function scanAndUnlinkOlderThanDetailed(
  dir: string,
  predicate: (name: string) => boolean,
  maxAgeMs: number,
): Promise<{ deleted: number; lingering: number }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { deleted: 0, lingering: 0 };
  }
  const matching = entries.filter(predicate);
  if (matching.length === 0) return { deleted: 0, lingering: 0 };
  const now = Date.now();
  let deleted = 0;
  let lingering = 0;
  await Promise.allSettled(
    matching.map(async (name) => {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(path);
          deleted++;
        } else {
          lingering++;
        }
      } catch {
        // best-effort
      }
    }),
  );
  return { deleted, lingering };
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
