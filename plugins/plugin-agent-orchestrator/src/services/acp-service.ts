/**
 * `AcpService` (serviceType `ACP_SUBPROCESS_SERVICE`) owns the lifecycle of
 * coding-agent subprocesses driven over the Agent Client Protocol (ACP). It
 * spawns a chosen backend CLI (elizaos, pi-agent, claude, codex, opencode),
 * speaks ACP over the native transport, tracks per-session state and emits the
 * session events the SubAgentRouter and task store consume, and cancels or tears
 * sessions down on stop or process shutdown.
 *
 * Spawns are configured for the runtime environment: a per-spawn model-gateway
 * lease routes the sub-agent's inference through the parent (revoked when the
 * session ends), credential-proxy and model-gateway env is injected while
 * denied environment keys are stripped, and Codex runs get sandbox/approval
 * configuration with a Landlock-availability fallback. A single process-wide
 * SIGTERM/SIGINT handler fans out to every live instance so multi-tenant hosts,
 * test runners, and hot-reload cycles don't leak per-instance listeners.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE as CORE_SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import { NativeAcpClient } from "./acp-native-transport.js";
import { augmentTaskWithDeployGuidance } from "./app-deploy-guidance.js";
import {
  appendCodexAcpSandboxConfig,
  type CodexSandboxMode,
  commandHasCodexSandboxConfig,
  detectLandlockAvailability,
  isCodexLandlockPanic,
  normalizeCodexApprovalPolicy,
  normalizeCodexSandboxMode,
} from "./codex-sandbox.js";
import {
  accountMetaFromSessionMetadata,
  type CodingAccountMeta,
  diagnoseCodingAccountFallback,
  resolveCodingAccountStrategy,
  selectCodingAccount,
} from "./coding-account-selection.js";
import { readConfigMcpServers } from "./config-env.js";
import {
  applyCredentialProxyEnv,
  resolveOrchestratorCredentialProxyConfig,
} from "./credential-proxy-env.js";
import {
  applyModelGatewayEnv,
  MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS,
  resolveModelGatewayConfig,
} from "./model-gateway.js";
import {
  type ModelGatewayLease,
  mintSpawnLease,
  resolveLeaseBroker,
} from "./model-gateway-lease.js";
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
  /** Modern eliza runtime property (see packages/core/src/runtime.ts). */
  adapter?: unknown;
  /** Legacy alias for pre-2026 runtimes and some container harnesses. */
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
// TTL for a per-spawn model lease when neither the spawn nor the service config
// a timeout — mirrors ACPX_DEFAULT_TIMEOUT_MS (per-prompt) so a lease outlives a
// single prompt but not a stuck session indefinitely.
const DEFAULT_LEASE_TTL_MS = 300_000;
// Session events that mean the task ended; each revokes the session's lease.
const LEASE_REVOKE_EVENTS: ReadonlySet<SessionEventName> = new Set([
  "stopped",
  "error",
  "cancelled",
]);
const DEFAULT_WORKDIR_ROOT = join(tmpdir(), "eliza-acp");
const DEFAULT_CODEX_ACP_COMMAND = "npx -y @zed-industries/codex-acp@0.14.0";
const CODEX_NO_LANDLOCK_SANDBOX_MODE: CodexSandboxMode = "danger-full-access";
const CODEX_NO_LANDLOCK_APPROVAL_POLICY = "never";

/**
 * Resolve the absolute workdir for a spawned session. When `isolate` is true,
 * the session lands in a per-session subdir (`<base>/task-<sessionId>`) so
 * concurrent tasks sharing a scratch root never collide; otherwise the base is
 * used verbatim (cwd self-checkout / a route / an explicit caller-chosen dir).
 * Pure + exported for unit testing the concurrency-isolation guarantee.
 */
export function computeSessionWorkdir(
  base: string,
  sessionId: string,
  isolate: boolean,
): string {
  return isolate ? resolve(base, `task-${sessionId}`) : resolve(base);
}
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
// Background sub-agent initial tasks are fire-and-forget from the originating
// chat turn. When no action-level timeout is explicit, do not bind the
// session/prompt request to the ACP service default (often configured to the
// connector message budget, e.g. 120s). User cancel / shutdown still flow
// through cancelSession()/stopSession(), and explicit timeouts remain honored.
export function resolveInitialTaskPromptTimeoutMs(
  explicitTimeoutMs: number | undefined,
): number | undefined {
  return explicitTimeoutMs ?? 0;
}
const DEFAULT_AGENTS: AgentType[] = ["elizaos", "codex", "claude", "opencode"];
// Path segment the app-core coding-account bridge uses for per-account Codex
// homes (`<stateDir>/auth/_codex-home/<accountId>`). buildEnv keys off this
// marker to know a subscription account was selected and drop a forwarded
// OPENAI_API_KEY that would otherwise override the per-account auth.json. Kept
// in sync with coding-account-bridge.ts:codexHomeDir (cross-package, no shared
// import — the orchestrator depends only on @elizaos/core).
const CODEX_PER_ACCOUNT_HOME_MARKER = "_codex-home";
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
  // Repo-scoped GitHub host credentials must not be injected into sub-agents,
  // including through customCredentials. Registry push uses the dedicated
  // GHCR_* or ELIZA_APP_IMAGE_REGISTRY_* names instead.
  /^(?:GITHUB_TOKEN|GH_TOKEN|CR_PAT)$/i,
  // OpenCode's spawn config is runtime-built (buildOpencodeAcpEnv overwrites it
  // AFTER this filter runs). A caller- or host-supplied value would let the
  // spawner inject arbitrary provider config into the child, so it is denied at
  // both intake paths.
  /^OPENCODE_CONFIG_CONTENT$/i,
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

