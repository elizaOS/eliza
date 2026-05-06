/** @module services/pty-service */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type IAgentRuntime, logger, type Service } from "@elizaos/core";
import {
  type AdapterType,
  type AgentCredentials,
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
import { buildOpencodeSpawnConfig } from "./agent-credentials.js";
import { AgentMetricsTracker } from "./agent-metrics.js";
import type { AgentSelectionStrategy } from "./agent-selection.js";
import {
  captureTaskResponse,
  cleanForChat,
  extractCompletionSummary,
  peekTaskResponse,
} from "./ansi-utils.js";
import { ensureBundledClaudeCodeSkills } from "./claude-code-skill-installer.js";
import { readConfigEnvKey } from "./config-env.js";
import {
  type CoordinatorNormalizedEvent,
  normalizeCoordinatorEvent,
} from "./coordinator-event-normalizer.js";
import {
  captureFeed,
  captureLifecycle,
  captureSessionOpen,
  isDebugCaptureEnabled,
} from "./debug-capture.js";
import {
  handleGeminiAuth as handleGeminiAuthFlow,
  pushDefaultRules as pushDefaultAutoResponseRules,
} from "./pty-auto-response.js";
import { initializePTYManager } from "./pty-init.js";
import {
  getSessionOutput as getSessionOutputIO,
  type SessionIOContext,
  sendKeysToSession as sendKeysToSessionIO,
  sendToSession as sendToSessionIO,
  stopSession as stopSessionIO,
  subscribeToOutput as subscribeToOutputIO,
} from "./pty-session-io.js";
import {
  buildSpawnConfig,
  setupDeferredTaskDelivery,
  setupOutputBuffer,
  shouldUseCodexExecMode,
} from "./pty-spawn.js";
import type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventCallback,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.js";
import {
  isOpencodeAgentType,
  isPiAgentType,
  toOpencodeCommand,
  toPiCommand,
} from "./pty-types.js";
import { CLAUDE_SKILL_ESSENTIALS } from "./skill-essentials.js";
import {
  TRAJECTORY_CHILD_STEP_ENV_KEY,
  TRAJECTORY_CHILD_STEP_METADATA_KEY,
  TRAJECTORY_PARENT_STEP_METADATA_KEY,
  withLinkedSpawn,
} from "./spawn-trajectory.js";
import {
  classifyAndDecideForCoordinator,
  classifyStallOutput,
} from "./stall-classifier.js";
import { ensureStructuredProofBridge } from "./structured-proof-bridge.js";
import { SwarmCoordinator } from "./swarm-coordinator.js";
import { POST_SEND_COOLDOWN_MS } from "./swarm-decision-loop.js";
import {
  assistTaskAgentBrowserLogin,
  augmentTaskAgentPreflightResults,
  getTaskAgentLoginHint,
  isTaskAgentNonInteractiveAuthFailure,
  launchTaskAgentAuthFlow,
  probeTaskAgentAuth,
  type TaskAgentAuthFlowHandle,
  type TaskAgentAuthLaunchResult,
  type TaskAgentAuthStatus,
} from "./task-agent-auth.js";
import {
  buildTaskAgentTaskProfile,
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
  getTaskAgentModelPrefs,
  readTaskAgentModelPrefs,
  type SupportedTaskAgentAdapter,
  type TaskAgentFrameworkState,
  type TaskAgentTaskProfileInput,
} from "./task-agent-frameworks.js";

/**
 * Grace period after `task_complete` before auto-stopping a PTY session.
 * Short enough that stale subagents don't linger (spurious stall
 * classifications fire phantom heartbeats in downstream streamers), long
 * enough that backgrounded processes spawned by the agent can detach from
 * the PTY parent before it exits.
 */
const TASK_COMPLETE_STOP_DELAY_MS = 5_000;

export function shouldSuppressCodexExecPtyManagerEvent(options: {
  codexExecMode: boolean;
  event: string;
  data: unknown;
}): boolean {
  if (!options.codexExecMode) return false;
  const payload = options.data as
    | {
        source?: unknown;
      }
    | undefined;
  if (payload?.source !== "pty_manager") return false;

  // `codex exec` is non-interactive. Process exit and --output-last-message
  // are the authoritative completion signals; TUI prompt detectors can
  // misclassify ordinary exec output as login/blocking prompts.
  return options.event === "blocked" || options.event === "login_required";
}

/**
 * Portable safety floor injected into every spawned coding-agent's memory
 * file. Locks the agent to its allocated workspace dir so it never wanders
 * into $HOME or /tmp regardless of caller-supplied memoryContent. Deployment-
 * specific conventions (hosting, URLs, etc.) belong in caller memoryContent.
 */
const COMMON_LOCK_PREFIX = `# Operating mode

You are an autonomous Eliza sub-agent — there is no interactive human in this session. If you cannot do something, surface a \`DECISION: cannot continue because <reason>\` line on stdout (the orchestrator tails for those) and stop; do not ask a user to run a command for you.`;

const TOOL_DISCOVERY_HINTS: Record<CodingAgentType, string> = {
  claude: CLAUDE_SKILL_ESSENTIALS,
  gemini:
    "Your tool list is defined in `.gemini/settings.json`. Use `run_shell_command` for shell, `read_file`/`write_file` for I/O. Read settings before assuming a tool is missing.",
  codex:
    "Your tool list is the OpenAI Codex runtime's built-in set (`exec_command`, `apply_patch`, `read_file`, etc.). Session approval settings are injected by the Eliza runtime before startup.",
  aider:
    "Your tools are aider's slash commands (`/run`, `/edit`, `/add`, etc.); see `.aider.conf.yml` if present for any overrides.",
  hermes: "",
  shell: "",
  pi: "",
  opencode: "",
};

function buildWorkspaceLockMemory(
  workdir: string,
  agentType: CodingAgentType,
): string {
  const workspace = buildWorkspaceTaskPrefix(workdir);
  const hint = TOOL_DISCOVERY_HINTS[agentType] ?? "";
  return `${workspace}\n\n${COMMON_LOCK_PREFIX}${hint ? ` ${hint}` : ""}`;
}

function buildWorkspaceTaskPrefix(workdir: string): string {
  return `# Workspace

Your working directory is \`${workdir}\`. Stay inside it: do not \`cd\` to \`/tmp\`, \`/\`, \`$HOME\`, or any other path outside the workspace. Create all files, run all builds, and start all servers from this directory. If you need scratch space, make a subdirectory here.`;
}

function buildInlineWorkspaceTaskPrefix(workdir: string): string {
  return `Work only in \`${workdir}\`; do not leave that workspace.`;
}

function buildParentRuntimeBridgeMemory(
  sessionId: string,
  port: string,
): string {
  const base = `http://127.0.0.1:${port}/api/coding-agents/${encodeURIComponent(sessionId)}`;
  return `# Parent Eliza Runtime

You can read parent-runtime state via these loopback endpoints:

- \`curl ${base}/parent-context\` returns the parent's character, current room, model preferences, and your workdir.
- \`curl "${base}/memory?q=<query>"\` searches parent memory for matching entities, facts, messages, and knowledge.
- \`curl ${base}/active-workspaces\` lists the parent's known workspaces and task-agent sessions.

These endpoints are read-only. Do not POST to them. The parent already receives your lifecycle events through the hook channel installed in your workspace settings.`;
}

type CodexApprovalSettings = {
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  sandboxMode: "read-only" | "workspace-write";
  webSearch: boolean;
};

const CODEX_APPROVAL_SETTINGS: Record<ApprovalPreset, CodexApprovalSettings> = {
  readonly: {
    approvalPolicy: "untrusted",
    sandboxMode: "read-only",
    webSearch: false,
  },
  standard: {
    approvalPolicy: "on-failure",
    sandboxMode: "workspace-write",
    webSearch: true,
  },
  permissive: {
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    webSearch: true,
  },
  autonomous: {
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    webSearch: true,
  },
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexApprovalConfigToml(
  preset: ApprovalPreset,
  credentials?: AgentCredentials,
): string {
  const settings = CODEX_APPROVAL_SETTINGS[preset];
  const topLevel = [
    `approval_policy = ${tomlString(settings.approvalPolicy)}`,
    `sandbox_mode = ${tomlString(settings.sandboxMode)}`,
  ];

  if (credentials?.openaiBaseUrl?.trim()) {
    topLevel.push(`openai_base_url = ${tomlString(credentials.openaiBaseUrl)}`);
  }

  const extraConfigToml = credentials?.extraConfigToml?.trim();
  const sections = [
    topLevel.join("\n"),
    extraConfigToml,
    ["[tools]", `web_search = ${settings.webSearch}`].join("\n"),
  ].filter((section): section is string => Boolean(section?.trim()));

  return `${sections.join("\n\n")}\n`;
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeCodexAuthFile(
  codexHome: string,
  credentials?: AgentCredentials,
): Promise<void> {
  const openaiKey = credentials?.openaiKey?.trim();
  if (openaiKey) {
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "apikey",
          OPENAI_API_KEY: openaiKey,
          tokens: null,
          last_refresh: null,
        },
        null,
        2,
      ),
      "utf8",
    );
    return;
  }

  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const candidateAuthPaths = [
    configuredCodexHome ? join(configuredCodexHome, "auth.json") : undefined,
    join(homedir(), ".codex", "auth.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const authPath of candidateAuthPaths) {
    const existingAuth = await readFileIfPresent(authPath);
    if (!existingAuth) continue;
    await writeFile(join(codexHome, "auth.json"), existingAuth, "utf8");
    return;
  }
}

async function prepareCodexHome(
  sessionId: string,
  preset: ApprovalPreset,
  credentials?: AgentCredentials,
): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), `eliza-codex-${sessionId}-`));
  await mkdir(codexHome, { recursive: true });
  await writeCodexAuthFile(codexHome, credentials);
  await writeFile(
    join(codexHome, "config.toml"),
    buildCodexApprovalConfigToml(preset, credentials),
    "utf8",
  );
  return codexHome;
}

