/**
 * Swarm Coordinator: autonomous coordination loop bound to PTYService.
 *
 * Subscribes to PTY session events and routes unhandled blocking prompts
 * through an autonomous LLM decision pipeline. Heavy logic is extracted into
 * swarm-decision-loop.ts (blocked / turn-complete / LLM decisions) and
 * swarm-idle-watchdog.ts (idle session scanning).
 *
 * It is bound only to PTYService and is dormant for sessions spawned via
 * AcpService. The ACP flow is:
 *   AcpService session events → SubAgentRouter
 *     → synthetic Memory posted to runtime.messageService.handleMessage
 *     → main agent's planner decides REPLY / SEND_TO_AGENT / both.
 *
 * See `docs/sub-agent-routing.md`.
 *
 * @module services/swarm-coordinator
 */

import { promises as fs } from "node:fs";
import type { ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

/**
 * True when the workspace contains files the subagent produced. Filters
 * out our injected bookkeeping (CLAUDE.md memory file) and Claude Code's
 * own dot-prefixed scaffolding (`.claude/`, `.gitignore`, `.git/`). Query
 * tasks — "what's the price of btc", "explain X" — leave the workspace
 * with only those bookkeeping entries, so `false` lets callers skip the
 * noisy "task finished, code is at …" prompt for ephemeral lookups.
 */
async function _hasSubagentArtifacts(workspacePath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(workspacePath);
    return entries.some(
      (name) => name !== "CLAUDE.md" && !name.startsWith("."),
    );
  } catch {
    // Workspace already cleaned up or never existed — treat as no artifacts
    // so the caller defaults to the quiet path.
    return false;
  }
}

import { buildAgentCredentials } from "./agent-credentials.js";
import { cleanForFailoverContext, extractDevServerUrl } from "./ansi-utils.js";
import {
  type CoordinatorBlockedEvent,
  type CoordinatorLoginRequiredEvent,
  type CoordinatorNormalizedEvent,
  normalizeCoordinatorEvent,
} from "./coordinator-event-normalizer.js";
import type { PTYService } from "./pty-service.js";
import type { CodingAgentType } from "./pty-types.js";
import { normalizeAgentType } from "./pty-types.js";
import type {
  CoordinationLLMResponse,
  SharedDecision,
} from "./swarm-coordinator-prompts.js";
import {
  checkAllTasksComplete,
  clearDeferredTurnCompleteTimers,
  executeDecision as execDecision,
  handleBlocked,
  handleTurnComplete,
  shouldIgnoreStoppedEventDuringCompletion,
} from "./swarm-decision-loop.js";
import { SwarmHistory } from "./swarm-history.js";
import { scanIdleSessions } from "./swarm-idle-watchdog.js";
import { deriveTaskAcceptanceCriteria } from "./task-acceptance.js";
import type { TaskAgentAuthLaunchResult } from "./task-agent-auth.js";
import {
  isUsageExhaustedTaskAgentError,
  markTaskAgentFrameworkHealthy,
  markTaskAgentFrameworkUnavailable,
  type SupportedTaskAgentAdapter,
  type TaskAgentFrameworkAvailability,
  type TaskAgentFrameworkId,
} from "./task-agent-frameworks.js";
import { inferTaskThreadKind } from "./task-kind.js";
import {
  type CreateTaskThreadInput,
  type TaskDecisionRecord,
  type TaskNodeRecord,
  type TaskNodeStatus,
  type TaskPendingDecisionRecord,
  TaskRegistry,
  type TaskSessionRecord,
  type TaskThreadDetail,
  type TaskThreadStatus,
  type TaskThreadSummary,
} from "./task-registry.js";

// ─── Types ───

/** Callback injected by server.ts to route chat messages to the user's conversation. */
export type ChatMessageCallback = (
  text: string,
  source?: string,
) => Promise<void>;

/** Callback injected by server.ts to relay coordinator events to WebSocket clients. */
export type WsBroadcastCallback = (event: SwarmEvent) => void;

/**
 * Listener for in-process consumers of the same event stream that the
 * `wsBroadcast` callback receives (e.g. the verification-room-bridge in
 * plugin-app-control). Returned from `subscribe()`; call to unsubscribe.
 */
export type SwarmEventListener = (event: SwarmEvent) => void;

/**
 * Callback injected by server.ts to route coordinator events through
 * Eliza's full ElizaOS pipeline (conversation memory, personality, actions).
 * Returns a CoordinationLLMResponse parsed from Eliza's natural language
 * response, or null if no actionable JSON block was found.
 */
export type AgentDecisionCallback = (
  eventDescription: string,
  sessionId: string,
  taskContext: TaskContext,
) => Promise<CoordinationLLMResponse | null>;

/** Per-task summary included in the swarm complete payload. */
export interface TaskCompletionSummary {
  sessionId: string;
  label: string;
  agentType: string;
  originalTask: string;
  status: string;
  completionSummary: string;
  /** Validator-accepted user-facing summary, when a completion validator ran. */
  validationSummary?: string;
  /** Subagent's working directory — used by synthesis to read the final
   *  assistant response from the Claude Code session jsonl after the PTY
   *  session has been cleaned up. */
  workdir?: string;
  /** Room the task was spawned from (captured from the originating user
   *  message). Used by synthesis to route the final answer back to the
   *  same chat channel. */
  roomId?: string;
}

/** Callback fired when all tasks in a swarm reach terminal state. */
export type SwarmCompleteCallback = (payload: {
  tasks: TaskCompletionSummary[];
  total: number;
  completed: number;
  stopped: number;
  errored: number;
}) => Promise<void>;

export type SupervisionLevel = "autonomous" | "confirm" | "notify";

export interface TaskContext {
  threadId: string;
  taskNodeId?: string;
  sessionId: string;
  agentType: CodingAgentType;
  label: string;
  originalTask: string;
  workdir: string;
  /** Repository URL if provided, undefined for scratch directory tasks. */
  repo?: string;
  /** Original parent room for this spawned task, when available. */
  originRoomId?: string;
  /** Read-only parent metadata captured at spawn time. */
  originMetadata?: Record<string, unknown>;
  status:
    | "active"
    | "blocked"
    | "tool_running"
    | "completed"
    | "error"
    | "stopped";
  decisions: CoordinationDecision[];
  autoResolvedCount: number;
  registeredAt: number;
  /** Timestamp of the last session event (any type). Used by idle watchdog. */
  lastActivityAt: number;
  /** How many idle checks have been performed on this session. */
  idleCheckCount: number;
  /** True once the initial task has been delivered to the agent. */
  taskDelivered: boolean;
  /** Summary of what the agent accomplished, populated on completion. */
  completionSummary?: string;
  /** Validator-accepted summary to use as final-answer evidence. */
  validationSummary?: string;
  /** Index into sharedDecisions[]: tracks which decisions this agent has already seen. */
  lastSeenDecisionIndex: number;
  /** Timestamp of last coordinator-sent input. Used to suppress stall/turn-complete
   *  events for a grace period so the agent has time to process the input. */
  lastInputSentAt?: number;
  /** Timestamp when the task was last transitioned to `stopped`. */
  stoppedAt?: number;
  /** Suppress the generic stop notice when the session is intentionally replaced. */
  suppressStopNotice?: boolean;
  /** Keep the PTY session open after this task completes so callers can reuse it. */
  keepAliveAfterComplete?: boolean;
}

export interface CoordinationDecision {
  timestamp: number;
  event: string;
  promptText: string;
  decision:
    | "respond"
    | "escalate"
    | "ignore"
    | "complete"
    | "auto_resolved"
    | "stopped";
  response?: string;
  reasoning: string;
}

export interface SwarmEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  data: unknown;
}

export interface PendingDecision {
  sessionId: string;
  promptText: string;
  recentOutput: string;
  llmDecision: CoordinationLLMResponse;
  taskContext: TaskContext;
  createdAt: number;
}

/**
 * Context interface exposing internal state and helpers to extracted modules.
 * Implemented by SwarmCoordinator. Passed as `this` to module-level functions.
 */
export interface SwarmCoordinatorContext {
  readonly runtime: IAgentRuntime;
  readonly ptyService: PTYService | null;
  readonly taskRegistry: TaskRegistry;
  readonly tasks: Map<string, TaskContext>;
  readonly inFlightDecisions: Set<string>;
  readonly pendingDecisions: Map<string, PendingDecision>;
  /** Buffered task_complete events that arrived while an in-flight decision was running. */
  readonly pendingTurnComplete: Map<string, unknown>;
  /** Fingerprint of the last blocked prompt per session, for re-render dedup. */
  readonly lastBlockedPromptFingerprint: Map<string, string>;
  /** Buffered blocked events that arrived while an in-flight decision was running. */
  readonly pendingBlocked: Map<string, unknown>;
  /** Last-seen output snapshot per session, used by idle watchdog. */
  readonly lastSeenOutput: Map<string, string>;
  /** Timestamp of last tool_running chat notification per session, for throttling. */
  readonly lastToolNotification: Map<string, number>;

  /** Whether LLM decisions are paused (user sent a chat message). */
  readonly isPaused: boolean;

  /** Significant decisions shared across the swarm. */
  readonly sharedDecisions: SharedDecision[];

  /** Get the shared context brief from the planning phase. */
  getSwarmContext(): string;

  /**
   * Guard flag: whether the swarm_complete event has already been fired
   * for the current swarm lifecycle. Set to `true` by `checkAllTasksComplete()`
   * when all tasks reach terminal state. Reset to `false` by:
   * - `stop()`: full coordinator teardown
   * - `registerTask()`: when detecting a new swarm (all previous tasks terminal)
   */
  swarmCompleteNotified: boolean;

  broadcast(event: SwarmEvent): void;
  /**
   * Register an in-process listener that receives every broadcast event.
   * Returns an unsubscribe function. Listeners run synchronously after the
   * SSE/WS fan-out and must not throw — the coordinator catches and logs
   * any thrown error so a misbehaving listener cannot poison the event
   * stream for other consumers.
   */
  subscribe(listener: SwarmEventListener): () => void;
  sendChatMessage(text: string, source?: string): boolean;
  log(message: string): void;
  getSupervisionLevel(): SupervisionLevel;
  getAgentDecisionCallback(): AgentDecisionCallback | null;
  getSwarmCompleteCallback(): SwarmCompleteCallback | null;
  recordDecision(
    taskCtx: TaskContext,
    decision: CoordinationDecision,
  ): Promise<void>;
  syncTaskContext(taskCtx: TaskContext): Promise<void>;
}

// ─── Constants ───

/** Time to buffer events for unregistered sessions (ms). */
/** Exponential backoff delays for unregistered session buffer retries. */
const UNREGISTERED_RETRY_DELAYS = [2000, 4000, 8000, 16000];
/** Absolute maximum wait time before discarding unregistered events. */
const UNREGISTERED_MAX_TOTAL_MS = 30_000;

/** Coalesce rapid turn-complete events within this window (ms). */
const TURN_COMPLETE_COALESCE_MS = 500;

/** How often the idle watchdog scans for idle sessions (ms). */
const IDLE_SCAN_INTERVAL_MS = 60 * 1000; // 1 minute

/** How long to wait before auto-resuming a paused coordinator (ms). */
const PAUSE_TIMEOUT_MS = 30_000;
/** Max events to buffer before WS bridge is wired. */
const MAX_PRE_BRIDGE_BUFFER = 100;
/** Grace window where a late task_complete can recover a recently-stopped task. */
const STOPPED_RECOVERY_WINDOW_MS = 90_000;
const FAILOVER_OUTPUT_MAX_CHARS = 4_000;
const MAX_AUTOMATIC_ERROR_RECOVERIES = 2;
const ALTERNATE_FRAMEWORK_ERROR_RE =
  /\b(auth|login|credential|401|403|unauthorized|forbidden|token|api key|not found|enoent|missing executable|command not found)\b/i;

function inferProviderSource(
  framework: TaskAgentFrameworkAvailability,
): string | null {
  if (framework.subscriptionReady) {
    return "subscription";
  }
  if (framework.id === "pi") {
    return framework.installed ? "local-cli" : null;
  }
  if (framework.id === "opencode") {
    return framework.installed ? "local-cli" : null;
  }
  return framework.authReady ? "credentials" : null;
}

// ─── Service ───

export class SwarmCoordinator implements SwarmCoordinatorContext {
  static serviceType = "SWARM_COORDINATOR";

  readonly runtime: IAgentRuntime;
  readonly taskRegistry: TaskRegistry;
  ptyService: PTYService | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  /** Per-session task context. */
  readonly tasks: Map<string, TaskContext> = new Map();

  /** SSE clients receiving live events. */
  private sseClients: Set<ServerResponse> = new Set();

  /** Supervision level (default: autonomous). */
  private supervisionLevel: SupervisionLevel = "autonomous";

  /** Pending confirmations for "confirm" mode. */
  readonly pendingDecisions: Map<string, PendingDecision> = new Map();

  /** In-flight decision lock: prevents parallel LLM calls for same session. */
  readonly inFlightDecisions: Set<string> = new Set();