export const ACP_SUBPROCESS_SERVICE_TYPE =
  CORE_SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE ??
  "ACP_SUBPROCESS_SERVICE";

export class AcpService extends Service {
  static serviceType = ACP_SUBPROCESS_SERVICE_TYPE;

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
  // Per-session model-gateway lease (#11536 E2 residual). Minted at spawn when
  // gateway mode + a lease broker are configured; the leased token (not the
  // static ELIZA_MODEL_GATEWAY_TOKEN) is injected into the child env, and the
  // lease is revoked when the session reaches a terminal event.
  private readonly modelLeases = new Map<string, ModelGatewayLease>();
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
    // Revoke any leases still live on teardown (sessions that never reached a
    // terminal event — e.g. process shutdown mid-task).
    const leaseRevokes = Array.from(this.modelLeases.keys()).map((sessionId) =>
      this.revokeModelLease(sessionId, "service_stop"),
    );
    await Promise.allSettled([...stops, ...nativeStops, ...leaseRevokes]);
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
    const baseWorkdir =
      opts.workdir ??
      this.setting("ELIZA_ACP_WORKSPACE_ROOT") ??
      this.setting("ACPX_DEFAULT_CWD") ??
      DEFAULT_WORKDIR_ROOT;
    // Isolate concurrent sessions into a per-session subdir of a SHARED scratch
    // root so simultaneous projects never write into the same directory and
    // corrupt each other. Orchestrated callers opt in via opts.isolateWorkdir
    // (set ONLY when the resolver landed on a configured workspace root — never
    // for cwd self-checkout or a route/explicit dir). DIRECT callers (no
    // opts.workdir) always isolate: they have no self-checkout intent and would
    // otherwise share the configured root / DEFAULT_WORKDIR_ROOT.
    const isolate = opts.workdir ? opts.isolateWorkdir === true : true;
    const workdir = computeSessionWorkdir(baseWorkdir, id, isolate);
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

    // Multi-account selection: pick the least-used (default) linked subscription
    // for this agent type and inject its credentials into the spawn env so the
    // sub-agent authenticates AS that account. Returns null (and we keep the
    // single-account behavior) when no accounts are linked.
    const accountStrategy = resolveCodingAccountStrategy(
      this.setting("ELIZA_CODING_ACCOUNT_STRATEGY"),
    );
    const resolvedAccount = await selectCodingAccount(agentType, {
      sessionKey: id,
      ...(accountStrategy ? { strategy: accountStrategy } : {}),
    });
    const customCredentials = resolvedAccount
      ? {
          ...(opts.customCredentials ?? {}),
          ...resolvedAccount.selection.envPatch,
        }
      : opts.customCredentials;
    if (resolvedAccount) {
      this.log("info", "coding account selected for spawn", {
        sessionId: id,
        agentType,
        providerId: resolvedAccount.meta.providerId,
        accountId: resolvedAccount.meta.accountId,
        label: resolvedAccount.meta.label,
        strategy: resolvedAccount.meta.strategy,
      });
    } else {
      // A degraded pool must not hard-fail a spawn, but it must not degrade
      // invisibly either (#9960). Warn loudly only when accounts are connected
      // yet none are healthy — a benign empty pool stays quiet.
      const fallbackWarning = diagnoseCodingAccountFallback(agentType);
      if (fallbackWarning) {
        this.log("warn", "coding account pool degraded to single-account", {
          sessionId: id,
          agentType,
          detail: fallbackWarning,
        });
      }
    }

    const now = new Date();
    const mergedMetadata: Record<string, unknown> = {
      ...(opts.metadata ?? {}),
      ...(baselineSha ? { codingBaselineSha: baselineSha } : {}),
      ...(baselineSha && baselineDirty.length > 0
        ? { codingBaselineDirty: baselineDirty }
        : {}),
      ...(resolvedAccount ? { account: resolvedAccount.meta } : {}),
    };
    const hasMergedMetadata =
      Boolean(baselineSha) ||
      Boolean(resolvedAccount) ||
      Boolean(opts.metadata);
    const session: SessionInfo = {
      id,
      name,
      agentType,
      workdir,
      status: "running",
      approvalPreset,
      createdAt: now,
      lastActivityAt: now,
      metadata: hasMergedMetadata ? mergedMetadata : opts.metadata,
    };
    // Atomic check-and-reserve: enforces the session limit and inserts under a
    // single mutex so concurrent spawns can't overshoot maxSessions (the old
    // separate enforceSessionLimit()/store.create() left a read-then-act race).
    await this.reserveSessionSlot(session);

    // Mint the per-spawn model lease BEFORE the transport branch, so the leased
    // token (not the static gateway token) is what buildEnv injects into the
    // child. Fail-closed refusals (credit-gate / strict no-broker / strict mint
    // failure) throw here; undo the reserved slot so a refused spawn leaves no
    // orphan session record. No-op when gateway mode / lease broker are off.
    await this.mintSpawnLease(id, agentType, opts.timeoutMs);