function prependWorkspaceLockToTask(
  task: string | undefined,
  workspaceLock: string,
): string | undefined {
  if (!task?.trim()) {
    return undefined;
  }
  return `${workspaceLock} ${task}`;
}

function resolveServerPort(runtime: IAgentRuntime): string {
  const raw = runtime.getSetting("SERVER_PORT");
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "2138";
}

export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName,
  SessionInfo,
  SpawnSessionOptions,
} from "./pty-types.js";
// Re-export for backward compatibility
export { normalizeAgentType } from "./pty-types.js";

/**
 * Narrow shape of `~/.claude.json` that we read/write here. Claude Code owns
 * the full schema; we touch only the `projects` map and its per-workdir
 * `hasTrustDialogAccepted` flag. Unknown keys are preserved via the
 * index signature so we never clobber fields we don't model.
 */
interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}
interface ClaudeConfig {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
}

/**
 * In-process serializer for `~/.claude.json` writes. Multiple subagents
 * spawning concurrently for different workdirs would otherwise each
 * read-modify-write the same file: last writer wins, intermediate trust
 * entries are lost. Chain writes per config path so each runs to
 * completion before the next starts.
 *
 * This only protects writes inside one process. If a user has another
 * claude CLI running that also writes the file, we still rely on the
 * read-on-startup + idempotent re-seed on next spawn to self-heal.
 */