  /** Buffered task_complete events that arrived while an in-flight decision was running. */
  readonly pendingTurnComplete: Map<string, unknown> = new Map();

  /** Fingerprint of the last blocked prompt per session, for re-render dedup. */
  readonly lastBlockedPromptFingerprint: Map<string, string> = new Map();

  /** Buffered blocked events that arrived while an in-flight decision was running. */
  readonly pendingBlocked: Map<string, unknown> = new Map();

  /** Callback to send chat messages to the user's conversation UI. */
  private chatCallback: ChatMessageCallback | null = null;

  /** Callback to relay coordinator events to WebSocket clients. */
  private wsBroadcast: WsBroadcastCallback | null = null;

  /** Callback to route coordinator events through Eliza's full pipeline. */
  private agentDecisionCb: AgentDecisionCallback | null = null;

  /** Callback fired when all swarm tasks complete, for synthesis. */
  private swarmCompleteCb: SwarmCompleteCallback | null = null;

  /** Buffer for events arriving before task registration. */
  private unregisteredBuffer: Map<
    string,
    Array<{ normalized: CoordinatorNormalizedEvent; receivedAt: number }>
  > = new Map();

  /** Idle watchdog timer handle. */
  private idleWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  /** Last-seen output snapshot per session, used by idle watchdog to detect data flow. */
  readonly lastSeenOutput: Map<string, string> = new Map();

  /** Timestamp of last tool_running chat notification per session, for throttling. */
  readonly lastToolNotification: Map<string, number> = new Map();

  /** Whether LLM decisions are paused (user sent a chat message). */
  private _paused = false;

  /** Significant decisions shared across the swarm (Layer 2). */
  readonly sharedDecisions: SharedDecision[] = [];

  /** Shared context brief generated during swarm planning phase. */
  private _swarmContext = "";

  /** @see SwarmCoordinatorContext.swarmCompleteNotified */
  swarmCompleteNotified = false;

  /** Buffered events during pause, replayed on resume. */
  private pauseBuffer: CoordinatorNormalizedEvent[] = [];

  /** Buffered broadcasts waiting for wsBroadcast to be wired. */
  private preBridgeBroadcastBuffer: SwarmEvent[] = [];

  /** In-process listeners subscribed via `subscribe()`. */
  private eventListeners: Set<SwarmEventListener> = new Set();

  /** Auto-resume timeout handle. */
  private pauseTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Coordinator startup timestamp: ignore events from sessions created before this. */
  private readonly startedAt = Date.now();

  /** Active retry timers for unregistered session buffers. */
  private unregisteredRetryTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  /** Turn-complete coalescing timers: debounces rapid events per session. */
  private turnCompleteCoalesceTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();