    // App-build tasks lose the parent's deploy contract at the spawn boundary.
    // Re-attach it ONCE here, before the transport branch, so BOTH the native
    // and the CLI/acpx paths host the app and report a verified URL. No-op for
    // non-app tasks; applied only to the initial task, never to follow-up sends.
    const initialTask =
      opts.initialTask && opts.initialTask.trim().length > 0
        ? augmentTaskWithDeployGuidance(opts.initialTask, undefined, {
            monetized: opts.monetized,
          })
        : opts.initialTask;

    if (this.transportMode === "native") {
      const result = await this.spawnNativeSession(id, session, {
        ...opts,
        customCredentials,
      });
      if (opts.initialTask?.trim()) {
        const keepAliveAfterComplete =
          (opts.metadata as Record<string, unknown> | undefined)
            ?.keepAliveAfterComplete === true;
        void this.sendPrompt(id, initialTask ?? "", {
          timeoutMs: resolveInitialTaskPromptTimeoutMs(opts.timeoutMs),
          model: opts.model,
        })
          .catch((err: unknown) => {
            this.log("error", "initial prompt failed", {
              sessionId: id,
              agentType,
              promptLength: initialTask?.length ?? 0,
              promptPreview: preview(initialTask ?? ""),
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
        customCredentials,
        opts.model,
        agentType,
        id,
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
      void this.sendPrompt(id, initialTask ?? "", {
        timeoutMs: resolveInitialTaskPromptTimeoutMs(opts.timeoutMs),
        model: opts.model,
      })
        .catch((err: unknown) => {
          this.log("error", "initial prompt failed", {
            sessionId: id,
            agentType,
            promptLength: initialTask?.length ?? 0,
            promptPreview: preview(initialTask ?? ""),
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
      // Claim the session SYNCHRONOUSLY, before the first await. Previously the
      // busy marker was only added deep inside sendNativePrompt (after
      // `updateStatus` + client setup await), so two concurrent sendPrompt calls
      // could both pass the has() check before either added, driving two prompts
      // onto the same native session. Cleanup on the pre-prompt error paths;
      // sendNativePrompt's own finally clears it on the normal path.
      this.nativePromptSessionIds.add(sessionId);
      try {
        await this.store.updateStatus(sessionId, "busy");
        return await this.sendNativePrompt(session, text, opts, startedAt);
      } catch (err) {
        this.nativePromptSessionIds.delete(sessionId);
        throw err;
      }
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

    // The cli transport spawns a fresh subprocess per prompt, so re-inject the
    // session's selected-account credentials (the native transport keeps the
    // spawn-time client, which already has them).
    const promptCredentials = await this.accountCredentialsForSession(session);
    const result = await this.runAcpx({
      sessionId,
      sessionName: session.name ?? session.id,
      agentType: session.agentType,
      workdir: session.workdir,
      args,
      env: this.buildEnv(
        opts.env,
        promptCredentials,
        opts.model,
        session.agentType,
        sessionId,
      ),
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
      void this.revokeModelLease(sessionId, "cancelSession:native");
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
    void this.revokeModelLease(sessionId, "cancelSession");
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

  private codexAcpSandboxMode(): CodexSandboxMode | undefined {
    const raw =
      this.setting("ELIZA_CODEX_ACP_SANDBOX_MODE") ??
      this.setting("ELIZA_CODEX_SANDBOX_MODE");
    const mode = normalizeCodexSandboxMode(raw);
    if (raw?.trim() && !mode) {
      this.log("warn", "Ignoring invalid Codex ACP sandbox mode", {
        value: raw,
        supported: ["read-only", "workspace-write", "danger-full-access"],
      });
    }
    return mode;
  }

  private codexAcpApprovalPolicy(): string | undefined {
    const raw =
      this.setting("ELIZA_CODEX_ACP_APPROVAL_POLICY") ??
      this.setting("ELIZA_CODEX_APPROVAL_POLICY");
    const policy = normalizeCodexApprovalPolicy(raw);
    if (raw?.trim() && !policy) {
      this.log("warn", "Ignoring invalid Codex ACP approval policy", {
        value: raw,
        supported: ["untrusted", "on-request", "on-failure", "never"],
      });
    }
    return policy;
  }

  private codexNoLandlockSandboxMode(): CodexSandboxMode {
    const raw = this.setting("ELIZA_CODEX_ACP_NO_LANDLOCK_SANDBOX_MODE");
    const mode = normalizeCodexSandboxMode(raw);
    if (raw?.trim() && !mode) {
      this.log("warn", "Ignoring invalid Codex ACP no-Landlock sandbox mode", {
        value: raw,
        supported: ["read-only", "workspace-write", "danger-full-access"],
      });
    }
    return mode ?? CODEX_NO_LANDLOCK_SANDBOX_MODE;
  }

  private codexAgentCommand(): string {
    const command =
      this.setting("ELIZA_CODEX_ACP_COMMAND") ?? DEFAULT_CODEX_ACP_COMMAND;
    const configuredSandboxMode = this.codexAcpSandboxMode();
    if (configuredSandboxMode) {
      return appendCodexAcpSandboxConfig(
        command,
        configuredSandboxMode,
        this.codexAcpApprovalPolicy() ??
          (configuredSandboxMode === "danger-full-access"
            ? CODEX_NO_LANDLOCK_APPROVAL_POLICY
            : undefined),
      );
    }
    if (commandHasCodexSandboxConfig(command)) return command;

    const landlock = detectLandlockAvailability({
      env: {
        ELIZA_CODEX_ACP_LANDLOCK: this.setting("ELIZA_CODEX_ACP_LANDLOCK"),
        ELIZA_CODEX_LANDLOCK: this.setting("ELIZA_CODEX_LANDLOCK"),
      },
    });
    if (landlock !== "unavailable") return command;

    this.log(
      "warn",
      "Landlock unavailable; starting Codex ACP with sandbox fallback",
      {
        sandboxMode: this.codexNoLandlockSandboxMode(),
        approvalPolicy:
          this.codexAcpApprovalPolicy() ?? CODEX_NO_LANDLOCK_APPROVAL_POLICY,
      },
    );
    return appendCodexAcpSandboxConfig(
      command,
      this.codexNoLandlockSandboxMode(),
      this.codexAcpApprovalPolicy() ?? CODEX_NO_LANDLOCK_APPROVAL_POLICY,
    );
  }

  private codexLandlockFallbackCommand(
    agentType: AgentType,
    command: string,
    message: string,
  ): string | undefined {
    if ((normalizeTaskAgentAdapter(agentType) ?? agentType) !== "codex")
      return undefined;
    if (!isCodexLandlockPanic(message)) return undefined;
    if (commandHasCodexSandboxConfig(command)) return undefined;
    return appendCodexAcpSandboxConfig(
      command,
      this.codexAcpSandboxMode() ?? this.codexNoLandlockSandboxMode(),
      this.codexAcpApprovalPolicy() ?? CODEX_NO_LANDLOCK_APPROVAL_POLICY,
    );
  }

  private async spawnNativeSession(
    id: string,
    session: SessionInfo,
    opts: SpawnOptions,
  ): Promise<SpawnResult> {
    const command = this.nativeAgentCommand(session.agentType);
    const createClient = (clientCommand: string, stderr: string[]) =>
      new NativeAcpClient({
        command: clientCommand,
        cwd: session.workdir,
        approvalPreset: session.approvalPreset,
        timeoutMs: opts.timeoutMs ?? this.sessionTimeoutMs,
        terminal: !this.shouldDisableTerminalCapability(),
        env: this.buildEnv(
          opts.env,
          opts.customCredentials,
          opts.model,
          session.agentType,
          id,
        ),
        // Auto-inherit the parent runtime's configured MCP servers (config
        // `mcp.servers`) so the sub-agent gets the same MCP tools. Undefined when
        // none are configured → the transport falls back to ELIZA_ACP_MCP_SERVERS.
        mcpServers: readConfigMcpServers(),
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
    const attachClient = async (client: NativeAcpClient) => {
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
    };
    let stderr: string[] = [];
    let client = createClient(command, stderr);
    try {
      return await attachClient(client);
    } catch (err) {
      await client.close().catch(() => undefined);
      // A failed spawn must not leave a closed client registered: the entry is
      // set above before the store writes that can throw here. Idempotent when
      // the failure happened before the set.
      this.nativeClients.delete(id);
      let message = stderr.join("").trim() || errorMessage(err);
      const fallbackCommand = this.codexLandlockFallbackCommand(
        session.agentType,
        command,
        message,
      );
      if (fallbackCommand) {
        this.log(
          "warn",
          "Codex ACP Landlock unavailable; retrying with sandbox fallback",
          {
            sessionId: id,
            sandboxMode: this.codexNoLandlockSandboxMode(),
            approvalPolicy:
              this.codexAcpApprovalPolicy() ??
              CODEX_NO_LANDLOCK_APPROVAL_POLICY,
          },
        );
        stderr = [];
        client = createClient(fallbackCommand, stderr);
        try {
          return await attachClient(client);
        } catch (retryErr) {
          await client.close().catch(() => undefined);
          this.nativeClients.delete(id);
          message = stderr.join("").trim() || errorMessage(retryErr);
        }
      }
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
        ...(finalStopReason === "error" && !finalText?.trim()
          ? { error: "ACP prompt ended with stopReason error" }
          : {}),
      };
      if (stopped) {
        await this.store.updateStatus(session.id, "stopped");
        void this.revokeModelLease(session.id, "native_prompt:stopped");
      } else if (cancelled) {
        await this.store.updateStatus(session.id, "cancelled");
        void this.revokeModelLease(session.id, "native_prompt:cancelled");
      } else if (finalStopReason === "error" && !finalText?.trim()) {
        // Mirror the handleAcpEvent guard: a stopReason-error session that still
        // captured a real deliverable is relayed as a completion, so don't mark
        // it errored in the durable store — that would show a false-failed task
        // in history/providers while the user actually got the result.
        await this.store.updateStatus(
          session.id,
          "errored",
          "ACP prompt ended with stopReason error",
        );
        void this.revokeModelLease(session.id, "native_prompt:error");
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
        void this.revokeModelLease(session.id, "native_prompt:stopped");
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
        void this.revokeModelLease(session.id, "native_prompt:cancelled");
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
    if (normalizedAgentType === "codex") return this.codexAgentCommand();
    const override = this.setting(
      `ELIZA_${String(normalizedAgentType)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")}_ACP_COMMAND`,
    );
    if (override?.trim()) return override.trim();
    if (normalizedAgentType === "claude")
      return (
        this.setting("ELIZA_CLAUDE_ACP_COMMAND") ??
        "npx -y @agentclientprotocol/claude-agent-acp@0.34.0"
      );
    // The elizaos native agent is the eliza-code ACP server
    // (packages/examples/code, bin `eliza-code-acp`). The elizaos CLI has no
    // ACP mode, so the bare-name fallback below would spawn the wrong binary —
    // resolve to the eliza-code bin unless an explicit command is configured.
    if (normalizedAgentType === "elizaos")
      return this.setting("ELIZA_ELIZAOS_ACP_COMMAND") ?? "eliza-code-acp";
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
        // Pass agentType so the FINAL spawned env applies the agent-type
        // credential drops (claude → drop ANTHROPIC_API_KEY when
        // CLAUDE_CODE_OAUTH_TOKEN is present; codex → drop OPENAI_API_KEY when a
        // per-account CODEX_HOME is injected). buildEnv reseeds from
        // process.env, so without agentType here those parent keys would be
        // re-added and override the selected account on the cli transport.
        env: this.buildEnv(
          opts.env,
          undefined,
          undefined,
          opts.agentType,
          opts.sessionId,
        ),
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
      // The native transport auto-responds to permission requests per the
      // session's preset; surfacing "blocked" for a request it immediately
      // approves is a phantom block that derails the planner (re-spawns + a
      // user-facing "agent is blocked"). Only surface a genuine wait-for-user:
      // an auth challenge (always), or an op the transport won't approve (a
      // restrictive preset, or the legacy CLI transport with no native client).
      const autoApproved =
        this.nativeClients.get(sessionId)?.approvesPermissionRequest(params) ??
        false;
      const isAuthChallenge = isAuthText(description);
      if (isAuthChallenge || !autoApproved) {
        this.emitSessionEvent(sessionId, "blocked", {
          message: description,
          request: params,
        });
        if (isAuthChallenge)
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
      // agent_thought_chunk: the model's reasoning / chain-of-thought streams
      // in the SAME payload shape as agent_message_chunk (opencode emits it for
      // `reasoning` parts). Forward the text as a dedicated `reasoning` event so
      // the UI can surface it, but do NOT add it to finalText/appendOutput:
      // reasoning is not the deliverable response, and folding it into the turn
      // text would corrupt the task_complete summary and tool-output capture.
      else if (
        sessionUpdate === "agent_thought_chunk" &&
        content?.type === "text" &&
        typeof content.text === "string"
      ) {
        this.emitSessionEvent(sessionId, "reasoning", { text: content.text });
      }
      // plan: opencode emits the agent's todo/plan list as a `plan` update with
      // entries [{content, status, priority}] (driven by its todowrite tool).
      // Forward a sanitized snapshot as a `plan` event so the task's currentPlan
      // can drive the plan/todo dock. Validated at this boundary (raw -> typed);
      // an adapter that never emits a plan simply does not enter this branch.
      else if (sessionUpdate === "plan") {
        const rawEntries = updateBlock?.entries;
        if (Array.isArray(rawEntries)) {
          const asPlanText = (value: unknown): string | undefined =>
            typeof value === "string" && value !== "" ? value : undefined;
          const entries = rawEntries
            .map((entry) => asRecord(entry))
            .filter(
              (entry): entry is Record<string, unknown> => entry !== undefined,
            )
            .map((entry) => ({
              content: asPlanText(entry.content) ?? "",
              status: asPlanText(entry.status) ?? "pending",
              priority: asPlanText(entry.priority) ?? "medium",
            }))
            .filter((entry) => entry.content !== "");
          if (entries.length > 0)
            this.emitSessionEvent(sessionId, "plan", { entries });
        }
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
      // tool_call: emit tool_running on first submission, while in_progress,
      // and on terminal transitions. The terminal event is required by the
      // operator inspector so a completed/failed tool keeps its raw status and
      // raw output in the task timeline instead of only folding output into the
      // final assistant text. Some ACP adapters (notably claude-agent-sdk)
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
        if (
          isInitialSubmission ||
          isRunningStatus ||
          isInformativeUpdate ||
          isTerminalStatus
        ) {
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
        // A terminal stopReason of `error` does NOT mean the work was lost: the
        // sub-agent often wrote files, deployed, and printed a verified result
        // before its LAST step errored (a flaky post-build verify, a lint exit,
        // a model glitch). When real output was captured, relay it as a
        // completion so the normal task_complete path (URL verification,
        // deliverable capture, changeset narration) runs and can still downgrade
        // to a failure if the claimed URLs are dead. Only a stopReason error with
        // NO captured output is a true, user-facing failure — otherwise the user
        // gets a false "hit a snag" for a build that actually succeeded.
        if (stopReason === "error" && !finalText?.trim()) {
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
    // A terminal event means the task ended (completion via a stop/close,
    // failure, or timeout/cancel). Revoke the session's model lease so a leaked
    // child env is dead the moment its task ends. Fire-and-forget: this sync
    // emitter is called from deep transport paths; revocation is idempotent.
    if (LEASE_REVOKE_EVENTS.has(event)) {
      void this.revokeModelLease(sessionId, `event:${event}`);
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

  /**
   * Re-resolve the credential env for a session's previously selected account.
   * Used by the cli transport (which spawns a fresh subprocess per prompt);
   * session affinity keeps the same account, and the token is refreshed on each
   * resolve. Returns undefined when the session has no linked account.
   */
  private async accountCredentialsForSession(
    session: SessionInfo,
  ): Promise<Record<string, string> | undefined> {
    const meta: CodingAccountMeta | null = accountMetaFromSessionMetadata(
      session.metadata,
    );
    if (!meta) return undefined;
    const resolved = await selectCodingAccount(session.agentType, {
      sessionKey: session.id,
    });
    if (!resolved) return undefined;
    if (resolved.meta.accountId !== meta.accountId) {
      this.log("warn", "coding account drifted on follow-up prompt", {
        sessionId: session.id,
        previous: meta.accountId,
        now: resolved.meta.accountId,
      });
    }
    return resolved.selection.envPatch;
  }

  private buildEnv(
    extra?: Record<string, string | undefined>,
    customCredentials?: Record<string, string | undefined>,
    model?: string,
    agentType?: AgentType,
    childSessionId?: string,
  ): NodeJS.ProcessEnv {
    // Deny-list-filtered, allowlisted, casing-canonicalized host env (see
    // forwardableSubAgentEnv / canonicalForwardedEnvKey — Bun on Windows reports
    // OS vars like `Path` with native casing, which a child must not inherit
    // alongside an uppercase duplicate).
    const env: NodeJS.ProcessEnv = forwardableSubAgentEnv(process.env);
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
      env[canonicalForwardedEnvKey(key)] = value;
    }
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === "string") env[canonicalForwardedEnvKey(key)] = value;
    }
    if (model) {
      env.OPENAI_MODEL = model;
      if (agentType === "claude") env.ANTHROPIC_MODEL = model;
      if (agentType === "opencode") env.OPENCODE_MODEL = model;
    }
    if (childSessionId?.trim()) {
      env.PARALLAX_SESSION_ID = childSessionId.trim();
    }
    if (agentType === "claude" && env.CLAUDE_CODE_OAUTH_TOKEN) {
      // A specific subscription account was selected for this sub-agent. Claude
      // Code prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN, so drop any
      // API key (forwarded from the parent or a stray OAuth token) to guarantee
      // the chosen account's OAuth token is the one that authenticates.
      if (env.ANTHROPIC_API_KEY) {
        delete env.ANTHROPIC_API_KEY;
        this.log(
          "debug",
          "Dropped ANTHROPIC_API_KEY for claude sub-agent in favor of selected CLAUDE_CODE_OAUTH_TOKEN account",
        );
      }
    } else if (
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
    if (
      agentType === "codex" &&
      typeof env.CODEX_HOME === "string" &&
      env.CODEX_HOME.includes(CODEX_PER_ACCOUNT_HOME_MARKER)
    ) {
      // A specific Codex subscription account was selected: its ChatGPT-login
      // auth.json lives in the injected per-account CODEX_HOME.
      if (env.OPENAI_API_KEY) {
        // Codex treats a present env OPENAI_API_KEY as api-key mode, which
        // OVERRIDES that subscription login — silently defeating multi-account
        // selection. Drop it so the chosen account's auth.json authenticates
        // (symmetric to the Claude CLAUDE_CODE_OAUTH_TOKEN handling above).
        delete env.OPENAI_API_KEY;
        this.log(
          "debug",
          "Dropped OPENAI_API_KEY for codex sub-agent in favor of selected per-account CODEX_HOME",
        );
      }
      if (env.OPENAI_MODEL) {
        // A forwarded API-tier model (e.g. gpt-5.3-codex) is rejected by Codex
        // under ChatGPT-account auth ("model is not supported when using Codex
        // with a ChatGPT account"). Drop it so Codex picks its ChatGPT-
        // compatible default; an explicit model belongs in task policy, not
        // inherited from the runtime's OPENAI_MODEL.
        delete env.OPENAI_MODEL;
        this.log(
          "debug",
          "Dropped inherited OPENAI_MODEL for codex subscription sub-agent (lets Codex use its ChatGPT-compatible default)",
        );
      }
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
    // Gateway mode runs LAST so no earlier merge step (host forwarding,
    // customCredentials, spawn extras, account selection) can reintroduce a
    // raw provider key into the child env. Never log the token.
    const gateway = resolveModelGatewayConfig();
    if (gateway) {
      // Prefer this session's per-spawn lease token over the static gateway
      // token; the lease is scoped + short-lived + revocable (#11536 E2
      // residual). Falls back to the static token when no lease was minted
      // (no broker configured / non-strict mint failure).
      const lease = childSessionId
        ? this.modelLeases.get(childSessionId)
        : undefined;
      applyModelGatewayEnv(
        env,
        lease ? { url: gateway.url, token: lease.token } : gateway,
      );
      this.log("info", "model-gateway mode engaged for sub-agent env", {
        gatewayUrl: gateway.url,
        agentType,
        sessionId: childSessionId,
        leased: Boolean(lease),
        leaseId: lease?.leaseId,
        leaseExpiresAt: lease
          ? new Date(lease.expiresAt).toISOString()
          : undefined,
        excludedProviderKeys: [...MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS],
      });
    }
    // Credential-proxy mode (#11536 E3) — the NON-MODEL sibling of the gateway
    // block above. Independent env keys (VCS PATs + GIT_CONFIG_*), so it never
    // collides with the E2 model-key rewrite. Deletes every raw PAT from the
    // child env and points git at the broker's credential helper; in strict
    // mode a raw PAT present here throws and refuses the spawn (fail-closed).
    const credentialProxy = resolveOrchestratorCredentialProxyConfig();
    if (credentialProxy) {
      applyCredentialProxyEnv(env, credentialProxy, process.execPath, {
        strictScanEnv: process.env,
      });
      this.log("info", "credential-proxy mode engaged for sub-agent env", {
        proxyUrl: credentialProxy.url,
        strict: credentialProxy.strict,
        gitHosts: credentialProxy.routes.map((r) => r.host),
        agentType,
        sessionId: childSessionId,
      });
    }
    return env;
  }

  /**
   * Mint a per-spawn model-gateway lease and record it for the session. The
   * lease TTL equals the task timeout. On a fail-closed refusal (credit-gate,
   * strict no-broker, or strict mint failure) this throws AND rolls back the
   * reserved session record so a refused spawn leaves no orphan. No-op (leaves
   * the static-token path intact) when gateway/broker mode is off.
   */
  private async mintSpawnLease(
    sessionId: string,
    agentType: AgentType,
    timeoutMs: number | undefined,
  ): Promise<void> {
    const ttlMs = timeoutMs ?? this.sessionTimeoutMs ?? DEFAULT_LEASE_TTL_MS;
    let outcome: Awaited<ReturnType<typeof mintSpawnLease>>;
    try {
      outcome = await mintSpawnLease({ sessionId, agentType, ttlMs });
    } catch (err) {
      // Fail-closed: drop the reserved slot before surfacing the refusal.
      await this.store.delete(sessionId).catch(() => {});
      this.log("warn", "model-gateway lease refused; spawn blocked", {
        sessionId,
        agentType,
        error: errorMessage(err),
      });
      throw err;
    }
    if (outcome.kind === "leased") {
      this.modelLeases.set(sessionId, outcome.lease);
      this.log("info", "model-gateway lease minted for sub-agent", {
        sessionId,
        agentType,
        leaseId: outcome.lease.leaseId,
        expiresAt: new Date(outcome.lease.expiresAt).toISOString(),
      });
    }
  }

  /**
   * Revoke and forget a session's model lease. Delete-first makes it idempotent
   * — a session that fires several terminal events revokes exactly once.
   * Broker/gateway errors are logged, never thrown (revocation is best-effort
   * cleanup on an already-terminal session).
   */
  private async revokeModelLease(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const lease = this.modelLeases.get(sessionId);
    if (!lease) return;
    this.modelLeases.delete(sessionId);
    const gateway = resolveModelGatewayConfig();
    const broker = gateway ? resolveLeaseBroker(gateway) : null;
    if (!broker) return;
    try {
      await broker.revoke(lease.leaseId);
      this.log("info", "model-gateway lease revoked", {
        sessionId,
        leaseId: lease.leaseId,
        reason,
      });
    } catch (err) {
      this.log("warn", "model-gateway lease revoke failed", {
        sessionId,
        leaseId: lease.leaseId,
        reason,
        error: errorMessage(err),
      });
    }
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
    case "verifier":
      // Independent read-only verifier (#8898). acpx has no execute-approve flag,
      // so on the CLI transport the verifier gets the reads-approved / deny-the-rest
      // baseline (writes are denied — never over-permissioned). Execute approval is
      // enforced on the NATIVE transport (isOperationApproved), which is the
      // orchestrator default; CLI deny-writes is the safe floor.
      return ["--approve-reads", "--non-interactive-permissions", "deny"];
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
  if (
    normalized === "verifier" ||
    normalized === "read-execute" ||
    normalized === "read-only-execute"
  )
    return "verifier";
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

/**
 * OS-level environment variables a spawned coding agent needs to function.
 * Matched case-insensitively (see `shouldForwardEnv`): the repo runtime is Bun,
 * and Bun on Windows reports these with native casing — `Path`, not `PATH` —
 * so a case-sensitive check would forward NONE of them, leaving the child with
 * no search path (the opencode shim then fails with "'bun' is not recognized").
 * Includes the Windows essentials cmd.exe + Bun + the agent's config/cache
 * resolution rely on, alongside the POSIX names.
 */
const FORWARDED_SYSTEM_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  // Windows essentials.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "USERNAME",
  "USERDOMAIN",
]);

/**
 * The key a forwarded var is assigned under. OS system vars are canonicalized to
 * their uppercase `FORWARDED_SYSTEM_ENV` form because Bun on Windows reports them
 * with native casing (`Path`, `Pathext`, `SystemRoot`, `ProgramFiles`, …); a
 * child must not inherit two casings of the same var (the winner is undefined on
 * Windows), and JS consumers that read `env.PATH` case-sensitively need the
 * canonical key. Non-system keys (ELIZA_*, API keys, model overrides) keep their
 * original casing.
 */
export function canonicalForwardedEnvKey(key: string): string {
  return FORWARDED_SYSTEM_ENV.has(key.toUpperCase()) ? key.toUpperCase() : key;
}

export function shouldForwardEnv(key: string): boolean {
  return (
    FORWARDED_SYSTEM_ENV.has(key.toUpperCase()) ||
    key.startsWith("ACPX_AUTH_") ||
    key.startsWith("ELIZA_") ||
    // The live Cloud creds use the ELIZAOS_ prefix (ELIZAOS_CLOUD_API_KEY /
    // ELIZAOS_CLOUD_URL), which the broad ELIZA_ rule above does NOT match. A
    // spawned monetized-app build needs them to register the app (POST
    // /api/v1/apps) without hunting the filesystem for the key.
    key.startsWith("ELIZAOS_CLOUD") ||
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
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_TERMINAL_TITLE",
      "CODEX_HOME",
      // Container-registry PUSH credential for app-image builds (docker login
      // ghcr.io before the deploy contract's docker push). Narrow by design:
      // these are the dedicated registry-scoped names (a packages:write PAT),
      // mirrored cloud-side by containersEnv.registryUsername()/registryToken().
      // The broad GITHUB_TOKEN / GH_TOKEN / CR_PAT stay DENIED — a repo-scoped
      // host token must never ride into a sub-agent. The canonical
      // ELIZA_APP_IMAGE_REGISTRY_USERNAME/_TOKEN pair already forwards via the
      // ELIZA_ prefix above.
      "GHCR_USERNAME",
      "GHCR_TOKEN",
    ].includes(key)
  );
}

/**
 * The single forwarding decision buildEnv applies per host env var: the
 * deny-list wins over the allowlist. A few keys (the privileged host secrets in
 * DENY_ENV_PATTERNS) match shouldForwardEnv — e.g. via the broad ELIZA_ prefix —
 * yet must never reach a coding sub-agent, so the deny check runs first.
 */
export function isEnvForwardableToSubAgent(key: string): boolean {
  if (isDeniedSubAgentEnvKey(key)) return false;
  return shouldForwardEnv(key);
}

/**
 * The deny-list-filtered, allowlisted, casing-canonicalized subset of `source`
 * to forward to a coding sub-agent. Pure (no process.env read) so it is unit
 * testable: pass a synthetic env (e.g. `{ Path: "…" }`, the casing Bun reports
 * on Windows) and assert the result is keyed by `PATH`. See
 * `canonicalForwardedEnvKey` for why OS vars are canonicalized.
 */
export function forwardableSubAgentEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (!isEnvForwardableToSubAgent(key)) continue;
    out[canonicalForwardedEnvKey(key)] = value;
  }
  return out;
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
    // Some adapters (notably codex-acp) deliver the final assistant message as
    // an array of text content blocks split at word boundaries, where the
    // inter-word space is carried on NEITHER adjacent block — a bare join("")
    // then fuses the words ("is"+"proven" -> "isproven"). Re-insert a single
    // space ONLY when the boundary sits between two word characters and the
    // space is genuinely absent on both sides: this reproduces correctly spaced
    // blocks byte-for-byte (single-block / already-spaced results are unchanged)
    // and never touches punctuation or markdown sub-token splits.
    const joined = parts.reduce((acc, part) => {
      if (!acc) return part;
      const needsSpace = /\w$/u.test(acc) && /^\w/u.test(part);
      return needsSpace ? `${acc} ${part}` : `${acc}${part}`;
    }, "");
    return joined || undefined;
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

// Exported for unit coverage of the exec-record one-liner path (issue #11578).
export function normalizeToolOutput(rawOutput: unknown): string {
  if (typeof rawOutput === "string") {
    const trimmed = rawOutput.trim();
    const parsed = parseJsonRecord(trimmed);
    // A stringified exec record (Codex) parsed back to an object: render the
    // one-liner instead of echoing the raw JSON string (issue #11578 FIX B).
    const execLine = execRecordOneLiner(parsed);
    if (execLine) return execLine;
    return extractToolOutputText(parsed)?.trim() || trimmed;
  }
  if (rawOutput === undefined || rawOutput === null) return "";
  // Codex exec records (keys: call_id, command, exit_code, …) reached this
  // fallback and got JSON.stringify'd into the envelope, leaking the raw record
  // to the user (issue elizaOS/eliza#11578 FIX B). Detect the shape and render
  // a compact `$ <command> → exit <code>` one-liner instead; NEVER stringify a
  // record carrying call_id.
  const execLine = execRecordOneLiner(rawOutput);
  if (execLine) return execLine;
  const extracted = extractToolOutputText(rawOutput);
  return extracted?.trim() || JSON.stringify(rawOutput).trim();
}

/**
 * Render a Codex exec record (`{ call_id, command, exit_code, … }`) as a compact
 * one-liner: `$ <command joined> → exit <exit_code>` plus a capped stdout/stderr
 * tail when present. Returns undefined for anything that is not an exec record
 * (must have BOTH call_id AND command), so non-record output is unaffected.
 */
function execRecordOneLiner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const hasCallId = "call_id" in record && record.call_id != null;
  const rawCommand = record.command;
  if (!hasCallId || rawCommand == null) return undefined;

  const command = Array.isArray(rawCommand)
    ? rawCommand.map((part) => String(part)).join(" ")
    : String(rawCommand);
  const exitCode =
    typeof record.exit_code === "number" || typeof record.exit_code === "string"
      ? String(record.exit_code)
      : "?";
  let line = `$ ${command.trim()} → exit ${exitCode}`;

  const tail = execRecordOutputTail(record);
  if (tail) line = `${line}\n${tail}`;
  return line;
}

/** Extract a capped (≤200 char) stdout/stderr tail from an exec record. */
function execRecordOutputTail(record: Record<string, unknown>): string {
  const candidates = [record.stdout, record.stderr, record.output]
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (candidates.length === 0) return "";
  const joined = candidates.join("\n").trim();
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
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
    // Feed both names. The store prefers `adapter` and falls back to
    // `databaseAdapter`. This keeps ancient hand-rolled runtimes working
    // while wiring modern eliza runtimes to the SQL backend for real.
    adapter: runtime.adapter,
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
  // Lead-process signal: covers the no-pid case (e.g. unit-test doubles where
  // the child has not actually been forked) and the post-group-kill fallback.
  try {
    proc.kill(signal);
  } catch {
    // Best-effort termination only.
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