const claudeConfigWriteQueue = new Map<string, Promise<void>>();

/**
 * Pre-accept Claude Code's one-time trust dialog for a workdir by writing
 * `hasTrustDialogAccepted: true` into `~/.claude.json`'s `projects` map.
 *
 * Why: Claude Code shows a Bypass Permissions / Trust dialog the first time
 * it runs in any unrecognised directory. On a fresh scratch workdir that
 * dialog is blocking: the auto-response path ends up pressing Enter, which
 * defaults to "No, exit" and kills the subagent with exit code 1 before any
 * work happens. Seeding the trust entry upfront skips the dialog entirely.
 *
 * Idempotent and best-effort: returns without throwing if the config file
 * does not yet exist, is unreadable, or is not valid JSON. In those cases
 * claude will show the dialog the normal way, which is no worse than before.
 *
 * Concurrency: serialized per config path via `claudeConfigWriteQueue` so
 * parallel swarm spawns don't clobber each other's trust entries.
 */
async function seedClaudeTrustForWorkdir(
  workdir: string,
  overrideConfigPath?: string,
): Promise<void> {
  const configPath = overrideConfigPath ?? join(homedir(), ".claude.json");
  const prior = claudeConfigWriteQueue.get(configPath) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => seedClaudeTrustForWorkdirUnsafe(configPath, workdir));
  claudeConfigWriteQueue.set(configPath, next);
  try {
    await next;
  } finally {
    if (claudeConfigWriteQueue.get(configPath) === next) {
      claudeConfigWriteQueue.delete(configPath);
    }
  }
}