  /** Persistent swarm history: JSONL log that survives restarts. */
  readonly history = new SwarmHistory();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.taskRegistry = new TaskRegistry(runtime);
  }

  // ─── Chat Callback ───

  /** Inject a callback (from server.ts) to route messages to the user's chat UI. */
  /** Track whether we've already wired the scratch decision callback. */
  private scratchDecisionWired = false;

  setChatCallback(cb: ChatMessageCallback): void {
    this.chatCallback = cb;
    this.log("Chat callback wired");
    // Try wiring scratch decision callback now, retry lazily if service not ready
    this.wireScratchDecisionCallback();
  }

  /**
   * Wire the scratch workspace save prompt callback.
   * Called eagerly from setChatCallback and lazily from handleSessionEvent
   * in case the workspace service wasn't ready at chat-callback time.
   */
  private wireScratchDecisionCallback(): void {
    if (this.scratchDecisionWired || !this.chatCallback) return;
    const wsService = this.runtime.getService("CODING_WORKSPACE_SERVICE") as
      | {
          setScratchDecisionCallback?: (
            cb: (record: {
              label: string;
              path: string;
              expiresAt?: number;
            }) => Promise<void>,
          ) => void;
        }
      | undefined;
    if (wsService?.setScratchDecisionCallback) {
      wsService.setScratchDecisionCallback(async (_record) => {
        // Scratch workspace TTL notices are runtime-internal; the real
        // task output is delivered by the synthesis path. Keeping this
        // callback registered (so the coordinator wiring is complete)
        // but silent in chat to avoid "Code is at …" leaks to Discord.
      });
      this.scratchDecisionWired = true;
      this.log("Scratch decision callback wired");
    }
  }

  /** Inject a callback (from server.ts) to relay events to WebSocket clients. */
  setWsBroadcast(cb: WsBroadcastCallback): void {
    this.wsBroadcast = cb;
    // Replay any events that were broadcast before the bridge was wired
    if (this.preBridgeBroadcastBuffer.length > 0) {
      this.log(
        `WS broadcast callback wired: replaying ${this.preBridgeBroadcastBuffer.length} buffered event(s)`,
      );
      for (const event of this.preBridgeBroadcastBuffer) {
        cb(event);
      }
      this.preBridgeBroadcastBuffer.length = 0;
    } else {
      this.log("WS broadcast callback wired");
    }
  }

  /** Inject a callback fired when all swarm tasks reach terminal state. */
  setSwarmCompleteCallback(cb: SwarmCompleteCallback): void {
    this.swarmCompleteCb = cb;
    this.log("Swarm complete callback wired");
  }

  /** Return the swarm complete callback (if wired). */
  getSwarmCompleteCallback(): SwarmCompleteCallback | null {
    return this.swarmCompleteCb;
  }

  /** Set the shared context brief for this swarm. */
  setSwarmContext(context: string): void {
    this._swarmContext = context;
    this.log(`Swarm context set (${context.length} chars)`);
  }

  /** Return the swarm planning context (if set). */
  getSwarmContext(): string {
    return this._swarmContext;
  }

  /** Inject a callback (from server.ts) to route events through Eliza's pipeline. */
  setAgentDecisionCallback(cb: AgentDecisionCallback): void {
    this.agentDecisionCb = cb;
    this.log("Agent decision callback wired, events will route through Eliza");
  }

  /** Return the agent decision callback (if wired). */
  getAgentDecisionCallback(): AgentDecisionCallback | null {
    return this.agentDecisionCb;
  }

  /**
   * Null-safe chat dispatcher.
   *
   * CALLING POLICY. Keep this consistent or you'll either spam users or
   * hide important signals:
   *
   *   POST to chat:   user must act (auth prompts, "needs your attention"
   *                   escalations, security violations, unrecoverable
   *                   errors), or the final result of the swarm (delivered
   *                   via the synthesis callback, not this method).
   *
   *   STAY SILENT:    coordinator-internal state transitions (auto-
   *                   recovery, token refresh, scratch-decision TTL,
   *                   tool_running progress, mid-task continuation
   *                   decisions, PTY session-lost on restart). Web UI
   *                   still sees these via `broadcast()`; chat should
   *                   not duplicate them, because synthesis will deliver
   *                   the final outcome once a terminal state is reached.
   */
  sendChatMessage(text: string, source?: string): boolean {
    if (!this.chatCallback) return false;
    this.chatCallback(text, source).catch((err) => {
      this.log(`Failed to send chat message: ${err}`);
    });
    return true;
  }

  // ─── Lifecycle ───

  /**
   * Initialize the coordinator by subscribing to PTY session events.
   * Called from plugin init after services are ready.
   */
  async start(ptyService: PTYService): Promise<void> {
    await this.taskRegistry.ensureSchema();
    await this.taskRegistry.recoverInterruptedTasks();
    await this.rehydratePendingDecisions();
    this.ptyService = ptyService;
    this.unsubscribeEvents = ptyService.onNormalizedSessionEvent(
      (normalized) => {
        this.handleNormalizedSessionEvent(normalized).catch((err) => {
          this.log(`Error handling event: ${err}`);
        });
      },
    );

    // Start idle watchdog
    this.idleWatchdogTimer = setInterval(() => {
      scanIdleSessions(this).catch((err) => {
        this.log(`Idle watchdog error: ${err}`);
      });
    }, IDLE_SCAN_INTERVAL_MS);

    this.log("SwarmCoordinator started");
  }

  private restorePendingTaskContext(
    record: TaskPendingDecisionRecord,
  ): TaskContext {
    const raw = record.taskContext;
    const status = (() => {
      switch (typeof raw.status === "string" ? raw.status : "") {
        case "active":
        case "blocked":
        case "tool_running":
        case "completed":
        case "error":
        case "stopped":
          return raw.status as TaskContext["status"];
        default:
          return "blocked";
      }
    })();
    return {
      threadId:
        typeof raw.threadId === "string" && raw.threadId.trim().length > 0
          ? raw.threadId
          : record.threadId,
      ...(typeof raw.taskNodeId === "string" && raw.taskNodeId.trim().length > 0
        ? { taskNodeId: raw.taskNodeId }
        : {}),
      sessionId: record.sessionId,
      agentType:
        typeof raw.agentType === "string" && raw.agentType.trim().length > 0
          ? (raw.agentType as CodingAgentType)
          : "claude",
      label:
        typeof raw.label === "string" && raw.label.trim().length > 0
          ? raw.label
          : `agent-${record.sessionId.slice(-8)}`,
      originalTask:
        typeof raw.originalTask === "string"
          ? raw.originalTask
          : record.promptText,
      workdir: typeof raw.workdir === "string" ? raw.workdir : "",
      ...(typeof raw.repo === "string" && raw.repo.trim().length > 0
        ? { repo: raw.repo }
        : {}),
      ...(typeof raw.originRoomId === "string" &&
      raw.originRoomId.trim().length > 0
        ? { originRoomId: raw.originRoomId }
        : {}),
      ...(raw.originMetadata &&
      typeof raw.originMetadata === "object" &&
      !Array.isArray(raw.originMetadata)
        ? { originMetadata: raw.originMetadata as Record<string, unknown> }
        : {}),
      status,
      decisions: Array.isArray(raw.decisions)
        ? (raw.decisions.filter((entry) =>
            Boolean(entry && typeof entry === "object"),
          ) as CoordinationDecision[])
        : [],
      autoResolvedCount:
        typeof raw.autoResolvedCount === "number" ? raw.autoResolvedCount : 0,
      registeredAt:
        typeof raw.registeredAt === "number"
          ? raw.registeredAt
          : record.createdAt,
      lastActivityAt:
        typeof raw.lastActivityAt === "number"
          ? raw.lastActivityAt
          : record.createdAt,
      idleCheckCount:
        typeof raw.idleCheckCount === "number" ? raw.idleCheckCount : 0,
      taskDelivered: raw.taskDelivered === true,
      ...(typeof raw.completionSummary === "string"
        ? { completionSummary: raw.completionSummary }
        : {}),
      ...(typeof raw.validationSummary === "string"
        ? { validationSummary: raw.validationSummary }
        : {}),
      lastSeenDecisionIndex:
        typeof raw.lastSeenDecisionIndex === "number"
          ? raw.lastSeenDecisionIndex
          : 0,
      ...(typeof raw.lastInputSentAt === "number"
        ? { lastInputSentAt: raw.lastInputSentAt }
        : {}),
      ...(typeof raw.stoppedAt === "number"
        ? { stoppedAt: raw.stoppedAt }
        : {}),
    };
  }

  private restorePendingLlmDecision(
    record: TaskPendingDecisionRecord,
  ): CoordinationLLMResponse {
    const raw = record.llmDecision;
    const action =
      typeof raw.action === "string" &&
      ["respond", "escalate", "ignore", "complete"].includes(raw.action)
        ? (raw.action as CoordinationLLMResponse["action"])
        : "escalate";
    return {
      action,
      ...(typeof raw.response === "string" ? { response: raw.response } : {}),
      ...(raw.useKeys === true ? { useKeys: true } : {}),
      ...(Array.isArray(raw.keys)
        ? {
            keys: raw.keys.filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : {}),
      reasoning:
        typeof raw.reasoning === "string" && raw.reasoning.trim().length > 0
          ? raw.reasoning
          : "Recovered pending confirmation from persisted coordinator state.",
    };
  }

  private async rehydratePendingDecisions(): Promise<void> {
    const records = await this.taskRegistry.listPendingDecisions();
    for (const record of records) {
      const taskContext = this.restorePendingTaskContext(record);
      this.tasks.set(record.sessionId, taskContext);
      this.pendingDecisions.set(record.sessionId, {
        sessionId: record.sessionId,
        promptText: record.promptText,
        recentOutput: record.recentOutput,
        llmDecision: this.restorePendingLlmDecision(record),
        taskContext,
        createdAt: record.createdAt,
      });
    }
  }

  async stop(): Promise<void> {
    const persistOnShutdown = Array.from(this.tasks.values())
      .filter(
        (task) =>
          task.status === "active" ||
          task.status === "blocked" ||
          task.status === "tool_running",
      )
      .map(async (task) => {
        task.status = "stopped";
        task.stoppedAt = Date.now();
        await this.taskRegistry.updateSession(task.sessionId, {
          status: "interrupted",
          lastActivityAt: task.lastActivityAt,
          idleCheckCount: task.idleCheckCount,
          taskDelivered: task.taskDelivered,
          autoResolvedCount: task.autoResolvedCount,
          decisionCount: task.decisions.length,
          completionSummary: task.completionSummary ?? null,
          lastSeenDecisionIndex: task.lastSeenDecisionIndex,
          lastInputSentAt: task.lastInputSentAt,
          stoppedAt: task.stoppedAt,
        });
        await this.taskRegistry.appendEvent({
          threadId: task.threadId,
          sessionId: task.sessionId,
          eventType: "session_interrupted",
          summary: "Session interrupted during coordinator shutdown",
          data: { reason: "coordinator_shutdown" },
        });
      });
    await Promise.allSettled(persistOnShutdown);
    if (this.idleWatchdogTimer) {
      clearInterval(this.idleWatchdogTimer);
      this.idleWatchdogTimer = null;
    }
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }
    // Close all SSE connections
    for (const client of this.sseClients) {
      if (!client.writableEnded) {
        client.end();
      }
    }
    this.sseClients.clear();
    this.tasks.clear();
    this.pendingDecisions.clear();
    this.inFlightDecisions.clear();
    this.pendingTurnComplete.clear();
    clearDeferredTurnCompleteTimers();
    this.lastBlockedPromptFingerprint.clear();
    this.pendingBlocked.clear();
    this.unregisteredBuffer.clear();
    for (const timer of this.unregisteredRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.unregisteredRetryTimers.clear();
    for (const timer of this.turnCompleteCoalesceTimers.values()) {
      clearTimeout(timer);
    }
    this.turnCompleteCoalesceTimers.clear();
    this.lastSeenOutput.clear();
    this.lastToolNotification.clear();
    this.agentDecisionCb = null;
    this.sharedDecisions.length = 0;
    this._swarmContext = "";
    this.swarmCompleteNotified = false;
    // Clear pause state
    this._paused = false;
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }
    this.pauseBuffer = [];
    this.preBridgeBroadcastBuffer.length = 0;
    this.log("SwarmCoordinator stopped");
  }

  // ─── Pause / Resume ───

  /** Whether the coordinator is currently paused. */
  get isPaused(): boolean {
    return this._paused;
  }

  /** Pause LLM-based decisions. Auto-responses and broadcasts continue. */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this.log(
      "Coordinator paused: buffering LLM decisions until user message is processed",
    );
    this.broadcast({
      type: "coordinator_paused",
      sessionId: "",
      timestamp: Date.now(),
      data: {},
    });

    // Safety: auto-resume after timeout
    this.pauseTimeout = setTimeout(() => {
      if (this._paused) {
        this.log("Coordinator auto-resuming after timeout");
        this.resume();
      }
    }, PAUSE_TIMEOUT_MS);
  }

  /** Resume LLM-based decisions and replay buffered events. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }

    this.log(
      `Coordinator resumed: replaying ${this.pauseBuffer.length} buffered events`,
    );
    this.broadcast({
      type: "coordinator_resumed",
      sessionId: "",
      timestamp: Date.now(),
      data: {},
    });

    // Replay buffered events
    const buffered = [...this.pauseBuffer];
    this.pauseBuffer = [];
    for (const entry of buffered) {
      this.handleNormalizedSessionEvent(entry).catch((err) => {
        this.log(`Error replaying buffered event: ${err}`);
      });
    }
  }

  // ─── Task Registration ───

  async registerTask(
    sessionId: string,
    context: {
      threadId?: string;
      taskNodeId?: string;
      agentType: CodingAgentType;
      label: string;
      originalTask: string;
      workdir: string;
      repo?: string;
      providerSource?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const threadId = context.threadId?.trim() || sessionId;
    // Reset swarm state when the first task of a new swarm is registered.
    // Check for terminal-only tasks (all previous tasks in completed/stopped/error)
    // rather than empty map, so reuse without stop() works.
    const allPreviousTerminal =
      this.tasks.size === 0 ||
      Array.from(this.tasks.values()).every(
        (t) =>
          t.status === "completed" ||
          t.status === "stopped" ||
          t.status === "error",
      );
    if (allPreviousTerminal) {
      this.swarmCompleteNotified = false;
      // Clear stale tasks and shared context from previous swarm
      if (this.tasks.size > 0) {
        this.tasks.clear();
        this.sharedDecisions.length = 0;
        this._swarmContext = "";
        this.log("Cleared stale swarm state for new swarm");
      }
    }

    const taskNodeId = context.taskNodeId?.trim() || `node-${sessionId}`;
    const originRoomId =
      typeof context.metadata?.originRoomId === "string" &&
      context.metadata.originRoomId.trim().length > 0
        ? context.metadata.originRoomId.trim()
        : typeof context.metadata?.roomId === "string" &&
            context.metadata.roomId.trim().length > 0
          ? context.metadata.roomId.trim()
          : undefined;
    const keepAliveAfterComplete =
      context.metadata?.keepAliveAfterComplete === true;

    this.tasks.set(sessionId, {
      threadId,
      taskNodeId,
      sessionId,
      agentType: context.agentType,
      label: context.label,
      originalTask: context.originalTask,
      workdir: context.workdir,
      repo: context.repo,
      ...(originRoomId ? { originRoomId } : {}),
      ...(context.metadata ? { originMetadata: context.metadata } : {}),
      status: "active",
      decisions: [],
      autoResolvedCount: 0,
      registeredAt: Date.now(),
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      taskDelivered: false,
      lastSeenDecisionIndex: 0,
      ...(keepAliveAfterComplete ? { keepAliveAfterComplete: true } : {}),
    });

    // Persist last used repo so it survives task cleanup
    if (context.repo) {
      this._lastUsedRepo = context.repo;
    }

    // Log to persistent history (fire-and-forget)
    this.history
      .append({
        timestamp: Date.now(),
        type: "task_registered",
        sessionId,
        label: context.label,
        agentType: context.agentType,
        repo: context.repo,
        workdir: context.workdir,
        originalTask: context.originalTask,
      })
      .catch((err) => {
        this.log(
          `Failed to append task registration history for ${sessionId}: ${err}`,
        );
      });

    const taskCtx = this.tasks.get(sessionId);
    const persistPromise = taskCtx
      ? (async () => {
          const existingThread =
            await this.taskRegistry.getThreadRecord(threadId);
          if (!existingThread) {
            await this.createTaskThread({
              id: threadId,
              title: context.label,
              originalRequest: context.originalTask,
              metadata: {
                repo: context.repo ?? null,
                source: "register-task-fallback",
              },
            });
          }
          const existingNode = await this.taskRegistry.getTaskNode(taskNodeId);
          if (!existingNode) {
            await this.taskRegistry.createTaskNode({
              id: taskNodeId,
              threadId: taskCtx.threadId,
              kind: "execution",
              status: "running",
              title: context.label,
              instructions: context.originalTask,
              requiredCapabilities: [context.agentType],
              assignedSessionId: sessionId,
              assignedLabel: context.label,
              agentType: context.agentType,
              workdir: context.workdir,
              repo: context.repo,
              createdFrom: context.taskNodeId
                ? "register-task-existing-node"
                : "register-task-fallback",
              metadata: {
                providerSource: context.providerSource ?? null,
              },
            });
          } else if (existingNode.threadId !== taskCtx.threadId) {
            throw new Error(
              `Task node ${taskNodeId} belongs to ${existingNode.threadId}, expected ${taskCtx.threadId}`,
            );
          }
          await Promise.all([
            this.taskRegistry.registerSession({
              threadId: taskCtx.threadId,
              sessionId,
              framework: context.agentType,
              providerSource: context.providerSource,
              label: context.label,
              originalTask: context.originalTask,
              workdir: context.workdir,
              repo: context.repo,
              status: "active",
              decisionCount: 0,
              autoResolvedCount: 0,
              registeredAt: taskCtx.registeredAt,
              lastActivityAt: taskCtx.lastActivityAt,
              idleCheckCount: taskCtx.idleCheckCount,
              taskDelivered: false,
              lastSeenDecisionIndex: 0,
              metadata: {
                ...(context.metadata ?? {}),
                taskNodeId,
              },
            }),
            this.taskRegistry.updateTaskNode(taskNodeId, {
              status: "running",
              title: context.label,
              instructions: context.originalTask,
              assignedSessionId: sessionId,
              assignedLabel: context.label,
              agentType: context.agentType,
              workdir: context.workdir,
              repo: context.repo,
              metadata: {
                providerSource: context.providerSource ?? null,
              },
            }),
            this.taskRegistry.createTaskClaim({
              threadId,
              nodeId: taskNodeId,
              sessionId,
              claimType: "execution",
              status: "active",
              metadata: {
                label: context.label,
              },
            }),
            this.taskRegistry.appendEvent({
              threadId,
              sessionId,
              eventType: "task_registered",
              timestamp: Date.now(),
              summary: `Registered task "${context.label}"`,
              data: {
                label: context.label,
                originalTask: context.originalTask,
                repo: context.repo ?? null,
                taskNodeId,
              },
            }),
          ]);
        })()
      : Promise.resolve();
    void persistPromise.catch((err) => {
      this.log(`Failed to persist task registration for ${sessionId}: ${err}`);
    });

    this.broadcast({
      type: "task_registered",
      sessionId,
      timestamp: Date.now(),
      data: {
        agentType: context.agentType,
        label: context.label,
        originalTask: context.originalTask,
      },
    });

    // Cancel any pending retry timer and flush buffered events
    const retryTimer = this.unregisteredRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.unregisteredRetryTimers.delete(sessionId);
    }
    const buffered = this.unregisteredBuffer.get(sessionId);
    if (buffered) {
      this.unregisteredBuffer.delete(sessionId);
      for (const entry of buffered) {
        this.handleNormalizedSessionEvent(entry.normalized).catch((err) => {
          this.log(`Error replaying buffered event: ${err}`);
        });
      }
    }
    await persistPromise;
  }

  /**
   * Return the repo URL from the most recently registered task that had one.
   * Useful as a fallback when the user says "in the same repo" without a URL.
   */
  /**
   * Persisted separately from tasks so it survives task cleanup.
   * Updated whenever a task with a repo is registered.
   */
  private _lastUsedRepo: string | undefined;

  getLastUsedRepo(): string | undefined {
    // Check active tasks first (freshest), fall back to in-memory persisted value
    let latest: TaskContext | undefined;
    for (const task of this.tasks.values()) {
      if (task.repo && (!latest || task.registeredAt > latest.registeredAt)) {
        latest = task;
      }
    }
    return latest?.repo ?? this._lastUsedRepo;
  }

  /**
   * Async version that also checks disk history, survives process restarts.
   * Callers that can await should prefer this over the sync version.
   */
  async getLastUsedRepoAsync(): Promise<string | undefined> {
    const memoryRepo = this.getLastUsedRepo();
    if (memoryRepo) return memoryRepo;
    try {
      return (
        (await this.taskRegistry.getLastUsedRepo()) ??
        (await this.history.getLastUsedRepo())
      );
    } catch {
      return undefined;
    }
  }

  getTaskContext(sessionId: string): TaskContext | undefined {
    return this.tasks.get(sessionId);
  }

  private mapDecisionRecord(record: TaskDecisionRecord): CoordinationDecision {
    return {
      timestamp: record.timestamp,
      event: record.event,
      promptText: record.promptText,
      decision: record.decision as CoordinationDecision["decision"],
      ...(record.response ? { response: record.response } : {}),
      reasoning: record.reasoning,
    };
  }

  private mapSessionStatus(
    status: TaskSessionRecord["status"],
  ): TaskContext["status"] {
    switch (status) {
      case "blocked":
      case "waiting_on_user":
        return "blocked";
      case "tool_running":
        return "tool_running";
      case "completed":
        return "completed";
      case "error":
        return "error";
      case "stopped":
      case "interrupted":
        return "stopped";
      default:
        return "active";
    }
  }

  private mapTaskContextStatusToNodeStatus(
    status: TaskContext["status"],
  ): TaskNodeStatus {
    switch (status) {
      case "blocked":
        return "blocked";
      case "completed":
        return "completed";
      case "error":
        return "failed";
      case "stopped":
        return "interrupted";
      case "tool_running":
        return "running";
      default:
        return "running";
    }
  }

  private buildTaskContextFromSession(
    session: TaskSessionRecord,
    decisions: TaskDecisionRecord[],
  ): TaskContext {
    return {
      threadId: session.threadId,
      ...(typeof session.metadata.taskNodeId === "string" &&
      session.metadata.taskNodeId.trim().length > 0
        ? { taskNodeId: session.metadata.taskNodeId }
        : {}),
      sessionId: session.sessionId,
      agentType: session.framework,
      label: session.label,
      originalTask: session.originalTask,
      workdir: session.workdir,
      ...(session.repo ? { repo: session.repo } : {}),
      status: this.mapSessionStatus(session.status),
      decisions: decisions.map((decision) => this.mapDecisionRecord(decision)),
      autoResolvedCount: session.autoResolvedCount,
      registeredAt: session.registeredAt,
      lastActivityAt: session.lastActivityAt,
      idleCheckCount: session.idleCheckCount,
      taskDelivered: session.taskDelivered,
      ...(session.completionSummary
        ? { completionSummary: session.completionSummary }
        : {}),
      lastSeenDecisionIndex: session.lastSeenDecisionIndex,
      ...(session.lastInputSentAt !== null
        ? { lastInputSentAt: session.lastInputSentAt }
        : {}),
      ...(session.stoppedAt !== null ? { stoppedAt: session.stoppedAt } : {}),
    };
  }

  async getTaskContextSnapshot(sessionId: string): Promise<TaskContext | null> {
    const live = this.tasks.get(sessionId);
    if (live) return live;
    const session = await this.taskRegistry.getSession(sessionId);
    if (!session) return null;
    const decisions =
      await this.taskRegistry.listDecisionsForSession(sessionId);
    return this.buildTaskContextFromSession(session, decisions);
  }

  getAllTaskContexts(): TaskContext[] {
    return Array.from(this.tasks.values());
  }

  async createTaskThread(
    input: CreateTaskThreadInput,
  ): Promise<TaskThreadSummary> {
    const normalizedInput: CreateTaskThreadInput = {
      ...input,
      kind: inferTaskThreadKind(input),
    };
    const acceptance = await deriveTaskAcceptanceCriteria(
      this.runtime,
      normalizedInput,
    );
    const thread = await this.taskRegistry.createThread({
      ...normalizedInput,
      acceptanceCriteria: acceptance.criteria,
      metadata: {
        ...(normalizedInput.metadata ?? {}),
        acceptanceCriteriaSource: acceptance.source,
      },
    });
    const summary = await this.taskRegistry.getThreadSummary(thread.id);
    if (!summary) {
      throw new Error(`Failed to load task thread ${thread.id}`);
    }
    return summary;
  }

  async planTaskThreadGraph(input: {
    threadId: string;
    title: string;
    originalRequest: string;
    sharedContext?: string;
    subtasks: Array<{
      label: string;
      originalTask: string;
      agentType: CodingAgentType;
      repo?: string;
    }>;
  }): Promise<{
    rootNode: TaskNodeRecord;
    workerNodes: TaskNodeRecord[];
  }> {
    const thread = await this.taskRegistry.getThreadRecord(input.threadId);
    if (!thread) {
      throw new Error(`Task thread ${input.threadId} not found`);
    }

    const rootNode = await this.taskRegistry.createTaskNode({
      threadId: input.threadId,
      parentNodeId: null,
      kind: "goal",
      status: "planned",
      title: input.title,
      instructions: input.originalRequest,
      acceptanceCriteria: thread.acceptanceCriteria,
      priority: 100,
      depth: 0,
      sequence: 0,
      createdFrom: "planner",
      metadata: {
        threadKind: thread.kind,
        source: "swarm-planner",
      },
    });

    // The acceptance verifier is a code-completion safety check: it asks the
    // LLM whether file/test evidence in the workspace matches the criteria,
    // catching agents that lie about completing code work. It's only useful
    // when there is real artifact evidence to verify (a repo) AND real
    // criteria to check against (provided or model-generated, not the
    // baseline placeholder fallback). For chat / question-answering tasks
    // (no repo, response IS the deliverable) the verifier produces false
    // failures because there are no files to inspect.
    const acceptanceCriteriaSource =
      typeof thread.metadata?.acceptanceCriteriaSource === "string"
        ? thread.metadata.acceptanceCriteriaSource
        : null;
    const hasRepo =
      typeof thread.metadata?.repo === "string" &&
      thread.metadata.repo.trim().length > 0;
    if (
      thread.acceptanceCriteria.length > 0 &&
      acceptanceCriteriaSource !== "baseline" &&
      hasRepo
    ) {
      await this.taskRegistry.createTaskVerifierJob({
        threadId: input.threadId,
        nodeId: rootNode.id,
        status: "pending",
        verifierType: "acceptance_criteria",
        title: `Verify acceptance criteria for ${input.title}`,
        instructions: thread.acceptanceCriteria.join("\n"),
        config: {
          acceptanceCriteria: thread.acceptanceCriteria,
        },
        metadata: {
          source: "thread-acceptance",
        },
      });
    }

    if (input.sharedContext?.trim()) {
      await this.taskRegistry.appendTaskMailboxMessage({
        threadId: input.threadId,
        nodeId: rootNode.id,
        sender: "planner",
        recipient: "all-workers",
        subject: "shared-context",
        body: input.sharedContext.trim(),
        deliveryState: "delivered",
        deliveredAt: new Date().toISOString(),
        metadata: {
          source: "swarm-planner",
        },
      });
    }

    const workerNodes: TaskNodeRecord[] = [];
    for (const [index, subtask] of input.subtasks.entries()) {
      const node = await this.taskRegistry.createTaskNode({
        threadId: input.threadId,
        parentNodeId: rootNode.id,
        kind: "execution",
        status: "ready",
        title: subtask.label,
        instructions: subtask.originalTask,
        requiredCapabilities: [subtask.agentType],
        repo: subtask.repo,
        priority: 10,
        depth: 1,
        sequence: index + 1,
        createdFrom: "planner",
        metadata: {
          agentType: subtask.agentType,
          source: "swarm-planner",
        },
      });
      await this.taskRegistry.createTaskDependency({
        threadId: input.threadId,
        fromNodeId: node.id,
        toNodeId: rootNode.id,
        dependencyKind: "parent_child",
        requiredStatus: "completed",
        metadata: {
          source: "swarm-planner",
        },
      });
      if (input.sharedContext?.trim()) {
        await this.taskRegistry.appendTaskMailboxMessage({
          threadId: input.threadId,
          nodeId: node.id,
          sender: "planner",
          recipient: subtask.label,
          subject: "task-brief",
          body: input.sharedContext.trim(),
          deliveryState: "delivered",
          deliveredAt: new Date().toISOString(),
          metadata: {
            task: subtask.originalTask,
            agentType: subtask.agentType,
          },
        });
      }
      workerNodes.push(node);
    }

    await this.taskRegistry.updateThread(input.threadId, {
      currentPlan: {
        ...thread.currentPlan,
        rootTaskNodeId: rootNode.id,
        taskNodeIds: workerNodes.map((node) => node.id),
        taskNodeCount: workerNodes.length + 1,
      },
    });

    return { rootNode, workerNodes };
  }

  async listTaskThreads(options?: {
    includeArchived?: boolean;
    status?: TaskThreadStatus;
    statuses?: TaskThreadStatus[];
    kind?: import("./task-registry.js").TaskThreadKind;
    roomId?: string;
    worldId?: string;
    ownerUserId?: string;
    scenarioId?: string;
    batchId?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    latestActivityAfter?: number;
    latestActivityBefore?: number;
    hasActiveSession?: boolean;
    search?: string;
    limit?: number;
  }): Promise<TaskThreadSummary[]> {
    return this.taskRegistry.listThreads(options);
  }

  async getTaskThread(threadId: string): Promise<TaskThreadDetail | null> {
    return this.taskRegistry.getThread(threadId);
  }

  async archiveTaskThread(threadId: string): Promise<void> {
    await this.taskRegistry.archiveThread(threadId);
  }

  async reopenTaskThread(threadId: string): Promise<void> {
    await this.taskRegistry.reopenThread(threadId);
  }

  async countTaskThreads(options?: {
    includeArchived?: boolean;
    status?: TaskThreadStatus;
    statuses?: TaskThreadStatus[];
    kind?: import("./task-registry.js").TaskThreadKind;
    roomId?: string;
    worldId?: string;
    ownerUserId?: string;
    scenarioId?: string;
    batchId?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    latestActivityAfter?: number;
    latestActivityBefore?: number;
    hasActiveSession?: boolean;
    search?: string;
  }): Promise<number> {
    return this.taskRegistry.countThreads(options);
  }

  private getLiveTaskContextsForThread(threadId: string): TaskContext[] {
    return Array.from(this.tasks.values())
      .filter((task) => task.threadId === threadId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  private async stopLiveThreadSessions(
    threadId: string,
    force: boolean,
  ): Promise<string[]> {
    if (!this.ptyService) {
      return [];
    }

    const sessionIds = this.getLiveTaskContextsForThread(threadId)
      .filter(
        (task) =>
          task.status === "active" ||
          task.status === "blocked" ||
          task.status === "tool_running",
      )
      .map((task) => task.sessionId);
    for (const sessionId of sessionIds) {
      const taskCtx = this.tasks.get(sessionId);
      if (taskCtx) {
        taskCtx.status = "stopped";
        taskCtx.stoppedAt = Date.now();
        await this.syncTaskContext(taskCtx);
      }
      try {
        await this.ptyService.stopSession(sessionId, force);
      } catch (error) {
        this.log(
          `Failed to stop session ${sessionId} for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return sessionIds;
  }

  private clipText(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}…`;
  }

  private formatResumePrompt(
    thread: TaskThreadDetail,
    instruction?: string,
  ): string {
    const acceptanceCriteria = (thread.acceptanceCriteria ?? [])
      .map((item) => `- ${item}`)
      .join("\n");
    const recentDecisions = (thread.decisions ?? [])
      .slice(-6)
      .map(
        (decision, index) =>
          `${index + 1}. ${decision.event}: ${decision.reasoning}${decision.response ? ` (response: ${decision.response})` : ""}`,
      )
      .join("\n");
    const recentEvents = (thread.events ?? [])
      .slice(-8)
      .map(
        (event, index) =>
          `${index + 1}. ${event.eventType}: ${this.clipText(event.summary, 180)}`,
      )
      .join("\n");
    const transcriptExcerpt = (thread.transcripts ?? [])
      .slice(-20)
      .map(
        (entry) =>
          `${entry.direction.toUpperCase()}: ${this.clipText(entry.content.trim(), 220)}`,
      )
      .filter((line) => line.length > 0)
      .join("\n");
    const latestSession = (thread.sessions ?? [])
      .slice()
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];

    return [
      "Resume an existing Eliza coordinator task thread.",
      "",
      `Thread: ${thread.title}`,
      `Original request: ${thread.originalRequest}`,
      latestSession?.workdir ? `Workspace: ${latestSession.workdir}` : "",
      latestSession?.repo ? `Repository: ${latestSession.repo}` : "",
      thread.summary ? `Current summary: ${thread.summary}` : "",
      acceptanceCriteria ? `Acceptance criteria:\n${acceptanceCriteria}` : "",
      instruction?.trim()
        ? `Latest user instruction:\n${instruction.trim()}`
        : "Continue from the current workspace state without starting over.",
      recentDecisions
        ? `Recent coordinator decisions:\n${recentDecisions}`
        : "",
      recentEvents ? `Recent task events:\n${recentEvents}` : "",
      transcriptExcerpt
        ? `Recent transcript excerpt:\n${transcriptExcerpt}`
        : "",
      "Inspect the current workspace, continue the task, run the relevant verification, and summarize what changed.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async pauseTaskThread(
    threadId: string,
    note?: string,
  ): Promise<{ threadId: string; stoppedSessionIds: string[] }> {
    const thread = await this.getTaskThread(threadId);
    if (!thread) {
      throw new Error(`Task thread ${threadId} not found`);
    }

    const stoppedSessionIds = await this.stopLiveThreadSessions(threadId, true);
    const nowIso = new Date().toISOString();
    await this.taskRegistry.updateThread(threadId, {
      status: "waiting_on_user",
      closedAt: null,
      lastCoordinatorTurnAt: nowIso,
      metadata: {
        controlState: "paused",
        pauseNote: note ?? null,
        pauseRequestedAt: nowIso,
      },
    });
    await this.taskRegistry.appendEvent({
      threadId,
      eventType: "task_paused",
      summary: note?.trim()
        ? `Paused task thread: ${note.trim()}`
        : "Paused task thread for user review",
      data: {
        note: note ?? null,
        stoppedSessionIds,
      },
    });
    return { threadId, stoppedSessionIds };
  }

  async stopTaskThread(
    threadId: string,
    note?: string,
  ): Promise<{ threadId: string; stoppedSessionIds: string[] }> {
    const thread = await this.getTaskThread(threadId);
    if (!thread) {
      throw new Error(`Task thread ${threadId} not found`);
    }

    const stoppedSessionIds = await this.stopLiveThreadSessions(threadId, true);
    const nowIso = new Date().toISOString();
    await this.taskRegistry.updateThread(threadId, {
      status: "interrupted",
      closedAt: nowIso,
      lastCoordinatorTurnAt: nowIso,
      metadata: {
        controlState: "stopped",
        stopNote: note ?? null,
        stoppedByUserAt: nowIso,
      },
    });
    await this.taskRegistry.appendEvent({
      threadId,
      eventType: "task_stopped",
      summary: note?.trim()
        ? `Stopped task thread: ${note.trim()}`
        : "Stopped task thread at user request",
      data: {
        note: note ?? null,
        stoppedSessionIds,
      },
    });
    return { threadId, stoppedSessionIds };
  }

  async resumeTaskThread(
    threadId: string,
    instruction?: string,
    agentType?: string,
  ): Promise<{
    threadId: string;
    sessionId: string;
    reusedSession: boolean;
    framework: CodingAgentType;
  }> {
    const thread = await this.getTaskThread(threadId);
    if (!thread) {
      throw new Error(`Task thread ${threadId} not found`);
    }
    if (!this.ptyService) {
      throw new Error("PTY Service is not available");
    }

    const activeTask = this.getLiveTaskContextsForThread(threadId).find(
      (task) =>
        task.status !== "stopped" &&
        task.status !== "completed" &&
        task.status !== "error",
    );
    if (activeTask) {
      if (instruction?.trim()) {
        await this.ptyService.sendToSession(
          activeTask.sessionId,
          instruction.trim(),
        );
        activeTask.lastInputSentAt = Date.now();
        activeTask.status = "active";
        await this.syncTaskContext(activeTask);
      }
      const nowIso = new Date().toISOString();
      await this.taskRegistry.updateThread(threadId, {
        status: "active",
        closedAt: null,
        lastCoordinatorTurnAt: nowIso,
        metadata: {
          controlState: null,
          resumedAt: nowIso,
        },
      });
      await this.taskRegistry.appendEvent({
        threadId,
        sessionId: activeTask.sessionId,
        eventType: "task_resumed",
        summary: "Continued the active task thread",
        data: {
          reusedSession: true,
          instruction: instruction ?? null,
        },
      });
      return {
        threadId,
        sessionId: activeTask.sessionId,
        reusedSession: true,
        framework: activeTask.agentType,
      };
    }

    const latestSession = (thread.sessions ?? [])
      .slice()
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];
    const workdir = latestSession?.workdir ?? thread.latestWorkdir;
    if (!workdir) {
      throw new Error(`Task thread ${threadId} has no resumable workspace`);
    }

    const requestedFramework = agentType
      ? normalizeAgentType(agentType)
      : latestSession?.framework
        ? normalizeAgentType(latestSession.framework)
        : normalizeAgentType(await this.ptyService.resolveAgentType());
    const frameworkState = await this.ptyService.getFrameworkState();
    const framework = frameworkState.frameworks.find(
      (entry) => entry.id === requestedFramework,
    );
    const resolvedFramework =
      framework?.installed &&
      framework.authReady &&
      !framework.temporarilyDisabled
        ? requestedFramework
        : normalizeAgentType(await this.ptyService.resolveAgentType());
    const resolvedAvailability = frameworkState.frameworks.find(
      (entry) => entry.id === resolvedFramework,
    );

    const session = await this.ptyService.spawnSession({
      name: `task-resume-${thread.id.slice(-8)}`,
      agentType: resolvedFramework,
      workdir,
      initialTask: this.formatResumePrompt(thread, instruction),
      credentials: buildAgentCredentials(this.runtime),
      approvalPreset: this.ptyService.defaultApprovalPreset,
      skipAdapterAutoResponse: true,
      metadata: {
        threadId,
        label: thread.title,
        requestedType: resolvedFramework,
        resumedFromThreadId: threadId,
        resumedFromSessionId: latestSession?.sessionId ?? null,
        resumeInstruction: instruction ?? null,
        resumedAt: Date.now(),
      },
    });

    await this.registerTask(session.id, {
      threadId,
      taskNodeId:
        typeof latestSession?.metadata.taskNodeId === "string"
          ? latestSession.metadata.taskNodeId
          : undefined,
      agentType: resolvedFramework,
      label: latestSession?.label ?? thread.title,
      originalTask: instruction?.trim() || thread.originalRequest,
      workdir,
      repo: latestSession?.repo ?? thread.latestRepo ?? undefined,
      providerSource: resolvedAvailability
        ? inferProviderSource(resolvedAvailability)
        : null,
      metadata:
        session.metadata &&
        typeof session.metadata === "object" &&
        !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>)
          : undefined,
    });

    const nowIso = new Date().toISOString();
    await this.taskRegistry.updateThread(threadId, {
      status: "active",
      closedAt: null,
      lastCoordinatorTurnAt: nowIso,
      metadata: {
        controlState: null,
        resumedAt: nowIso,
        lastResumedSessionId: session.id,
      },
    });
    await this.taskRegistry.appendEvent({
      threadId,
      sessionId: session.id,
      eventType: "task_resumed",
      summary: "Resumed the task thread on a new session",
      data: {
        reusedSession: false,
        fromSessionId: latestSession?.sessionId ?? null,
        toSessionId: session.id,
        instruction: instruction ?? null,
        framework: resolvedFramework,
      },
    });

    return {
      threadId,
      sessionId: session.id,
      reusedSession: false,
      framework: resolvedFramework,
    };
  }

  async continueTaskThread(
    threadId: string,
    instruction: string,
    agentType?: string,
  ): Promise<{
    threadId: string;
    sessionId: string;
    reusedSession: boolean;
    framework: CodingAgentType;
  }> {
    const latestLiveTask = this.getLiveTaskContextsForThread(threadId).find(
      (task) =>
        task.status === "active" ||
        task.status === "blocked" ||
        task.status === "tool_running",
    );
    if (latestLiveTask && this.ptyService) {
      await this.ptyService.sendToSession(
        latestLiveTask.sessionId,
        instruction,
      );
      latestLiveTask.lastInputSentAt = Date.now();
      latestLiveTask.status = "active";
      await this.syncTaskContext(latestLiveTask);
      const nowIso = new Date().toISOString();
      await this.taskRegistry.updateThread(threadId, {
        status: "active",
        closedAt: null,
        lastCoordinatorTurnAt: nowIso,
        metadata: {
          controlState: null,
          continuedAt: nowIso,
        },
      });
      await this.taskRegistry.appendEvent({
        threadId,
        sessionId: latestLiveTask.sessionId,
        eventType: "task_resumed",
        summary: "Sent follow-up instructions to the active task thread",
        data: {
          reusedSession: true,
          instruction,
        },
      });
      return {
        threadId,
        sessionId: latestLiveTask.sessionId,
        reusedSession: true,
        framework: latestLiveTask.agentType,
      };
    }
    return this.resumeTaskThread(threadId, instruction, agentType);
  }

  async syncTaskContext(taskCtx: TaskContext): Promise<void> {
    await this.taskRegistry.updateSession(taskCtx.sessionId, {
      status:
        taskCtx.status === "completed"
          ? "completed"
          : taskCtx.status === "error"
            ? "error"
            : taskCtx.status === "stopped"
              ? "stopped"
              : taskCtx.status === "blocked"
                ? "blocked"
                : taskCtx.status === "tool_running"
                  ? "tool_running"
                  : "active",
      decisionCount: taskCtx.decisions.length,
      autoResolvedCount: taskCtx.autoResolvedCount,
      lastActivityAt: taskCtx.lastActivityAt,
      idleCheckCount: taskCtx.idleCheckCount,
      taskDelivered: taskCtx.taskDelivered,
      completionSummary: taskCtx.completionSummary ?? null,
      lastSeenDecisionIndex: taskCtx.lastSeenDecisionIndex,
      lastInputSentAt: taskCtx.lastInputSentAt,
      stoppedAt: taskCtx.stoppedAt,
      metadata: {
        validationSummary: taskCtx.validationSummary ?? null,
      },
    });
    if (!taskCtx.taskNodeId) {
      return;
    }

    const nodeStatus = this.mapTaskContextStatusToNodeStatus(taskCtx.status);
    await this.taskRegistry.updateTaskNode(taskCtx.taskNodeId, {
      status: nodeStatus,
      title: taskCtx.label,
      instructions: taskCtx.originalTask,
      assignedSessionId: taskCtx.sessionId,
      assignedLabel: taskCtx.label,
      agentType: taskCtx.agentType,
      workdir: taskCtx.workdir,
      repo: taskCtx.repo ?? null,
      metadata: {
        completionSummary: taskCtx.completionSummary ?? null,
        validationSummary: taskCtx.validationSummary ?? null,
      },
    });

    const activeClaim = await this.taskRegistry.findActiveTaskClaim(
      taskCtx.taskNodeId,
      taskCtx.sessionId,
    );
    if (
      taskCtx.status === "completed" ||
      taskCtx.status === "error" ||
      taskCtx.status === "stopped"
    ) {
      if (activeClaim) {
        await this.taskRegistry.updateTaskClaim(activeClaim.id, {
          status:
            taskCtx.status === "completed"
              ? "completed"
              : taskCtx.status === "error"
                ? "failed"
                : "interrupted",
          releasedAt: new Date().toISOString(),
          metadata: {
            completionSummary: taskCtx.completionSummary ?? null,
            validationSummary: taskCtx.validationSummary ?? null,
          },
        });
      }
      return;
    }

    if (!activeClaim) {
      await this.taskRegistry.createTaskClaim({
        threadId: taskCtx.threadId,
        nodeId: taskCtx.taskNodeId,
        sessionId: taskCtx.sessionId,
        claimType: "execution",
        status: "active",
        metadata: {
          label: taskCtx.label,
        },
      });
    }
  }

  private isAutomaticFailoverFramework(
    agentType: CodingAgentType,
  ): agentType is SupportedTaskAgentAdapter {
    return (
      agentType === "claude" ||
      agentType === "codex" ||
      agentType === "gemini" ||
      agentType === "aider"
    );
  }

  private getFailoverCandidates(
    frameworks: TaskAgentFrameworkAvailability[],
    failedFramework: SupportedTaskAgentAdapter,
    preferredFrameworkId: TaskAgentFrameworkId,
  ): TaskAgentFrameworkAvailability[] {
    const preferred = frameworks.find(
      (framework) => framework.id === preferredFrameworkId,
    );
    const remainder = frameworks.filter(
      (framework) => framework.id !== preferredFrameworkId,
    );
    return [preferred, ...remainder].filter(
      (framework): framework is TaskAgentFrameworkAvailability =>
        Boolean(
          framework &&
            framework.id !== failedFramework &&
            framework.installed &&
            framework.authReady &&
            !framework.temporarilyDisabled,
        ),
    );
  }

  private getRecoveryCandidates(
    frameworks: TaskAgentFrameworkAvailability[],
    currentFramework: SupportedTaskAgentAdapter,
    preferredFrameworkId: TaskAgentFrameworkId,
    preferAlternative: boolean,
  ): TaskAgentFrameworkAvailability[] {
    const healthy = frameworks.filter(
      (framework) =>
        framework.installed &&
        framework.authReady &&
        !framework.temporarilyDisabled,
    );
    const byId = new Map(healthy.map((framework) => [framework.id, framework]));
    const orderedIds: TaskAgentFrameworkId[] = [];

    if (!preferAlternative) {
      orderedIds.push(currentFramework);
    }
    orderedIds.push(preferredFrameworkId);
    for (const framework of healthy) {
      orderedIds.push(framework.id);
    }

    const seen = new Set<TaskAgentFrameworkId>();
    const candidates: TaskAgentFrameworkAvailability[] = [];
    for (const id of orderedIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (preferAlternative && id === currentFramework) {
        continue;
      }
      const framework = byId.get(id);
      if (framework) {
        candidates.push(framework);
      }
    }
    return candidates;
  }

  private shouldPreferAlternativeFrameworkForError(reason: string): boolean {
    return ALTERNATE_FRAMEWORK_ERROR_RE.test(reason);
  }

  private formatFailoverPrompt(
    taskCtx: TaskContext,
    failedFramework: SupportedTaskAgentAdapter,
    reason: string,
    recentOutput: string,
  ): string {
    const cleanedOutput = cleanForFailoverContext(
      recentOutput,
      taskCtx.workdir,
    );
    const trimmedOutput = cleanedOutput.trim();
    const clippedOutput =
      trimmedOutput.length > FAILOVER_OUTPUT_MAX_CHARS
        ? trimmedOutput.slice(-FAILOVER_OUTPUT_MAX_CHARS)
        : trimmedOutput;
    const recentDecisions = taskCtx.decisions
      .slice(-5)
      .map(
        (decision, index) =>
          `${index + 1}. ${decision.event}: ${decision.reasoning}${decision.response ? ` (response: ${decision.response})` : ""}`,
      )
      .join("\n");
    return [
      `Continue an in-progress task after the previous ${failedFramework} session became unavailable because of a quota or credit failure.`,
      "",
      "Original task:",
      taskCtx.originalTask,
      "",
      `Failure reason: ${reason}`,
      `Workspace: ${taskCtx.workdir}`,
      "",
      recentDecisions
        ? `Recent coordinator decisions:\n${recentDecisions}\n`
        : "",
      clippedOutput
        ? `Recent terminal output from the failed session:\n${clippedOutput}\n`
        : "",
      "Use the existing workspace state instead of starting from scratch. Inspect the files, continue the task, run the needed validation, and then report what changed and how you verified it.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatErrorRecoveryPrompt(
    taskCtx: TaskContext,
    recoveryFramework: CodingAgentType,
    reason: string,
    recentOutput: string,
  ): string {
    const cleanedOutput = cleanForFailoverContext(
      recentOutput,
      taskCtx.workdir,
    );
    const trimmedOutput = cleanedOutput.trim();
    const clippedOutput =
      trimmedOutput.length > FAILOVER_OUTPUT_MAX_CHARS
        ? trimmedOutput.slice(-FAILOVER_OUTPUT_MAX_CHARS)
        : trimmedOutput;
    const recentDecisions = taskCtx.decisions
      .slice(-5)
      .map(
        (decision, index) =>
          `${index + 1}. ${decision.event}: ${decision.reasoning}${decision.response ? ` (response: ${decision.response})` : ""}`,
      )
      .join("\n");
    const recoveryMode =
      recoveryFramework === taskCtx.agentType
        ? `a fresh ${recoveryFramework} session`
        : `a ${recoveryFramework} recovery session`;
    return [
      `Continue an in-progress task after the previous session terminated unexpectedly. Eliza started ${recoveryMode} for recovery.`,
      "",
      "Original task:",
      taskCtx.originalTask,
      "",
      `Failure reason: ${reason}`,
      `Workspace: ${taskCtx.workdir}`,
      "",
      recentDecisions
        ? `Recent coordinator decisions:\n${recentDecisions}\n`
        : "",
      clippedOutput
        ? `Recent terminal output from the failed session:\n${clippedOutput}\n`
        : "",
      "Use the existing workspace state instead of starting over. Inspect the current files, recover from the failure, continue the task, run the needed validation, and then report exactly what changed and how you verified it.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async handleFrameworkDepletion(
    taskCtx: TaskContext,
    sessionId: string,
    reason: string,
  ): Promise<{
    replacementSessionId: string;
    replacementFramework: TaskAgentFrameworkId;
    replacementLabel: string;
  } | null> {
    if (
      !this.isAutomaticFailoverFramework(taskCtx.agentType) ||
      !isUsageExhaustedTaskAgentError(reason)
    ) {
      return null;
    }

    markTaskAgentFrameworkUnavailable(taskCtx.agentType, reason);
    await this.taskRegistry.appendEvent({
      threadId: taskCtx.threadId,
      sessionId,
      eventType: "framework_unavailable",
      summary: `${taskCtx.agentType} temporarily disabled after provider depletion`,
      data: {
        framework: taskCtx.agentType,
        reason,
      },
    });

    let failoverResult: {
      replacementSessionId: string;
      replacementFramework: TaskAgentFrameworkId;
      replacementLabel: string;
    } | null = null;
    try {
      failoverResult = await this.attemptTaskFailover(taskCtx, reason);
    } catch (failoverError) {
      this.log(
        `Automatic failover failed for "${taskCtx.label}": ${failoverError instanceof Error ? failoverError.message : String(failoverError)}`,
      );
    }

    if (failoverResult) {
      this.sendChatMessage(
        `"${taskCtx.label}" ran into a ${taskCtx.agentType} quota/credit failure. Eliza is continuing the same task on ${failoverResult.replacementFramework}.`,
        "coding-agent",
      );
    } else {
      this.sendChatMessage(
        `"${taskCtx.label}" ran into a ${taskCtx.agentType} quota/credit failure. Eliza will prefer another task-agent framework until ${taskCtx.agentType} is healthy again.`,
        "coding-agent",
      );
    }

    return failoverResult;
  }

  private async attemptTaskFailover(
    taskCtx: TaskContext,
    errorMsg: string,
  ): Promise<{
    replacementSessionId: string;
    replacementFramework: TaskAgentFrameworkId;
    replacementLabel: string;
  } | null> {
    if (
      !this.ptyService ||
      !this.isAutomaticFailoverFramework(taskCtx.agentType)
    ) {
      return null;
    }

    const frameworkState = await this.ptyService.getFrameworkState();
    const candidates = this.getFailoverCandidates(
      frameworkState.frameworks,
      taskCtx.agentType,
      frameworkState.preferred.id,
    );
    const nextFramework = candidates[0];
    if (!nextFramework) {
      return null;
    }

    const failedSession = this.ptyService.getSession(taskCtx.sessionId);
    const priorMetadata =
      failedSession?.metadata &&
      typeof failedSession.metadata === "object" &&
      !Array.isArray(failedSession.metadata)
        ? (failedSession.metadata as Record<string, unknown>)
        : {};
    const failoverOrdinal =
      typeof priorMetadata.failoverOrdinal === "number"
        ? priorMetadata.failoverOrdinal + 1
        : 1;
    const priorOutput = await Promise.race([
      this.ptyService.getSessionOutput(taskCtx.sessionId, 200),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 5_000)),
    ]);
    const replacementLabel = `${taskCtx.label} (${nextFramework.id} failover ${failoverOrdinal})`;
    const replacementSession = await this.ptyService.spawnSession({
      name:
        failedSession?.name ??
        `task-failover-${Date.now()}-${nextFramework.id}`,
      agentType: nextFramework.id as CodingAgentType,
      workdir: taskCtx.workdir,
      initialTask: this.formatFailoverPrompt(
        taskCtx,
        taskCtx.agentType,
        errorMsg,
        priorOutput,
      ),
      approvalPreset: this.ptyService.defaultApprovalPreset,
      skipAdapterAutoResponse: true,
      metadata: {
        ...priorMetadata,
        threadId: taskCtx.threadId,
        requestedType: nextFramework.id,
        label: replacementLabel,
        failoverOrdinal,
        failoverFromFramework: taskCtx.agentType,
        failoverFromSessionId: taskCtx.sessionId,
        failoverReason: errorMsg,
        failoverAt: Date.now(),
      },
    });

    await this.registerTask(replacementSession.id, {
      threadId: taskCtx.threadId,
      taskNodeId: taskCtx.taskNodeId,
      agentType: nextFramework.id as CodingAgentType,
      label: replacementLabel,
      originalTask: taskCtx.originalTask,
      workdir: taskCtx.workdir,
      repo: taskCtx.repo,
      providerSource: inferProviderSource(nextFramework),
      metadata:
        replacementSession.metadata &&
        typeof replacementSession.metadata === "object" &&
        !Array.isArray(replacementSession.metadata)
          ? (replacementSession.metadata as Record<string, unknown>)
          : undefined,
    });

    await this.taskRegistry.appendEvent({
      threadId: taskCtx.threadId,
      sessionId: replacementSession.id,
      eventType: "framework_failover_started",
      summary: `Continuing "${taskCtx.label}" on ${nextFramework.label}`,
      data: {
        fromFramework: taskCtx.agentType,
        fromSessionId: taskCtx.sessionId,
        toFramework: nextFramework.id,
        toSessionId: replacementSession.id,
        reason: errorMsg,
      },
    });

    return {
      replacementSessionId: replacementSession.id,
      replacementFramework: nextFramework.id,
      replacementLabel,
    };
  }

  private async attemptTaskRecovery(
    taskCtx: TaskContext,
    errorMsg: string,
  ): Promise<{
    replacementSessionId: string;
    replacementFramework: CodingAgentType;
    replacementLabel: string;
  } | null> {
    if (!this.ptyService) {
      return null;
    }

    const failedSession = this.ptyService.getSession(taskCtx.sessionId);
    const priorMetadata =
      failedSession?.metadata &&
      typeof failedSession.metadata === "object" &&
      !Array.isArray(failedSession.metadata)
        ? (failedSession.metadata as Record<string, unknown>)
        : {};
    const recoveryOrdinal =
      typeof priorMetadata.recoveryOrdinal === "number"
        ? priorMetadata.recoveryOrdinal + 1
        : 1;
    if (recoveryOrdinal > MAX_AUTOMATIC_ERROR_RECOVERIES) {
      return null;
    }

    let recoveryFramework: CodingAgentType = taskCtx.agentType;
    let recoveryAvailability: TaskAgentFrameworkAvailability | null = null;
    if (this.isAutomaticFailoverFramework(taskCtx.agentType)) {
      const frameworkState = await this.ptyService.getFrameworkState();
      const candidates = this.getRecoveryCandidates(
        frameworkState.frameworks,
        taskCtx.agentType,
        frameworkState.preferred.id,
        this.shouldPreferAlternativeFrameworkForError(errorMsg),
      );
      const selected = candidates[0];
      if (!selected) {
        return null;
      }
      recoveryFramework = selected.id as CodingAgentType;
      recoveryAvailability = selected;
    }

    const priorOutput = await Promise.race([
      this.ptyService.getSessionOutput(taskCtx.sessionId, 200),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 5_000)),
    ]);
    const replacementLabel = `${taskCtx.label} (${recoveryFramework} recovery ${recoveryOrdinal})`;
    const replacementSession = await this.ptyService.spawnSession({
      name:
        failedSession?.name ??
        `task-recovery-${Date.now()}-${recoveryFramework}`,
      agentType: recoveryFramework,
      workdir: taskCtx.workdir,
      initialTask: this.formatErrorRecoveryPrompt(
        taskCtx,
        recoveryFramework,
        errorMsg,
        priorOutput,
      ),
      credentials: buildAgentCredentials(this.runtime),
      approvalPreset: this.ptyService.defaultApprovalPreset,
      skipAdapterAutoResponse: true,
      metadata: {
        ...priorMetadata,
        threadId: taskCtx.threadId,
        requestedType: recoveryFramework,
        label: replacementLabel,
        recoveryOrdinal,
        recoveredFromFramework: taskCtx.agentType,
        recoveredFromSessionId: taskCtx.sessionId,
        recoveryReason: errorMsg,
        recoveryAt: Date.now(),
      },
    });

    await this.registerTask(replacementSession.id, {
      threadId: taskCtx.threadId,
      taskNodeId: taskCtx.taskNodeId,
      agentType: recoveryFramework,
      label: replacementLabel,
      originalTask: taskCtx.originalTask,
      workdir: taskCtx.workdir,
      repo: taskCtx.repo,
      providerSource: recoveryAvailability
        ? inferProviderSource(recoveryAvailability)
        : null,
      metadata:
        replacementSession.metadata &&
        typeof replacementSession.metadata === "object" &&
        !Array.isArray(replacementSession.metadata)
          ? (replacementSession.metadata as Record<string, unknown>)
          : undefined,
    });

    await this.taskRegistry.appendEvent({
      threadId: taskCtx.threadId,
      sessionId: replacementSession.id,
      eventType: "task_error_recovery_started",
      summary: `Continuing "${taskCtx.label}" after an agent error`,
      data: {
        fromFramework: taskCtx.agentType,
        fromSessionId: taskCtx.sessionId,
        toFramework: recoveryFramework,
        toSessionId: replacementSession.id,
        reason: errorMsg,
        recoveryOrdinal,
      },
    });

    this.broadcast({
      type: "task_recovery_started",
      sessionId: replacementSession.id,
      timestamp: Date.now(),
      data: {
        fromSessionId: taskCtx.sessionId,
        fromFramework: taskCtx.agentType,
        toFramework: recoveryFramework,
        reason: errorMsg,
      },
    });

    return {
      replacementSessionId: replacementSession.id,
      replacementFramework: recoveryFramework,
      replacementLabel,
    };
  }

  async resumeTaskAfterProviderAuth(
    sessionId: string,
    reason: string,
  ): Promise<{
    replacementSessionId: string;
    replacementFramework: CodingAgentType;
    replacementLabel: string;
  } | null> {
    const taskCtx = this.tasks.get(sessionId);
    if (!taskCtx) {
      return null;
    }
    if (
      taskCtx.status === "completed" ||
      taskCtx.status === "error" ||
      taskCtx.status === "stopped"
    ) {
      return null;
    }

    const replacement = await this.attemptTaskRecovery(taskCtx, reason);
    if (!replacement) {
      return null;
    }

    taskCtx.suppressStopNotice = true;
    taskCtx.status = "stopped";
    try {
      await this.ptyService?.stopSession(sessionId, true);
    } catch (error) {
      this.log(
        `Failed to stop superseded auth-blocked session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Successful auto-recovery is runtime-internal; synthesis reports
    // the final outcome. Chat only needs auth prompts the user has to
    // act on, not recovery commentary.
    return replacement;
  }

  async markTaskResumedAfterProviderAuth(sessionId: string): Promise<boolean> {
    const taskCtx = this.tasks.get(sessionId);
    if (!taskCtx) {
      return false;
    }
    if (
      taskCtx.status === "completed" ||
      taskCtx.status === "error" ||
      taskCtx.status === "stopped"
    ) {
      return false;
    }

    taskCtx.status = "active";
    taskCtx.stoppedAt = undefined;
    taskCtx.lastActivityAt = Date.now();
    taskCtx.idleCheckCount = 0;

    if (
      taskCtx.agentType === "claude" ||
      taskCtx.agentType === "codex" ||
      taskCtx.agentType === "gemini" ||
      taskCtx.agentType === "aider"
    ) {
      markTaskAgentFrameworkHealthy(taskCtx.agentType);
    }

    this.broadcast({
      type: "ready",
      sessionId,
      timestamp: Date.now(),
      data: {
        reason: "provider_auth_recovered",
        source: "auth_recovery",
      },
    });
    await this.taskRegistry.appendEvent({
      threadId: taskCtx.threadId,
      sessionId,
      eventType: "task_status_changed",
      summary: `Task "${taskCtx.label}" resumed after provider authentication`,
      data: {
        status: "active",
        reason: "provider_auth_recovered",
      },
    });
    // Token refresh is invisible plumbing, no chat message needed.
    return true;
  }

  async recordDecision(
    taskCtx: TaskContext,
    decision: CoordinationDecision,
  ): Promise<void> {
    taskCtx.decisions.push(decision);
    await this.taskRegistry.recordDecision({
      threadId: taskCtx.threadId,
      sessionId: taskCtx.sessionId,
      timestamp: decision.timestamp,
      event: decision.event,
      promptText: decision.promptText,
      decision: decision.decision,
      response: decision.response,
      reasoning: decision.reasoning,
    });
    await this.syncTaskContext(taskCtx);
  }

  async setTaskDelivered(sessionId: string): Promise<void> {
    const taskCtx = this.tasks.get(sessionId);
    if (!taskCtx) return;
    taskCtx.taskDelivered = true;
    await this.syncTaskContext(taskCtx);
  }

  // ─── Unregistered Buffer Retry ───

  /**
   * Schedule a retry check for buffered events from an unregistered session.
   * Uses exponential backoff: 2s → 4s → 8s → 16s, max 30s total.
   */
  private scheduleUnregisteredRetry(sessionId: string, attempt: number): void {
    const delay =
      UNREGISTERED_RETRY_DELAYS[
        Math.min(attempt, UNREGISTERED_RETRY_DELAYS.length - 1)
      ];

    const timer = setTimeout(() => {
      this.unregisteredRetryTimers.delete(sessionId);
      const stillBuffered = this.unregisteredBuffer.get(sessionId);
      if (!stillBuffered || stillBuffered.length === 0) return;

      const ctx = this.tasks.get(sessionId);
      if (ctx) {
        // Task was registered, flush
        this.unregisteredBuffer.delete(sessionId);
        for (const entry of stillBuffered) {
          this.handleNormalizedSessionEvent(entry.normalized).catch((err) => {
            this.log(
              `Failed to replay buffered event for ${sessionId}: ${err}`,
            );
          });
        }
        return;
      }

      // Check if we've exceeded the absolute max wait
      const oldest = stillBuffered[0].receivedAt;
      const totalElapsed = Date.now() - oldest;
      if (totalElapsed >= UNREGISTERED_MAX_TOTAL_MS) {
        this.unregisteredBuffer.delete(sessionId);
        this.log(
          `Discarding ${stillBuffered.length} buffered events for unregistered session ${sessionId} after ${Math.round(totalElapsed / 1000)}s`,
        );
        return;
      }

      // Schedule next retry
      this.log(
        `Retry ${attempt + 1} for unregistered session ${sessionId} (next in ${delay}ms)`,
      );
      this.scheduleUnregisteredRetry(sessionId, attempt + 1);
    }, delay);

    this.unregisteredRetryTimers.set(sessionId, timer);
  }

  // ─── SSE Client Management ───

  /**
   * Register an SSE client. Returns an unsubscribe function.
   * Sends a snapshot of current state on connect.
   */
  addSseClient(res: ServerResponse): () => void {
    this.sseClients.add(res);

    // Send snapshot on connect
    const snapshot: SwarmEvent = {
      type: "snapshot",
      sessionId: "*",
      timestamp: Date.now(),
      data: {
        tasks: this.getAllTaskContexts(),
        supervisionLevel: this.supervisionLevel,
        pendingCount: this.pendingDecisions.size,
      },
    };
    this.writeSseEvent(res, snapshot);

    // Remove on close
    const cleanup = () => {
      this.sseClients.delete(res);
    };
    res.on("close", cleanup);

    return cleanup;
  }

  broadcast(event: SwarmEvent): void {
    const dead: ServerResponse[] = [];
    for (const client of this.sseClients) {
      if (client.writableEnded) {
        dead.push(client);
        continue;
      }
      this.writeSseEvent(client, event);
    }
    // Cleanup dead connections
    for (const d of dead) {
      this.sseClients.delete(d);
    }
    // Relay to WebSocket clients, buffer if bridge isn't wired yet
    if (this.wsBroadcast) {
      this.wsBroadcast(event);
    } else if (this.preBridgeBroadcastBuffer.length < MAX_PRE_BRIDGE_BUFFER) {
      this.preBridgeBroadcastBuffer.push(event);
    }
    // In-process listeners. Each runs in its own try so one listener cannot
    // break delivery for the next.
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(
          `Swarm event listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** @see SwarmCoordinatorContext.subscribe */
  subscribe(listener: SwarmEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private writeSseEvent(res: ServerResponse, event: SwarmEvent): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Connection may have closed
    }
  }

  // ─── Event Handling ───

  async handleSessionEvent(
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const normalized = normalizeCoordinatorEvent(sessionId, event, data);
    if (!normalized) {
      this.broadcast({
        type: event,
        sessionId,
        timestamp: Date.now(),
        data,
      });
      return;
    }
    await this.handleNormalizedSessionEvent(normalized);
  }

  private async handleNormalizedSessionEvent(
    normalized: CoordinatorNormalizedEvent,
  ): Promise<void> {
    const sessionId = normalized.sessionId;
    const event = normalized.name;
    const data = normalized.rawData;
    // Lazy-wire scratch decision callback if not yet connected
    if (!this.scratchDecisionWired) {
      this.wireScratchDecisionCallback();
    }

    // Ignore events from sessions created before this coordinator started.
    // Session IDs are formatted as "pty-{timestamp}-{hex}" — extract the timestamp.
    // Some events may arrive without a sessionId (worker-level errors, etc.) — bail.
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const tsMatch = sessionId.match(/^pty-(\d+)-/);
    if (tsMatch) {
      const sessionCreatedAt = Number(tsMatch[1]);
      if (sessionCreatedAt < this.startedAt - 60_000) {
        // Session is from before this coordinator's lifetime (with 1min grace)
        return;
      }
    }

    const taskCtx = this.tasks.get(sessionId);

    // Buffer events for unregistered sessions with exponential backoff retry.
    // Events arriving before registerTask() are buffered and retried at
    // 2s → 4s → 8s → 16s intervals (max 30s total) before being discarded.
    if (!taskCtx) {
      if (
        event === "blocked" ||
        event === "task_complete" ||
        event === "error"
      ) {
        let buffer = this.unregisteredBuffer.get(sessionId);
        if (!buffer) {
          buffer = [];
          this.unregisteredBuffer.set(sessionId, buffer);
        }
        buffer.push({ normalized, receivedAt: Date.now() });

        // Only schedule retry if not already retrying for this session
        if (!this.unregisteredRetryTimers.has(sessionId)) {
          this.scheduleUnregisteredRetry(sessionId, 0);
        }
      }
      return;
    }

    // Skip decision-making events for terminal states, but always allow
    // "stopped" and "error" through: they're definitive lifecycle signals
    // that the frontend needs to close consoles and clean up.
    // Exception: allow a late "task_complete" to recover a recently-stopped task.
    let recoveredFromStopped = false;
    if (
      taskCtx.status === "stopped" ||
      taskCtx.status === "error" ||
      taskCtx.status === "completed"
    ) {
      if (taskCtx.status === "stopped" && event === "task_complete") {
        const stoppedAt = taskCtx.stoppedAt ?? 0;
        const ageMs = Date.now() - stoppedAt;
        if (stoppedAt > 0 && ageMs <= STOPPED_RECOVERY_WINDOW_MS) {
          this.log(
            `Recovering "${taskCtx.label}" from stopped on late task_complete (${Math.round(ageMs / 1000)}s old)`,
          );
          taskCtx.status = "active";
          taskCtx.stoppedAt = undefined;
          recoveredFromStopped = true;
        } else {
          this.log(
            `Ignoring "${event}" for ${taskCtx.label} (status: stopped, age=${Math.round(ageMs / 1000)}s)`,
          );
          return;
        }
      }
      if (!recoveredFromStopped && event !== "stopped" && event !== "error") {
        this.log(
          `Ignoring "${event}" for ${taskCtx.label} (status: ${taskCtx.status})`,
        );
        return;
      }
    }

    // Update activity timestamp: resets idle watchdog for this session.
    // This runs before buffering so buffered events still reset the idle timer.
    taskCtx.lastActivityAt = Date.now();
    taskCtx.idleCheckCount = 0;

    // Buffer decision-making events when paused (user sent a chat message).
    // Auto-responses still flow through handleBlocked. Only LLM decisions are deferred.
    if (this._paused && (event === "blocked" || event === "task_complete")) {
      // Auto-responded blocked events don't need LLM, let them through
      const blockedAutoResponded =
        event === "blocked" &&
        (normalized as CoordinatorBlockedEvent).autoResponded === true;
      if (!blockedAutoResponded) {
        // Broadcast buffered state for dashboard visibility
        this.broadcast({
          type:
            event === "blocked" ? "blocked_buffered" : "turn_complete_buffered",
          sessionId,
          timestamp: Date.now(),
          data,
        });
        this.pauseBuffer.push(normalized);
        this.log(
          `Buffered "${event}" for ${taskCtx.label} (coordinator paused)`,
        );
        return;
      }
      // Auto-responded: fall through to normal handling below
    }

    // Route by event type
    switch (event) {
      case "blocked": {
        const blockedEvent = normalized as CoordinatorBlockedEvent;
        const blockedPrompt = blockedEvent.promptText;
        if (
          this.isAutomaticFailoverFramework(taskCtx.agentType) &&
          isUsageExhaustedTaskAgentError(blockedPrompt)
        ) {
          const failoverResult = await this.handleFrameworkDepletion(
            taskCtx,
            sessionId,
            blockedPrompt,
          );
          taskCtx.status = "error";
          taskCtx.stoppedAt = Date.now();
          this.broadcast({
            type: "error",
            sessionId,
            timestamp: Date.now(),
            data: {
              message: blockedPrompt,
              source: "blocked_prompt",
            },
          });
          await this.taskRegistry.appendEvent({
            threadId: taskCtx.threadId,
            sessionId,
            eventType: "task_status_changed",
            summary: `Task "${taskCtx.label}" errored`,
            data: {
              status: "error",
              message: blockedPrompt,
              source: "blocked_prompt",
            },
          });
          this.ptyService?.stopSession(sessionId, true).catch((err) => {
            this.log(
              `Failed to stop exhausted session "${taskCtx.label}": ${err}`,
            );
          });
          if (!failoverResult) {
            checkAllTasksComplete(this);
          }
          break;
        }
        await handleBlocked(this, sessionId, taskCtx, data);
        break;
      }

      case "task_complete": {
        // Cancel the PTY auto-stop scheduled by pty-service.handleHookEvent
        // so the assessment LLM call (debounced + executed below) doesn't
        // race the 5s grace timer. Without this, the PTY is killed mid-
        // assessment and follow-up "respond" decisions hit a dead session.
        // executeDecision (case "complete") will explicitly stopSession with
        // force=true when the coordinator decides the agent is done.
        this.ptyService?.cancelTaskCompleteAutoStop?.(sessionId);

        // Broadcast immediately for UI visibility, but coalesce the
        // expensive LLM assessment: rapid turn-complete events within
        // 500ms are debounced so only the last one triggers an LLM call.
        this.broadcast({
          type: "turn_complete",
          sessionId,
          timestamp: Date.now(),
          data,
        });

        const existingCoalesce = this.turnCompleteCoalesceTimers.get(sessionId);
        if (existingCoalesce) clearTimeout(existingCoalesce);

        const coalescedData = data;
        const coalesceTimer = setTimeout(() => {
          this.turnCompleteCoalesceTimers.delete(sessionId);
          const currentTask = this.tasks.get(sessionId);
          if (
            currentTask?.completionSummary &&
            !this.ptyService?.getSession(sessionId)
          ) {
            currentTask.status = "completed";
            this.log(
              `Skipping coalesced turn-complete for "${currentTask.label}": PTY is gone after captured completion`,
            );
            void this.syncTaskContext(currentTask)
              .catch((err) => {
                this.log(
                  `Failed to sync completed task after coalesced turn-complete: ${err}`,
                );
              })
              .then(() => checkAllTasksComplete(this))
              .catch((err) => {
                this.log(
                  `Failed to finish swarm after coalesced completion: ${err}`,
                );
              });
            return;
          }
          // Accept both "active" and "tool_running" as live pre-validation
          // states. Subagents that use tools (curl, file ops, etc.) sit in
          // "tool_running" almost continuously, so by the time task_complete
          // arrives the status is usually "tool_running"; the prior strict
          // "=== active" check meant validation never ran for tool-heavy
          // scratch tasks, leaving them stuck and propagating goal failure
          // through the watchdog.
          if (
            currentTask &&
            (currentTask.status === "active" ||
              currentTask.status === "tool_running")
          ) {
            handleTurnComplete(
              this,
              sessionId,
              currentTask,
              coalescedData,
            ).catch((err) => {
              this.log(`Coalesced turn-complete failed: ${err}`);
            });
          }
        }, TURN_COMPLETE_COALESCE_MS);
        this.turnCompleteCoalesceTimers.set(sessionId, coalesceTimer);
        break;
      }

      case "error": {
        this.broadcast({
          type: "error",
          sessionId,
          timestamp: Date.now(),
          data,
        });

        // Send error message to chat UI
        const errorMsg =
          (data as { message?: string }).message ?? "unknown error";
        const failoverResult = await this.handleFrameworkDepletion(
          taskCtx,
          sessionId,
          errorMsg,
        );
        let recoveryResult: Awaited<
          ReturnType<typeof this.attemptTaskRecovery>
        > = null;
        if (!failoverResult) {
          try {
            recoveryResult = await this.attemptTaskRecovery(taskCtx, errorMsg);
          } catch (recoveryError) {
            this.log(
              `Automatic error recovery failed for "${taskCtx.label}": ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            );
          }
        }
        if (recoveryResult) {
          // Auto-recovery succeeded: stay quiet; synthesis will report.
        } else if (!failoverResult) {
          this.sendChatMessage(
            `"${taskCtx.label}" hit an error and needs your attention: ${errorMsg}`,
            "coding-agent",
          );
        }
        taskCtx.status = "error";
        await this.taskRegistry.appendEvent({
          threadId: taskCtx.threadId,
          sessionId,
          eventType: "task_status_changed",
          summary: `Task "${taskCtx.label}" errored`,
          data: { status: "error", message: errorMsg },
        });
        if (!failoverResult && !recoveryResult) {
          checkAllTasksComplete(this);
        }
        break;
      }

      case "stopped": {
        if (
          shouldIgnoreStoppedEventDuringCompletion({
            task: taskCtx,
            hasInFlightDecision: this.inFlightDecisions.has(sessionId),
            hasPendingTurnComplete: this.pendingTurnComplete.has(sessionId),
          })
        ) {
          this.log(
            `Ignoring stopped event for ${taskCtx.label}; completion is already being finalized`,
          );
          break;
        }
        // Don't downgrade "completed" or "error" to "stopped": the async
        // stopSession fires after executeDecision already marked the task.
        if (taskCtx.status !== "completed" && taskCtx.status !== "error") {
          taskCtx.status = "stopped";
          taskCtx.stoppedAt = Date.now();
        }
        this.inFlightDecisions.delete(sessionId);
        this.broadcast({
          type: "stopped",
          sessionId,
          timestamp: Date.now(),
          data,
        });
        await this.taskRegistry.appendEvent({
          threadId: taskCtx.threadId,
          sessionId,
          eventType: "task_status_changed",
          summary: `Task "${taskCtx.label}" stopped`,
          data: { status: taskCtx.status },
        });
        // "Stopped before completion" is redundant with the synthesis
        // path, which reports the actual state on terminal events.
        checkAllTasksComplete(this);
        break;
      }

      case "ready":
        taskCtx.status = "active";
        if (
          taskCtx.agentType === "claude" ||
          taskCtx.agentType === "codex" ||
          taskCtx.agentType === "gemini" ||
          taskCtx.agentType === "aider"
        ) {
          markTaskAgentFrameworkHealthy(taskCtx.agentType);
        }
        this.broadcast({
          type: "ready",
          sessionId,
          timestamp: Date.now(),
          data,
        });
        await this.taskRegistry.appendEvent({
          threadId: taskCtx.threadId,
          sessionId,
          eventType: "session_updated",
          summary: `Session "${taskCtx.label}" ready`,
          data: { status: "ready" },
        });
        break;

      case "login_required": {
        const loginEvent = normalized as CoordinatorLoginRequiredEvent;
        let recoveryResult:
          | (TaskAgentAuthLaunchResult & {
              recoveryStarted: boolean;
              status: "recovered" | "recovering" | "failed";
            })
          | null = null;
        try {
          if (
            this.ptyService &&
            (taskCtx.agentType === "claude" ||
              taskCtx.agentType === "codex" ||
              taskCtx.agentType === "gemini" ||
              taskCtx.agentType === "aider")
          ) {
            recoveryResult = await this.ptyService.startSessionAuthRecovery(
              sessionId,
              taskCtx.agentType,
              {
                instructions: loginEvent.instructions,
                url: loginEvent.url,
                deviceCode: loginEvent.deviceCode,
                method: loginEvent.method,
                promptSnippet: loginEvent.promptSnippet,
              },
            );
          }
        } catch (error) {
          this.log(
            `Provider auth recovery failed for "${taskCtx.label}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (recoveryResult?.status === "recovered") {
          if (recoveryResult.recoveryTarget === "replacement_session") {
            break;
          }
          await this.markTaskResumedAfterProviderAuth(sessionId);
          break;
        }

        taskCtx.status = "blocked";
        this.broadcast({
          type: "login_required",
          sessionId,
          timestamp: Date.now(),
          data,
        });
        await this.taskRegistry.appendEvent({
          threadId: taskCtx.threadId,
          sessionId,
          eventType: "task_status_changed",
          summary: `Task "${taskCtx.label}" is waiting for login`,
          data: {
            status: "blocked",
            reason: "login_required",
            instructions: loginEvent.instructions ?? null,
            url: loginEvent.url ?? null,
            deviceCode: loginEvent.deviceCode ?? null,
            method: loginEvent.method ?? null,
            recoveryStatus: recoveryResult?.status ?? null,
          },
        });
        const loginParts = [
          recoveryResult?.status === "recovering"
            ? `"${taskCtx.label}" needs provider authentication, and Eliza has started the recovery flow. It will continue automatically when sign-in completes.`
            : `"${taskCtx.label}" needs a provider login before it can continue.`,
          recoveryResult?.instructions?.trim() ||
            loginEvent.instructions?.trim() ||
            "",
          recoveryResult?.deviceCode || loginEvent.deviceCode
            ? `Device code: ${
                recoveryResult?.deviceCode ?? loginEvent.deviceCode
              }`
            : "",
          recoveryResult?.browserDetail || "",
          loginEvent.url ? `Login link: ${loginEvent.url}` : "",
          recoveryResult?.url && recoveryResult.url !== loginEvent.url
            ? `Login link: ${recoveryResult.url}`
            : "",
        ].filter(Boolean);
        this.sendChatMessage(loginParts.join(" "), "coding-agent");
        break;
      }

      case "tool_running": {
        // Agent is actively working via an external tool, keep watchdog happy
        taskCtx.status = "tool_running";
        taskCtx.lastActivityAt = Date.now();
        taskCtx.idleCheckCount = 0;

        this.broadcast({
          type: "tool_running",
          sessionId,
          timestamp: Date.now(),
          data,
        });

        // Hook-sourced tool_running events fire for every tool call.
        // Only broadcast to SSE (for activity box), skip chat messages.
        const toolData = data as {
          toolName?: string;
          description?: string;
          source?: string;
        };
        if (toolData.source === "hook") {
          break;
        }

        // Throttle chat notifications: at most one per 30s per session.
        // Suppress during the first 10s after registration: startup status
        // lines (e.g. "Claude in Chrome enabled") can trigger tool_running
        // before the agent has actually begun working.
        const now = Date.now();
        const STARTUP_GRACE_MS = 10_000;
        if (now - taskCtx.registeredAt < STARTUP_GRACE_MS) {
          break;
        }
        const lastNotif = this.lastToolNotification.get(sessionId) ?? 0;
        if (now - lastNotif > 30_000) {
          this.lastToolNotification.set(sessionId, now);
          const toolDesc =
            toolData.description ?? toolData.toolName ?? "an external tool";

          // Try to extract a dev server URL from recent output
          let urlSuffix = "";
          if (this.ptyService) {
            try {
              const recentOutput = await this.ptyService.getSessionOutput(
                sessionId,
                50,
              );
              const devUrl = extractDevServerUrl(recentOutput);
              if (devUrl) {
                urlSuffix = ` Dev server running at ${devUrl}`;
              }
            } catch {
              // Best-effort, don't block on failure
            }
          }

          const message = `[${taskCtx.label}] Running ${toolDesc}.${urlSuffix} The agent is working outside the terminal.`;
          this.log(message);
          // Tool-running progress is broadcast to the web UI above; chat
          // stays quiet (synthesis delivers the final result).
        }
        break;
      }

      default:
        // Broadcast unknown events for observability
        this.broadcast({
          type: event,
          sessionId,
          timestamp: Date.now(),
          data,
        });
    }
    await this.syncTaskContext(taskCtx);
  }

  // ─── LLM Decision (delegated) ───

  async makeCoordinationDecision(
    taskCtx: TaskContext,
    promptText: string,
    recentOutput: string,
  ): Promise<CoordinationLLMResponse | null> {
    // Keep this method on the coordinator while the implementation lives in
    // the decision-loop module.
    const { makeCoordinationDecision: mkDecision } = await import(
      "./swarm-decision-loop.js"
    );
    return mkDecision(this, taskCtx, promptText, recentOutput);
  }

  async executeDecision(
    sessionId: string,
    decision: CoordinationLLMResponse,
  ): Promise<void> {
    return execDecision(this, sessionId, decision);
  }

  /**
   * Public entry point for external callers (e.g. server.ts) to execute
   * a coordination decision on a session. Wraps the internal executeDecision.
   */
  async executeEventDecision(
    sessionId: string,
    decision: CoordinationLLMResponse,
  ): Promise<void> {
    return execDecision(this, sessionId, decision);
  }

  // ─── Supervision ───

  setSupervisionLevel(level: SupervisionLevel): void {
    this.supervisionLevel = level;
    this.broadcast({
      type: "supervision_changed",
      sessionId: "*",
      timestamp: Date.now(),
      data: { level },
    });
    this.log(`Supervision level set to: ${level}`);
  }

  getSupervisionLevel(): SupervisionLevel {
    return this.supervisionLevel;
  }

  // ─── Confirmation Queue ───

  getPendingConfirmations(): PendingDecision[] {
    return Array.from(this.pendingDecisions.values());
  }

  async confirmDecision(
    sessionId: string,
    approved: boolean,
    override?: { response?: string; useKeys?: boolean; keys?: string[] },
  ): Promise<void> {
    const pending = this.pendingDecisions.get(sessionId);
    if (!pending) {
      throw new Error(`No pending decision for session ${sessionId}`);
    }

    const taskCtx = this.tasks.get(sessionId);

    if (approved) {
      // Use override if provided, otherwise use LLM suggestion
      const decision: CoordinationLLMResponse = override
        ? {
            action: "respond",
            response: override.response,
            useKeys: override.useKeys,
            keys: override.keys,
            reasoning: "Human-approved (with override)",
          }
        : pending.llmDecision;

      if (taskCtx) {
        taskCtx.status = "active";
        taskCtx.autoResolvedCount = 0;
        await this.recordDecision(taskCtx, {
          timestamp: Date.now(),
          event: "blocked",
          promptText: pending.promptText,
          decision: decision.action,
          response:
            decision.action === "respond"
              ? decision.useKeys
                ? `keys:${decision.keys?.join(",")}`
                : decision.response
              : undefined,
          reasoning: `Human-approved: ${decision.reasoning}`,
        });
        await this.syncTaskContext(taskCtx);
      }

      await this.executeDecision(sessionId, decision);
      this.pendingDecisions.delete(sessionId);
      await this.taskRegistry.deletePendingDecision(sessionId);
      if (taskCtx) {
        await this.taskRegistry.appendEvent({
          threadId: taskCtx.threadId,
          sessionId,
          eventType: "confirmation_approved",
          summary: `Approved pending confirmation for "${taskCtx.label}"`,
          data: {
            action: decision.action,
            response: decision.response ?? null,
          },
        });
      }

      this.broadcast({
        type: "confirmation_approved",
        sessionId,
        timestamp: Date.now(),
        data: {
          action: decision.action,
          response: decision.response,
          useKeys: decision.useKeys,
          keys: decision.keys,
        },
      });
      if (taskCtx) {
        this.sendChatMessage(
          `"${taskCtx.label}" was approved. Eliza is continuing the task now.`,
          "coding-agent",
        );
      }
    } else {
      // Rejected: record and broadcast
      if (taskCtx) {
        taskCtx.status = "blocked";
        await this.recordDecision(taskCtx, {
          timestamp: Date.now(),
          event: "blocked",
          promptText: pending.promptText,
          decision: "escalate",
          reasoning: "Human rejected the suggested action",
        });
        await this.syncTaskContext(taskCtx);
      }
      this.pendingDecisions.delete(sessionId);
      await this.taskRegistry.deletePendingDecision(sessionId);
      if (pending.taskContext.threadId) {
        await this.taskRegistry.appendEvent({
          threadId: pending.taskContext.threadId,
          sessionId,
          eventType: "confirmation_rejected",
          summary: `Rejected pending confirmation for "${pending.taskContext.label}"`,
          data: { prompt: pending.promptText },
        });
      }

      this.broadcast({
        type: "confirmation_rejected",
        sessionId,
        timestamp: Date.now(),
        data: { prompt: pending.promptText },
      });
      this.sendChatMessage(
        `"${pending.taskContext.label}" remains blocked after the suggested action was rejected. Prompt: ${pending.promptText}`,
        "coding-agent",
      );
    }
  }

  // ─── Internal ───

  log(message: string): void {
    logger.info(`[SwarmCoordinator] ${message}`);
  }
}