export const seedClaudeTrustForWorkdirForTesting = seedClaudeTrustForWorkdir;

async function seedClaudeTrustForWorkdirUnsafe(
  configPath: string,
  workdir: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    // ENOENT on first-run is expected (claude has never run here); any
    // other read error (EACCES, EIO, etc.) is unexpected: log so we
    // don't silently skip trust-seeding on a genuinely broken config.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn(
        `[pty-service] seedClaudeTrustForWorkdir: failed to read ${configPath}: ${err}`,
      );
      return;
    }
    // ENOENT: create a minimal config so the write below has somewhere
    // to land. Claude Code is tolerant of extra projects entries and
    // will merge its own keys on first run.
    raw = "{}";
  }
  let parsed: ClaudeConfig;
  try {
    parsed = JSON.parse(raw) as ClaudeConfig;
  } catch (err) {
    // Malformed JSON: possible after an aborted claude write or manual
    // edit. Skip seeding (claude will show the dialog normally) but warn
    // so we can spot a corrupted config instead of silently bypassing.
    logger.warn(
      `[pty-service] seedClaudeTrustForWorkdir: ${configPath} is not valid JSON: ${err}`,
    );
    return;
  }
  const projects = parsed.projects ?? {};
  const existing = projects[workdir];
  if (existing && existing.hasTrustDialogAccepted === true) {
    return;
  }
  projects[workdir] = { ...existing, hasTrustDialogAccepted: true };
  parsed.projects = projects;
  await writeFile(configPath, JSON.stringify(parsed, null, 2), "utf8");
}

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
  private preflightCache: Map<
    string,
    { expiresAt: number; results: PreflightResult[] }
  > = new Map();
  private preflightInFlight: Map<string, Promise<PreflightResult[]>> =
    new Map();
  // Coalesces concurrent listSessions() calls against the Bun worker.
  // pty-manager keys its pending-response map by the command name ("list"),
  // so when two list() promises are in flight the second overwrites the
  // first's resolver. The worker only ever resolves the most recent one;
  // the earlier promise is orphaned and rejects with "Operation list timed
  // out" 30s later. Sharing a single in-flight call across concurrent
  // callers avoids the race entirely.
  private pendingBunList: ReturnType<BunCompatiblePTYManager["list"]> | null =
    null;

  private coalescedBunList(): ReturnType<BunCompatiblePTYManager["list"]> {
    if (!this.pendingBunList) {
      const bunManager = this.manager as BunCompatiblePTYManager;
      const fresh = bunManager.list();
      // Reset slot once the call settles. Rejection is handled by callers
      // awaiting `fresh` directly; the reset chain must not surface it as
      // an unhandled rejection of its own.
      const clear = () => {
        if (this.pendingBunList === fresh) this.pendingBunList = null;
      };
      fresh.then(clear, clear);
      this.pendingBunList = fresh;
    }
    return this.pendingBunList;
  }
  /** Pending task_complete → auto-stop timers, cancellable by the coordinator. */
  private taskCompleteAutoStopTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();
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

    // Install bundled Claude Code skills (e.g. eliza-runtime) into
    // ~/.claude/skills/ so spawned sub-agents see them on first use.
    // Skip-if-exists semantics — never stomps user customizations.
    try {
      ensureBundledClaudeCodeSkills(logger);
    } catch (err) {
      logger.warn(
        `[PTYService] bundled claude-code skill install failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Wire the SwarmCoordinator here instead of plugin init()
    // because ElizaOS calls Service.start() reliably but may not call
    // plugin.init() depending on the registration path.
    // Guard: the framework may call start() more than once, skip if
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

    // Install the structured-proof bridge once per runtime. It listens for
    // APP_CREATE_DONE / PLUGIN_CREATE_DONE sentinels in child PTY output and
    // persists the structured claim to the owning task's session metadata so
    // a custom validator can cross-check the claim against actual disk state.
    // Mirrors how `ensureSkillCallbackBridge` is registered per spawn — the
    // ensure-helper is internally idempotent.
    ensureStructuredProofBridge(runtime, service);

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
      sessionMetadata: this.sessionMetadata,
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
        // tool_running counts as active for PTY purposes: the task is
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
    const manager = result.manager;
    this.manager = manager;
    this.usingBunWorker = result.usingBunWorker;

    // Wire console bridge for terminal output streaming / hydration
    try {
      this.consoleBridge = new PTYConsoleBridge(manager, {
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
    for (const timer of this.taskCompleteAutoStopTimers.values()) {
      clearTimeout(timer);
    }
    this.taskCompleteAutoStopTimers.clear();
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
    return withLinkedSpawn(
      this.runtime,
      {
        source: "plugin-agent-orchestrator:pty-spawn",
        metadata: {
          name: options.name,
          requestedType: options.agentType,
          ...options.metadata,
        },
        env: options.env,
        childId: (session) => session.id,
      },
      (trajectory) =>
        this.spawnSessionInternal({
          ...options,
          env: trajectory.env,
          metadata: trajectory.metadata,
        }),
    );
  }

  private async spawnSessionInternal(
    options: SpawnSessionOptions,
  ): Promise<SessionInfo> {
    if (!this.manager) {
      throw new Error("PTYService not initialized");
    }

    const piRequested = isPiAgentType(options.agentType);
    const opencodeRequested = isOpencodeAgentType(options.agentType);
    const resolvedAgentType: CodingAgentType =
      piRequested || opencodeRequested ? "shell" : options.agentType;
    const effectiveApprovalPreset =
      options.approvalPreset ??
      (resolvedAgentType !== "shell" ? this.defaultApprovalPreset : undefined);

    let opencodeConfigEnv: Record<string, string> | undefined;
    if (opencodeRequested) {
      const spawnConfig = buildOpencodeSpawnConfig(this.runtime);
      if (!spawnConfig) {
        throw new Error(
          "OpenCode is requested but no model provider is configured. " +
            "Set PARALLAX_LLM_PROVIDER=cloud and pair an Eliza Cloud key, " +
            "set PARALLAX_OPENCODE_LOCAL=1 to use a local provider, " +
            "or set PARALLAX_OPENCODE_MODEL_POWERFUL to defer to your global opencode.json.",
        );
      }
      opencodeConfigEnv = {
        OPENCODE_CONFIG_CONTENT: spawnConfig.configContent,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_TERMINAL_TITLE: "1",
      };
      this.log(
        `OpenCode spawn provider: ${spawnConfig.providerLabel} (model=${spawnConfig.model}${spawnConfig.smallModel ? `, small=${spawnConfig.smallModel}` : ""})`,
      );
    }

    const maxSessions = this.serviceConfig.maxConcurrentSessions ?? 8;
    const activeSessions = (await this.listSessions()).length;
    if (activeSessions >= maxSessions) {
      throw new Error(`Concurrent session limit reached (${maxSessions})`);
    }

    const sessionId = this.generateSessionId();
    const hasParentTrajectoryStep =
      typeof options.metadata?.[TRAJECTORY_PARENT_STEP_METADATA_KEY] ===
        "string" &&
      options.metadata[TRAJECTORY_PARENT_STEP_METADATA_KEY].trim().length > 0;
    const linkedMetadata = hasParentTrajectoryStep
      ? {
          ...options.metadata,
          [TRAJECTORY_CHILD_STEP_METADATA_KEY]: sessionId,
        }
      : options.metadata;
    const linkedEnv = hasParentTrajectoryStep
      ? {
          ...options.env,
          [TRAJECTORY_CHILD_STEP_ENV_KEY]: sessionId,
        }
      : options.env;
    const workdir = options.workdir ?? process.cwd();
    const workspaceLock = buildWorkspaceLockMemory(workdir, resolvedAgentType);
    const workspaceTaskPrefix = buildInlineWorkspaceTaskPrefix(workdir);
    const serverPort = resolveServerPort(this.runtime);
    const parentRuntimeBridge = buildParentRuntimeBridgeMemory(
      sessionId,
      serverPort,
    );
    const shouldWriteMemoryFile = resolvedAgentType !== "shell";
    const hasCallerMemoryContent = Boolean(options.memoryContent?.trim());
    // The workspace lock is markdown prose meant to be read as CLAUDE.md
    // (or equivalent) by a reasoning subagent. Shell sessions receive
    // `initialTask` as literal stdin for /bin/bash, so any prose we prepend
    // would land as garbage "command not found" output and kick the
    // coordinator into a respond-loop. For shell agents we never prepend
    // the lock: shell tasks are expected to be bare commands, and staying
    // inside the workdir is enforced by the `cwd` we spawn the PTY with
    // (not by an advisory markdown note).
    const effectiveInitialTask =
      hasCallerMemoryContent || resolvedAgentType === "shell"
        ? options.initialTask
        : prependWorkspaceLockToTask(options.initialTask, workspaceTaskPrefix);
    const resolvedInitialTask = piRequested
      ? toPiCommand(effectiveInitialTask)
      : opencodeRequested
        ? toOpencodeCommand(effectiveInitialTask)
        : effectiveInitialTask;

    // Store workdir for later retrieval
    this.sessionWorkdirs.set(sessionId, workdir);

    // Pre-seed trust-dialog acceptance for claude workdirs. Claude Code shows
    // a one-time "Bypass Permissions" confirmation in every workdir whose
    // trust dialog hasn't been accepted. The dialog defaults "No, exit" on
    // Enter and kills the subagent before any work runs. Writing
    // `hasTrustDialogAccepted: true` into ~/.claude.json's `projects` map
    // skips both that dialog and the per-workdir trust prompt. No-op for
    // other agent types.
    if (resolvedAgentType === "claude") {
      await seedClaudeTrustForWorkdir(workdir).catch((err) =>
        this.log(`Failed to pre-seed claude trust for ${workdir}: ${err}`),
      );
    }

    // Write memory content before spawning so the agent reads it on startup.
    // Always include the workspace lock and parent bridge so spawned agents
    // stay in-bounds and can read narrowly-scoped parent context.
    if (shouldWriteMemoryFile) {
      const fullMemory = [
        workspaceLock,
        parentRuntimeBridge,
        options.memoryContent,
      ]
        .filter((section) => section?.trim())
        .join("\n\n---\n\n");
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

    let codexApprovalEnv: Record<string, string> | undefined;

    // Write approval config files before spawn.
    if (effectiveApprovalPreset && resolvedAgentType !== "shell") {
      if (resolvedAgentType === "codex") {
        const codexHome = await prepareCodexHome(
          sessionId,
          effectiveApprovalPreset,
          options.credentials,
        );
        codexApprovalEnv = { CODEX_HOME: codexHome };
        this.log(
          `Wrote Codex approval config (${effectiveApprovalPreset}) to ${join(codexHome, "config.toml")}`,
        );
      } else {
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
    }

    // Inject agent-specific settings and HTTP hooks
    const hookUrl = `http://localhost:${serverPort}/api/coding-agents/hooks`;

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

    // Centralize model-pref resolution across spawn paths. Reads runtime
    // settings (PARALLAX_*_MODEL_POWERFUL/FAST) and merges in any caller-
    // supplied options.metadata.modelPrefs. Restored after a merge that
    // accidentally took feat's narrower path.
    const resolvedModelPrefs = getTaskAgentModelPrefs(
      this.runtime,
      resolvedAgentType,
      readTaskAgentModelPrefs(linkedMetadata?.modelPrefs),
    );
    const metadataWithoutModelPrefs = { ...linkedMetadata };
    delete metadataWithoutModelPrefs.modelPrefs;
    const codexExecMode = shouldUseCodexExecMode({
      agentType: resolvedAgentType,
      initialTask: resolvedInitialTask,
      metadata: linkedMetadata,
    });
    const codexExecOutputDir = codexExecMode
      ? await mkdtemp(join(tmpdir(), `eliza-codex-${sessionId}-`))
      : undefined;
    const codexExecOutputFile = codexExecOutputDir
      ? join(codexExecOutputDir, "last-message.txt")
      : undefined;
    const resolvedMetadata = {
      ...metadataWithoutModelPrefs,
      requestedType: linkedMetadata?.requestedType ?? options.agentType,
      agentType: resolvedAgentType,
      coordinatorManaged: !!options.skipAdapterAutoResponse,
      ...(codexExecMode ? { codexExecMode: true } : {}),
      ...(codexExecOutputDir ? { codexExecOutputDir } : {}),
      ...(codexExecOutputFile ? { codexExecOutputFile } : {}),
      ...(resolvedModelPrefs ? { modelPrefs: resolvedModelPrefs } : {}),
    };

    const mergedSpawnEnv = {
      ...linkedEnv,
      ...codexApprovalEnv,
      ...opencodeConfigEnv,
    };
    const spawnConfig = buildSpawnConfig(
      sessionId,
      {
        ...options,
        env:
          Object.keys(mergedSpawnEnv).length > 0 ? mergedSpawnEnv : undefined,
        agentType: resolvedAgentType,
        initialTask: resolvedInitialTask,
        approvalPreset: effectiveApprovalPreset,
        metadata: resolvedMetadata,
      },
      workdir,
    );
    this.sessionMetadata.set(sessionId, resolvedMetadata);
    let session: SessionHandle | WorkerSessionHandle;
    try {
      session = await this.manager.spawn(spawnConfig);
    } catch (error) {
      if (codexExecOutputDir) {
        await rm(codexExecOutputDir, { recursive: true, force: true }).catch(
          (cleanupError) =>
            this.log(
              `Failed to remove Codex exec output dir ${codexExecOutputDir}: ${cleanupError}`,
            ),
        );
      }
      this.sessionMetadata.delete(sessionId);
      throw error;
    }
    this.terminalSessionStates.delete(session.id);
    this.sessionNames.set(session.id, options.name);

    // Store metadata separately (always include agentType for stall classification)
    this.sessionMetadata.set(session.id, resolvedMetadata);

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
    // Caller is feeding the session new work — cancel any pending
    // task_complete auto-stop so the agent gets to actually process this
    // input. (Without this, the SwarmCoordinator's small-LLM correction
    // for hallucinated refusals races against the 5s grace timer and the
    // PTY gets killed before the corrected turn completes.)
    this.cancelTaskCompleteAutoStop(sessionId);
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

  /**
   * Cancel a pending task_complete auto-stop for this session. Returns true
   * if a timer was cancelled, false if none was pending. Safe to call any
   * number of times. Intended for the swarm coordinator's task_complete
   * handler so the assessment LLM has time to decide whether to keep the
   * session alive (respond) or stop it (complete/escalate/ignore).
   */
  cancelTaskCompleteAutoStop(sessionId: string): boolean {
    const timer = this.taskCompleteAutoStopTimers.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.taskCompleteAutoStopTimers.delete(sessionId);
    return true;
  }

  async stopSession(sessionId: string, force = false): Promise<void> {
    if (!this.manager) throw new Error("PTYService not initialized");
    // Any explicit stop supersedes a pending auto-stop.
    const pending = this.taskCompleteAutoStopTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.taskCompleteAutoStopTimers.delete(sessionId);
    }
    captureLifecycle(sessionId, "session_stopped", force ? "force" : undefined);
    this.cancelTaskCompleteAutoStop(sessionId);
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

  /** Default approval preset. Runtime env var takes precedence over config. */
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

  /** Agent selection strategy. Env var takes precedence. */
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
      ? await this.coalescedBunList()
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
        // subagents sit around firing stall classifications that trigger
        // phantom heartbeats in downstream streamers minutes after the
        // user already got their answer. The coordinator's task_complete
        // handler calls cancelTaskCompleteAutoStop when it needs the
        // session for a follow-up assess+continuation, so the stop only
        // fires when the coordinator is genuinely done with the session.
        this.cancelTaskCompleteAutoStop(sessionId);
        this.taskCompleteAutoStopTimers.set(
          sessionId,
          setTimeout(() => {
            this.taskCompleteAutoStopTimers.delete(sessionId);
            this.stopSession(sessionId).catch((err) => {
              this.log(
                `Auto-stop after task_complete failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }, TASK_COMPLETE_STOP_DELAY_MS),
        );
        break;
      case "permission_approved":
        // Permission was auto-approved via PermissionRequest hook.
        // No PTY event needed. The hook response already allowed it.
        break;
      case "notification":
        this.emitEvent(sessionId, "message", { ...data, source: "hook" });
        break;
      case "session_end":
        // CLI session is ending. Treat as a stopped event so the coordinator
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
    const cacheKey = agentTypes.join(",");
    const now = Date.now();
    const cached = this.preflightCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.results;
    }

    const active = this.preflightInFlight.get(cacheKey);
    if (active) {
      return active;
    }

    const probe = (async () => {
      const results = await checkAdapters(agentTypes);
      const augmented = await augmentTaskAgentPreflightResults(results, {
        runtime: this.runtime,
      });
      this.preflightCache.set(cacheKey, {
        expiresAt: Date.now() + 60_000,
        results: augmented,
      });
      return augmented;
    })();

    this.preflightInFlight.set(cacheKey, probe);
    try {
      return await probe;
    } finally {
      this.preflightInFlight.delete(cacheKey);
    }
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
    const claudeNonInteractiveAuthError = isTaskAgentNonInteractiveAuthFailure(
      agentType,
      login.instructions,
      login.promptSnippet,
      login.method,
    );
    const status = claudeNonInteractiveAuthError
      ? ({
          status: "auth_error",
          detail:
            "Claude Code non-interactive auth returned 401 invalid credentials.",
          loginHint: getTaskAgentLoginHint(agentType),
        } satisfies TaskAgentAuthStatus)
      : await this.getAgentAuthStatus(agentType);
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
      // Whitespace-only auth instructions are not actionable; use the agent
      // hint unless the CLI provides a concrete login prompt.
      instructions:
        (status.status === "auth_error"
          ? `Claude Code non-interactive auth failed with 401 invalid credentials. ${status.loginHint ?? getTaskAgentLoginHint(agentType)}`
          : login.instructions?.trim()) ||
        getTaskAgentLoginHint(agentType) ||
        `Authentication is required for ${agentType}.`,
      ...(login.url ? { url: login.url } : {}),
      ...(login.deviceCode ? { deviceCode: login.deviceCode } : {}),
    };

    if (status.status !== "auth_error" && !launch.url && !launch.deviceCode) {
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
    return ["shell", "claude", "gemini", "codex", "aider", "pi", "opencode"];
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
    // autoResponded: true, skipping the second LLM call in handleBlocked().
    if (
      meta?.coordinatorManaged &&
      this.coordinator?.getSupervisionLevel() === "autonomous"
    ) {
      const taskCtx = this.coordinator.getTaskContext(sessionId);
      if (taskCtx) {
        // Suppress stall classification during the post-send cooldown.
        // The agent is processing coordinator input. The output buffer
        // still contains the previous response, so classifying now would
        // produce a stale "task_complete" that triggers cascading follow-ups.
        if (taskCtx.lastInputSentAt) {
          const elapsed = Date.now() - taskCtx.lastInputSentAt;
          if (elapsed < POST_SEND_COOLDOWN_MS) {
            this.log(
              `Suppressing stall classification for ${sessionId}: ` +
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
   * Appends to an existing .gitignore or creates one. Idempotent: skips if
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
      // No .gitignore yet, we'll create one
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
        // No .gitignore yet, create with just our entries
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
        : session.type === "shell" && isOpencodeAgentType(requestedType)
          ? "opencode"
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
        : storedAgentType === "shell" && isOpencodeAgentType(requestedType)
          ? "opencode"
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
      shouldSuppressCodexExecPtyManagerEvent({
        codexExecMode:
          this.sessionMetadata.get(sessionId)?.codexExecMode === true,
        event,
        data,
      })
    ) {
      return;
    }
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
