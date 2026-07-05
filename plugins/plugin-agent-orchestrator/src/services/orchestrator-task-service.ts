/**
 * Orchestrator task service.
 *
 * Bridges ephemeral ACP sub-agent sessions to the durable
 * {@link OrchestratorTaskStore} and owns the task lifecycle the
 * `/api/orchestrator/*` routes expose. Two responsibilities:
 *
 * 1. **Event bridge.** Subscribes to {@link AcpService} session events and
 *    records them against the owning task — status, tool activity, messages,
 *    token usage. A sub-agent's `task_complete` moves the task to `validating`,
 *    never straight to `done`; promotion to `done` requires an explicit
 *    {@link OrchestratorTaskService.validateTask} call.
 * 2. **Lifecycle API.** Create / list / inspect / update / pause / resume /
 *    archive / reopen / delete / fork tasks, spawn and steer sub-agents through
 *    the mandatory goal wrapper, and aggregate cross-task status.
 *
 * @module services/orchestrator-task-service
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  detectTaskType,
  generateDefaultAcceptanceCriteria,
  isNonTrivialGoal,
  type OrchestratorTaskType,
  shouldRequireGoalContract,
} from "./acceptance-criteria.js";
import { AcpService } from "./acp-service.js";
import { assignAgentName } from "./agent-name-assignment.js";
import {
  accountMetaFromSessionMetadata,
  assessCodingAccountReadiness,
  type CodingAccountReadiness,
  getCodingAccountBridge,
  resolveCodingAccountStrategy,
} from "./coding-account-selection.js";
import {
  envelopeCorrection,
  parseCompletionEnvelope,
  summarizeEnvelope,
} from "./completion-envelope.js";
import {
  buildCompletionEvidenceString,
  type CompletionEvidenceBundle,
  classifyToolOutput,
  type EvidenceArtifactRef,
  type EvidenceSignal,
  renderChangeSetBody,
} from "./completion-evidence.js";
import {
  buildAutoVerifyCorrection,
  LLM_GOAL_VERIFIER_NAME,
  MAX_AUTO_VERIFY_ATTEMPTS,
  shouldAutoVerifyGoal,
  verifyGoalCompletion,
} from "./goal-llm-verifier.js";
import {
  buildGoalFollowUp,
  buildGoalPrompt,
  coerceGoalCapabilityProfile,
  type GoalFollowUpReason,
} from "./goal-prompt.js";
import {
  type IndependentVerifierVerdict,
  runIndependentVerification,
  shouldRunIndependentVerify,
} from "./independent-verifier.js";
import {
  summarizeUsage,
  summarizeUsageRows,
  type TaskEventDto,
  type TaskMessageDto,
  type TaskPlanRevisionDto,
  type TaskThreadDetailDto,
  type TaskThreadDto,
  type TaskTimelineItemDto,
  toTaskEventDto,
  toTaskMessageDto,
  toTaskPlanRevisionDto,
  toTaskThread,
  toTaskThreadDetail,
  toTaskTimelineEventDto,
  toTaskTimelineMessageDto,
} from "./orchestrator-task-mapper.js";
import { OrchestratorTaskStore } from "./orchestrator-task-store.js";
import {
  type AttemptReflection,
  type CreateTaskInput,
  isLegalTaskStatusTransition,
  MAX_ATTEMPT_REFLECTIONS,
  type OrchestratorAccountAssignment,
  type OrchestratorAccountOverview,
  type OrchestratorRoomParticipant,
  type OrchestratorRoomRoster,
  type OrchestratorRoomRosterOverview,
  type OrchestratorTaskDocument,
  type OrchestratorTaskRecord,
  type OrchestratorTaskSession,
  type OrchestratorTaskStatus,
  type OrchestratorTaskUsage,
  type TaskListFilter,
  type TaskMessageDirection,
  type TaskMessageSenderKind,
  type TaskUsageSummary,
  TERMINAL_TASK_SESSION_STATUSES,
  TERMINAL_TASK_STATUSES,
  type UsageState,
} from "./orchestrator-task-types.js";
import { PARENT_AGENT_BROKER_MANIFEST_ENTRY } from "./parent-agent-broker.js";
import { buildSkillsManifest } from "./skill-manifest.js";
import {
  configureSpendLedger,
  createTaskStoreSpendLedger,
} from "./spend-allowance.js";
import type { ApprovalPreset } from "./types.js";
import {
  ensureTaskWorkdir,
  resolveAllowedWorkdir,
} from "./workdir-validation.js";
import { captureChangeSet, type WorkspaceChangeSet } from "./workspace-diff.js";

/**
 * Recoverable operator-recovery conflict.
 *
 * Thrown by the recovery methods (createPlanRevision / retry / rerun / restart)
 * when the requested recovery cannot proceed against the current task state
 * (missing plan revision, missing source message/event, no/terminal session,
 * unsupported destructive rerun). The orchestrator recovery routes map this
 * class to HTTP 409, so the status code is decoupled from the message wording —
 * callers must not regex-match the message to derive the status.
 */
export class RecoveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryConflictError";
  }
}

type RuntimeLike = IAgentRuntime & {
  logger?: Partial<
    Record<
      "debug" | "info" | "warn" | "error",
      (message: string, data?: unknown) => void
    >
  >;
  /** Modern eliza runtime property. */
  adapter?: unknown;
  /** Legacy alias for pre-2026 runtimes and some container harnesses. */
  databaseAdapter?: unknown;
  getSetting?: (key: string) => string | undefined | null;
};

/**
 * The deployment's configured default coding agent type, if any
 * (`ELIZA_ACP_DEFAULT_AGENT` or its alias `ELIZA_DEFAULT_AGENT_TYPE` — e.g.
 * "elizaos" for the eliza-code coding sub-agent). Returns a trimmed non-empty
 * string or undefined; `getSetting` may return non-string values, so coerce
 * defensively.
 */
function configuredDefaultAgentType(runtime: {
  getSetting?: (key: string) => unknown;
}): string | undefined {
  for (const key of ["ELIZA_ACP_DEFAULT_AGENT", "ELIZA_DEFAULT_AGENT_TYPE"]) {
    const raw = runtime.getSetting?.(key);
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  // Fall back to process.env. runtime.getSetting reads character
  // settings/secrets, not raw env, so a deployment that configures the default
  // agent purely via an env var (e.g. ELIZA_ACP_DEFAULT_AGENT=codex on a
  // container) would otherwise be ignored and the spawn would fall through to
  // the "opencode" fallback, which may not be installed. This mirrors the env
  // resolution the spawn-workdir path already does.
  for (const key of ["ELIZA_ACP_DEFAULT_AGENT", "ELIZA_DEFAULT_AGENT_TYPE"]) {
    const raw = process.env[key];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/** Provenance stamped on the `validateTask` verdict produced by the independent
 *  read-only execution verifier (#8898), distinct from the text judge's
 *  `llm-goal-verifier`, so the validation event's origin is unambiguous. */
const INDEPENDENT_ACP_VERIFIER_NAME = "independent-acp-verifier";

/** Default upper bound on how long the independent verifier session may run
 *  before its await is abandoned (treated as inconclusive). Overridable via
 *  `ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY_TIMEOUT_MS`. */
const DEFAULT_INDEPENDENT_VERIFY_TIMEOUT_MS = 600_000;

function independentVerifyTimeoutMs(runtime: {
  getSetting?: (key: string) => unknown;
}): number {
  const raw = runtime.getSetting?.(
    "ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY_TIMEOUT_MS",
  );
  const value =
    typeof raw === "string"
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_INDEPENDENT_VERIFY_TIMEOUT_MS;
}

export interface SpawnAgentForTaskOptions {
  framework?: string;
  providerSource?: string;
  model?: string;
  workdir?: string;
  repo?: string;
  label?: string;
  /** Concrete first instruction; defaults to the task goal. */
  task?: string;
  approvalPreset?: ApprovalPreset;
  /**
   * Recursion depth for nested spawns. 0 (default) = spawned by the main agent;
   * a sub-agent spawning its own child passes parentDepth + 1. Enforced against
   * the max-nesting-depth cap so self-spawning can't run away.
   */
  nestingDepth?: number;
}

/** Descriptor for an already-spawned ACP session that we want to bind to an
 *  existing task thread. Only what the attach path genuinely needs — identity,
 *  workdir + status from the spawn, and the caller's context that isn't
 *  discoverable from the SpawnResult (originalTask, model, providerSource,
 *  repo). See {@link OrchestratorTaskService.attachSession}. */
export interface AttachSessionInput {
  sessionId: string;
  agentType: string;
  workdir: string;
  status: string;
  metadata?: Record<string, unknown>;
  label?: string;
  originalTask?: string;
  model?: string;
  providerSource?: string;
  repo?: string;
  goalPrompt?: string;
}

export interface AddMessageInput {
  content: string;
  senderKind: TaskMessageSenderKind;
  sessionId?: string;
  direction?: TaskMessageDirection;
  metadata?: Record<string, unknown>;
}

export interface RetryTaskTurnInput {
  messageId?: string;
  sessionId?: string;
  instruction?: string;
  planRevisionId?: string;
  mode?: "same-session" | "new-session";
  agent?: SpawnAgentForTaskOptions;
}

export interface RerunFromEventInput {
  eventId: string;
  instruction?: string;
  planRevisionId?: string;
  stopActive?: boolean;
  /**
   * Rerun always preserves history; destructive rerun is intentionally
   * unsupported. `boolean` (not the literal `true`) is deliberate: JSON callers
   * can send `false`, and the boundary rejects it with a clear
   * RecoveryConflictError rather than silently ignoring the request.
   */
  preserveHistory?: boolean;
  agent?: SpawnAgentForTaskOptions;
}

export interface RestartTaskInput {
  instruction?: string;
  planRevisionId?: string;
  stopActive?: boolean;
  agent?: SpawnAgentForTaskOptions;
}

export interface CreatePlanRevisionInput {
  plan: Record<string, unknown>;
  basePlanRevisionId?: string;
  editSummary?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
  makeCurrent?: boolean;
}

export interface RestartWithEditedPlanInput extends RestartTaskInput {
  plan: Record<string, unknown>;
  basePlanRevisionId?: string;
  editSummary?: string;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OrchestratorStatus {
  taskCount: number;
  activeTaskCount: number;
  pausedTaskCount: number;
  blockedTaskCount: number;
  validatingTaskCount: number;
  sessionCount: number;
  activeSessionCount: number;
  usage: TaskUsageSummary;
  byStatus: Record<OrchestratorTaskStatus, number>;
}

const EMPTY_USAGE: TaskUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "unavailable",
  byProvider: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Coerce the persisted `metadata.attemptReflections` (free-form JSON) back into
 * typed {@link AttemptReflection}s, dropping any malformed entries. See #8899.
 */
function readAttemptReflections(
  metadata: Record<string, unknown> | undefined,
): AttemptReflection[] {
  const raw = metadata?.attemptReflections;
  if (!Array.isArray(raw)) return [];
  const out: AttemptReflection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.attempt !== "number" || typeof r.summary !== "string")
      continue;
    out.push({
      attempt: r.attempt,
      summary: r.summary,
      missing: Array.isArray(r.missing)
        ? r.missing.filter((m): m is string => typeof m === "string")
        : [],
    });
  }
  return out;
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Read a persisted {@link WorkspaceChangeSet} off arbitrary session metadata,
 * validating its shape the same way the CODING_SESSION_CHANGES provider does so
 * a malformed value never reaches the DTO. Returns undefined when absent or
 * malformed.
 */
function readLastChangeSet(
  metadata: Record<string, unknown> | undefined,
): WorkspaceChangeSet | undefined {
  const raw = metadata?.lastChangeSet;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<WorkspaceChangeSet>;
  if (!Array.isArray(candidate.changedFiles)) return undefined;
  if (typeof candidate.capturedAt !== "number") return undefined;
  return candidate as WorkspaceChangeSet;
}

/** Render an event's `data` payload to a bounded scannable string so the
 *  completion-evidence assembler can mine build/test lines out of it. */
function stringifyEventData(data: Record<string, unknown>): string {
  if (!data || Object.keys(data).length === 0) return "";
  try {
    return truncate(JSON.stringify(data), 1500);
  } catch {
    // error-policy:J3 arbitrary event data may be non-serializable (circular);
    // empty means "no minable text from this event", not a masked failure.
    return "";
  }
}

const EVIDENCE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

/** Collect distinct http(s) URLs from a set of text bodies, for the verified-
 *  URLs evidence section. Order-stable, deduped, trailing punctuation stripped. */
function collectUrls(texts: readonly string[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    EVIDENCE_URL_RE.lastIndex = 0;
    for (const match of text.matchAll(EVIDENCE_URL_RE)) {
      const url = match[0].replace(/[.,;:)\]]+$/, "");
      if (url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function findPlanRevision(
  doc: OrchestratorTaskDocument,
  planRevisionId?: string,
): OrchestratorTaskDocument["planRevisions"][number] | undefined {
  if (!planRevisionId) return undefined;
  return doc.planRevisions.find((revision) => revision.id === planRevisionId);
}

function latestActiveSession(
  doc: OrchestratorTaskDocument,
): OrchestratorTaskSession | undefined {
  return doc.sessions
    .filter((session) => !TERMINAL_TASK_SESSION_STATUSES.has(session.status))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

function eventExcerpt(
  event: OrchestratorTaskDocument["events"][number],
): string {
  const data =
    Object.keys(event.data).length > 0
      ? `\nData: ${truncate(JSON.stringify(event.data), 1200)}`
      : "";
  return `Event ${event.id} (${event.eventType}): ${event.summary}${data}`;
}

function retryInstruction(
  doc: OrchestratorTaskDocument,
  input: RetryTaskTurnInput,
): string {
  const source = input.messageId
    ? doc.messages.find((message) => message.id === input.messageId)
    : undefined;
  const lines = [
    input.instruction?.trim() || "Retry this turn and continue the task.",
  ];
  if (source) {
    lines.push(
      "",
      `Source message ${source.id} (${source.senderKind}/${source.direction}):`,
      truncate(source.content),
    );
  }
  return lines.join("\n");
}

function rerunInstruction(
  event: OrchestratorTaskDocument["events"][number],
  instruction?: string,
): string {
  return [
    instruction?.trim() || "Rerun from this event and continue the task.",
    "",
    eventExcerpt(event),
  ].join("\n");
}

function withPlanRevisionContext(
  instruction: string,
  revision?: OrchestratorTaskDocument["planRevisions"][number],
): string {
  if (!revision) return instruction;
  const lines = [
    instruction,
    "",
    "--- Plan Revision ---",
    `Revision: ${revision.id}`,
  ];
  if (revision.editSummary) lines.push(`Summary: ${revision.editSummary}`);
  lines.push(`Plan: ${truncate(JSON.stringify(revision.plan), 2000)}`);
  return lines.join("\n");
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    ),
  ) as Partial<T>;
}

interface ParsedUsage {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsd?: number;
  state: UsageState;
  sourceEventId?: string;
}

function parseUsage(data: unknown): ParsedUsage | null {
  if (!isRecord(data)) return null;
  const inputTokens = num(data.inputTokens);
  const outputTokens = num(data.outputTokens);
  const reasoningTokens = num(data.reasoningTokens);
  const cacheTokens = num(data.cacheTokens);
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0 &&
    cacheTokens === 0 &&
    data.costUsd === undefined
  ) {
    return null;
  }
  const stateRaw = str(data.state);
  // Unknown/absent precision → "estimated" (the conservative label), not
  // "measured": the UsageState union exists so an operator is never misled by a
  // confident-looking number, so we must not stamp provider-inferred tokens as
  // ground-truth measured just because the producer omitted `state`.
  const state: UsageState =
    stateRaw === "measured" || stateRaw === "estimated"
      ? stateRaw
      : "estimated";
  return {
    provider: str(data.provider) ?? "unknown",
    model: str(data.model),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheTokens,
    costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined,
    state,
    sourceEventId: str(data.sourceEventId),
  };
}

function describeEvent(event: string, data: unknown): string {
  const record = isRecord(data) ? data : {};
  switch (event) {
    case "ready":
      return "Sub-agent ready";
    case "tool_running": {
      const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
      const title = str(toolCall.title) ?? str(toolCall.kind) ?? "tool";
      return `Running ${title}`;
    }
    case "message":
      return truncate(str(record.text) ?? "Sub-agent message", 160);
    case "reasoning":
      return truncate(str(record.text) ?? "Sub-agent reasoning", 160);
    case "plan": {
      const count = Array.isArray(record.entries) ? record.entries.length : 0;
      return `Updated plan — ${count} item${count === 1 ? "" : "s"}`;
    }
    case "blocked":
      return truncate(str(record.message) ?? "Blocked on input", 160);
    case "login_required":
      return "Sub-agent requires authentication";
    case "task_complete":
      return "Sub-agent reported completion (pending validation)";
    case "error":
      return truncate(str(record.message) ?? "Sub-agent error", 160);
    case "stopped":
      return "Sub-agent stopped";
    case "reconnected":
      return "Sub-agent reconnected";
    case "usage_update":
      return "Token usage update";
    case "account_switched":
      return `Switched coding account to ${
        str(record.label) ?? str(record.accountId) ?? "unknown"
      }`;
    default:
      return event;
  }
}

/** Labels of sessions still live on a task — the names a newly spawned sibling
 * must not collide with. Terminal sessions free their name for reuse. */
function activeSessionNames(
  sessions: readonly OrchestratorTaskSession[],
): string[] {
  return sessions
    .filter((session) => !TERMINAL_TASK_SESSION_STATUSES.has(session.status))
    .map((session) => session.label)
    .filter((label): label is string => label.length > 0);
}

export class OrchestratorTaskService extends Service {
  static serviceType = "ORCHESTRATOR_TASK_SERVICE";

  capabilityDescription =
    "Durable orchestrator task layer: persists tasks, bridges ACP sub-agent sessions, enforces goal-wrapped prompts, and gates completion on validation";

  protected override readonly runtime: RuntimeLike;
  private readonly store: OrchestratorTaskStore;
  private readonly sessionTaskIndex = new Map<string, string>();
  // Session ids whose event-recording has already logged a failure. A
  // degraded store (e.g. #11641's pglite lookup) would otherwise re-warn on
  // EVERY session event (`ready`, `tool_running`, ...) forever — one line per
  // event, per session. We warn once per session and stay silent after.
  private readonly recordFailureWarned = new Set<string>();
  // Tasks with an auto-goal-verify pass in flight. ACP can emit `task_complete`
  // from two sites for one turn; without this guard both runs read the same
  // attempt counter across the model `await` and double-send a correction.
  private readonly autoVerifyInFlight = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private started = false;

  constructor(
    runtime: IAgentRuntime,
    opts: { store?: OrchestratorTaskStore } = {},
  ) {
    super(runtime);
    this.runtime = runtime as RuntimeLike;
    this.store =
      opts.store ??
      new OrchestratorTaskStore({
        runtime: {
          // Feed both names. The store prefers `adapter` and falls back to
          // `databaseAdapter`. This keeps ancient hand-rolled runtimes working
          // while wiring modern eliza runtimes to the SQL backend for real.
          adapter: this.runtime.adapter,
          databaseAdapter: this.runtime.databaseAdapter,
          logger: this.runtime.logger,
          getSetting: (key) => {
            const value = this.runtime.getSetting?.(key);
            return typeof value === "string" ? value : undefined;
          },
        },
      });
  }

  static async start(runtime: IAgentRuntime): Promise<OrchestratorTaskService> {
    const service = new OrchestratorTaskService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Persist self-spend durably so a configured ELIZA_AGENT_SPEND_CAP_USD
    // survives a restart instead of resetting to zero (#8924).
    configureSpendLedger(createTaskStoreSpendLedger(this.store));
    const acp = this.acp();
    if (acp) {
      this.subscribeToAcp(acp);
      return;
    }
    // ACP may not be registered yet — service start order during boot isn't
    // guaranteed. Wait for it to load so session events are still recorded once
    // it comes online, instead of giving up after the first miss.
    void this.bindToAcpWhenReady();
  }

  private subscribeToAcp(acp: AcpService): void {
    this.unsubscribe = acp.onSessionEvent((sessionId, event, data) => {
      void this.onSessionEvent(sessionId, event, data);
    });
  }

  private async bindToAcpWhenReady(): Promise<void> {
    const getLoadPromise = this.runtime.getServiceLoadPromise;
    if (typeof getLoadPromise !== "function") {
      this.log(
        "warn",
        "ACP service unavailable at start; session events will not be recorded",
      );
      return;
    }
    try {
      const acp = (await getLoadPromise.call(
        this.runtime,
        AcpService.serviceType,
      )) as AcpService;
      if (this.started && !this.unsubscribe) {
        this.subscribeToAcp(acp);
      }
    } catch (error) {
      // error-policy:J7 background ACP bind; the failure is warned and observable
      // and must not crash service start.
      this.log(
        "warn",
        "ACP service did not become available; session events will not be recorded",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
  }

  // ---- live change bus ---------------------------------------------------
  // A lightweight per-task pub/sub so the SSE stream route can push the
  // workbench a "something changed" ping the instant a message/event/usage/
  // status is written — replacing poll latency with near-live updates. The
  // payload is intentionally coarse (just a ping); the client refetches the
  // room tail, which keeps this decoupled from the record shapes.
  private readonly changeListeners = new Map<string, Set<() => void>>();

  /** Subscribe to change pings for a task. Returns an unsubscribe function. */
  subscribeTaskChanges(taskId: string, listener: () => void): () => void {
    let listeners = this.changeListeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.changeListeners.set(taskId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.changeListeners.get(taskId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.changeListeners.delete(taskId);
    };
  }

  private emitChange(taskId: string): void {
    const listeners = this.changeListeners.get(taskId);
    if (!listeners) return;
    for (const listener of listeners) {
      // A broken subscriber must never break a write path.
      try {
        listener();
      } catch {
        // error-policy:J7 change-ping fan-out; a broken SSE subscriber must not
        // abort the write that emitted the ping or the other subscribers.
      }
    }
  }

  // ---- event bridge ------------------------------------------------------

  private async onSessionEvent(
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    try {
      const taskId = await this.resolveTaskId(sessionId);
      if (!taskId) return;
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        sessionId,
        eventType: event,
        summary: describeEvent(event, data),
        data: isRecord(data) ? data : { value: data },
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      await this.applySessionEvent(taskId, sessionId, event, data);
      this.emitChange(taskId);
    } catch (err) {
      // Warn once per session, not once per event. A persistently degraded
      // store would fire this on every `ready`/`tool_running`/... otherwise,
      // flooding the log for the life of the session (#11641).
      if (!this.recordFailureWarned.has(sessionId)) {
        this.recordFailureWarned.add(sessionId);
        this.log("warn", "failed to record session event", {
          sessionId,
          event,
          error: err instanceof Error ? err.message : String(err),
          note: "further event-record failures for this session are suppressed",
        });
      }
    }
  }

  private async applySessionEvent(
    taskId: string,
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const record = isRecord(data) ? data : {};
    switch (event) {
      case "ready":
      case "reconnected":
        await this.store.updateSession(sessionId, { status: "ready" });
        await this.advanceTaskStatus(taskId, "active");
        break;
      case "tool_running": {
        const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
        await this.store.updateSession(sessionId, {
          status: "tool_running",
          activeTool: str(toolCall.title) ?? str(toolCall.kind),
        });
        await this.advanceTaskStatus(taskId, "active");
        break;
      }
      case "message": {
        const text = str(record.text);
        if (text) {
          await this.recordMessage(taskId, {
            content: text,
            senderKind: "sub_agent",
            sessionId,
            direction: "stdout",
          });
        }
        break;
      }
      case "reasoning": {
        // Reasoning text rides the event stream (event.data.text), which the
        // mapper forwards verbatim onto the task event record for the UI's
        // ReasoningCell. It is intentionally NOT recorded as a message: the
        // message DTO's `direction` is a closed union and reasoning is not part
        // of the deliverable transcript. addEvent (in onSessionEvent) already
        // persisted it; nothing further to apply to session/task state.
        break;
      }
      case "plan": {
        // The sub-agent's checklist/plan snapshot (already sanitized in AcpService)
        // becomes the task's durable currentPlan, which drives the plan/checklist
        // dock. addEvent (in onSessionEvent) persisted the event; here we update
        // the task so the latest plan is available without replaying events.
        const entries = Array.isArray(record.entries) ? record.entries : [];
        await this.store.updateTask(taskId, { currentPlan: { entries } });
        break;
      }
      case "blocked":
        await this.store.updateSession(sessionId, { status: "blocked" });
        await this.advanceTaskStatus(taskId, "blocked");
        break;
      case "login_required":
        await this.store.updateSession(sessionId, { status: "blocked" });
        await this.advanceTaskStatus(taskId, "waiting_on_user");
        await this.markSessionAccountUnhealthy(
          sessionId,
          "auth",
          "login_required",
        );
        break;
      case "task_complete": {
        const summary = str(record.response);
        await this.store.updateSession(sessionId, {
          status: "completed",
          taskDelivered: true,
          completionSummary: summary ? truncate(summary) : undefined,
          stoppedAt: Date.now(),
        });
        await this.mirrorChangeSetToStore(sessionId);
        await this.advanceTaskStatus(taskId, "validating");
        // Issue #8124: the orchestrator should always behave like `/goal` —
        // confirm the sub-agent met every acceptance criterion before marking
        // the task done. Feed the verifier REAL completion evidence (git
        // changeset + deliverable + final reply + verified URLs + test/build
        // markers + artifact refs) assembled from data we already have, not the
        // bare event summary. Fire-and-forget so the event-bridge write path
        // stays fast; the verifier gates itself on the flag + criteria presence,
        // and evidence assembly never throws into this path.
        const completionEvidence = await this.buildCompletionEvidence(
          taskId,
          sessionId,
          summary ?? "",
        );
        // Thread the RAW final message (record.response) through alongside the
        // reworded evidence bundle: the #8895 CompletionEnvelope lives verbatim in
        // the sub-agent's last message, not in the prose evidence, so the structural
        // parser must see the original text.
        void this.autoVerifyCompletion(
          taskId,
          sessionId,
          completionEvidence,
          summary ?? "",
        );
        break;
      }
      case "error": {
        await this.store.updateSession(sessionId, {
          status: "errored",
          stoppedAt: Date.now(),
        });
        const failureKind = str(record.failureKind);
        const message = str(record.message) ?? "";
        if (
          failureKind === "auth" ||
          /401|403|invalid api key|unauthor/i.test(message)
        ) {
          await this.markSessionAccountUnhealthy(sessionId, "auth", message);
        } else if (/429|rate.?limit|quota/i.test(message)) {
          // A 529 "overloaded" is a server-wide transient condition, not an
          // account quota — deliberately excluded so a healthy account isn't
          // sidelined from rotation for ~5min over a server blip.
          await this.markSessionAccountUnhealthy(
            sessionId,
            "rate-limit",
            message,
          );
        }
        // A `session_state_lost` failure is resumable: the sub-agent router
        // (respawnStateLost) deterministically re-spawns the child under a
        // bounded cap, so the durable task must stay non-terminal for that
        // recovery to land. Every other session error — non-zero exit, crash,
        // unrecoverable auth/quota — has no respawn producer, so drive the task
        // to the terminal `failed` status here. Without this the task is
        // stranded in active/validating forever, waiting on the 3-minute stall
        // watchdog or a human (#13771). `advanceTaskStatus` gates this through
        // the legal-transition table, so a paused/terminal task is left alone.
        if (failureKind !== "session_state_lost") {
          await this.advanceTaskStatus(taskId, "failed");
        }
        break;
      }
      case "stopped":
        await this.store.updateSession(sessionId, {
          status: "stopped",
          stoppedAt: Date.now(),
        });
        break;
      case "usage_update": {
        const usage = parseUsage(data);
        if (usage) await this.recordUsage(taskId, sessionId, usage);
        break;
      }
      case "account_switched": {
        // A follow-up prompt failed over to a different pooled account (the
        // spawn-time account went unhealthy). Re-key the durable session
        // record so recordUsage bills the account actually serving and the
        // rate-limit/reauth marks land on it — not the spawn-time account.
        const providerId = str(record.providerId);
        const accountId = str(record.accountId);
        if (providerId && accountId) {
          await this.store.updateSession(sessionId, {
            accountProviderId: providerId,
            accountId,
            accountLabel: str(record.label) ?? accountId,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Mirror the real git change set a sub-agent produced into the durable task
   * store session record's metadata, so the existing `/api/orchestrator/tasks/:id`
   * detail route serves it (`TaskSessionDto.metadata.lastChangeSet`) and the
   * task view can render a read-only diff without a new endpoint.
   *
   * Source of truth is the change set the router captured onto the LIVE ACP
   * session metadata at `task_complete`. Because the router's capture and this
   * event-bridge handler run on the same ACP event with no guaranteed ordering,
   * fall back to capturing it here from the same session-scoped signals (spawn
   * baseline + agent-written tool paths) when the ACP write hasn't landed yet.
   *
   * Additive and null-safe: when there is no change set (unchanged completion,
   * non-git workdir), nothing is written and the DTO simply omits it.
   */
  private async mirrorChangeSetToStore(sessionId: string): Promise<void> {
    try {
      const acp = this.acp();
      if (!acp) return;
      const session = await acp.getSession(sessionId);
      if (!session) return;

      let changeSet = readLastChangeSet(session.metadata);
      if (!changeSet) {
        const meta = session.metadata as Record<string, unknown> | undefined;
        const baseline = str(meta?.codingBaselineSha);
        const baselineDirty = Array.isArray(meta?.codingBaselineDirty)
          ? (meta.codingBaselineDirty as unknown[]).map(String)
          : [];
        changeSet = await captureChangeSet(
          session.workdir,
          baseline,
          acp.getChangedPaths(sessionId),
          baselineDirty,
        );
      }
      if (!changeSet) return;

      const found = await this.store.findSession(sessionId);
      if (!found) return;
      await this.store.updateSession(sessionId, {
        metadata: {
          ...(found.session.metadata ?? {}),
          lastChangeSet: changeSet,
        },
      });
    } catch (err) {
      // error-policy:J7 best-effort mirror on the task_complete path; debug-logged
      // and must not break the event-bridge write. The DTO simply omits the diff.
      this.log("debug", "mirror change-set to store failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Assemble the rich, sectioned completion-evidence string the auto
   * goal-verifier grills against, from data the orchestrator already has —
   * instead of feeding it only the thin `task_complete` event summary.
   *
   * Sections (each omitted when absent):
   *  - **CHANGESET** — the real git diff captured at completion (the same
   *    {@link WorkspaceChangeSet} the CODING_SESSION_CHANGES provider renders),
   *    read from the live ACP session or, failing that, the mirrored store
   *    session metadata;
   *  - **DELIVERABLE / FINAL REPLY** — the sub-agent's completion summary
   *    (its reported result) and any longer captured `sub_agent` reply recorded
   *    in the task room;
   *  - **VERIFIED URLS** — reachable URLs mined from the completion summary and
   *    recorded sub-agent messages (loopback-flagged so the verifier can reject
   *    localhost-only "deploys");
   *  - **TEST / BUILD / TYPECHECK OUTPUT** — lines that look like build/test
   *    output, mined from the durable event/message log of this session;
   *  - **ARTIFACTS** — screenshot/trajectory artifact references on the task or
   *    its session metadata.
   *
   * Fire-and-forget safety: this runs on the `task_complete` event-write path,
   * so it must NEVER throw. Any failure falls back to the bare summary, which is
   * exactly the prior behavior.
   */
  private async buildCompletionEvidence(
    taskId: string,
    sessionId: string,
    fallbackSummary: string,
  ): Promise<string> {
    try {
      const bundle = await this.collectEvidenceBundle(
        taskId,
        sessionId,
        fallbackSummary,
      );
      // Stamp the deterministic trajectory path onto the bundle so the verifier
      // evidence (and the serialized string) cite the durable artifact, then
      // serialize immediately and fire the actual JSONL write off the critical
      // path. The write is fire-and-forget (`void`) so trajectory IO never
      // delays the verifier or the event-bridge write path, and any IO failure
      // is swallowed inside the writer — the path is valid regardless of when
      // the file lands.
      bundle.trajectoryPath = await this.resolveTrajectoryPath(
        taskId,
        sessionId,
      );
      void this.writeEvidenceTrajectory(taskId, sessionId, bundle);
      return buildCompletionEvidenceString(bundle);
    } catch (err) {
      // error-policy:J7 fire-and-forget on the task_complete path; on failure it
      // degrades to the bare summary (the prior behavior), never throws.
      this.log("debug", "build completion evidence failed", {
        taskId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fallbackSummary;
    }
  }

  /**
   * Assemble the TYPED {@link CompletionEvidenceBundle} from data the
   * orchestrator already has (issue #8894). Each field resolves from a named
   * source:
   *  - `summary` — the `task_complete` response (fallback);
   *  - `diffSummary` — the real git change set captured at completion, via the
   *    same {@link readLastChangeSet} mechanism the CODING_SESSION_CHANGES path
   *    and `mirrorChangeSetToStore` use, rendered with {@link renderChangeSetBody};
   *  - `toolOutput` — test/build/lint stdout mined from recorded `tool_running`
   *    events (and sub-agent messages) and classified by {@link classifyToolOutput};
   *  - `verifiedUrls` — ONLY URLs the router actually probed at completion
   *    (session/task `subAgentVerifiedUrls` metadata); URLs merely mentioned in
   *    the summary / sub-agent replies go to `mentionedUrls`, rendered as an
   *    explicitly-unverified claim so a written "deployed to https://…" cannot
   *    masquerade as a probe-verified deploy;
   *  - `screenshots` — screenshot artifact paths on the task/session.
   *
   * Pure with respect to throwing: returns at least the summary on any error.
   */
  private async collectEvidenceBundle(
    taskId: string,
    sessionId: string,
    fallbackSummary: string,
  ): Promise<CompletionEvidenceBundle> {
    const summary = fallbackSummary.trim();
    const empty: CompletionEvidenceBundle = {
      summary,
      verifiedUrls: [],
      screenshots: [],
    };
    const doc = await this.store.getTask(taskId);
    if (!doc) return empty;

    // Scope to this session's rows, but keep cross-session task events too
    // (validation/build steps are sometimes recorded without a sessionId).
    const sessionEvents = doc.events.filter(
      (event) => event.sessionId === sessionId || event.sessionId === undefined,
    );
    const sessionMessages = doc.messages.filter(
      (message) => message.sessionId === sessionId,
    );

    const changeSet = await this.resolveCompletionChangeSet(sessionId, doc);
    const diffSummary =
      changeSet && changeSet.changedFiles.length > 0
        ? renderChangeSetBody(changeSet)
        : undefined;

    const subAgentReplies = sessionMessages
      .filter(
        (message) =>
          message.senderKind === "sub_agent" && message.direction === "stdout",
      )
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0);

    // Tool-output signals: prefer the structured `toolCall.output` recorded on
    // `tool_running`/`tool_result` events, labelled by the tool command/title so
    // the classifier can route the stdout to its test/build/lint bucket. Fall
    // back to the full event/message bodies so a real run still surfaces even
    // when the adapter folded its output into the assistant text.
    const toolSignals: EvidenceSignal[] = [
      ...this.extractToolSignals(sessionEvents),
      ...sessionEvents.map((event) => ({
        text: `${event.summary}\n${stringifyEventData(event.data)}`,
        source: event.eventType,
      })),
      ...sessionMessages.map((message) => ({
        text: message.content,
        source: message.senderKind,
      })),
    ];
    const toolOutput = classifyToolOutput(toolSignals);

    // ONLY router-probed URLs are "verified". URLs merely mined from the
    // sub-agent's prose are claims, not proof, and must not be labelled verified
    // to the judge (a sub-agent could otherwise pass by writing "deployed to
    // https://…"). They are surfaced separately as `mentionedUrls`.
    const verifiedUrls = [
      ...new Set(this.metadataVerifiedUrls(doc, sessionId)),
    ];
    const verifiedSet = new Set(verifiedUrls);
    const mentionedUrls = [
      ...new Set(
        collectUrls([summary, ...subAgentReplies]).filter(
          (url) => !verifiedSet.has(url),
        ),
      ),
    ];

    const screenshots = this.collectArtifactRefs(doc, sessionId).flatMap(
      (ref) => (ref.artifactType === "screenshot" && ref.ref ? [ref.ref] : []),
    );

    return {
      summary,
      diffSummary,
      toolOutput,
      verifiedUrls,
      mentionedUrls,
      screenshots: [...new Set(screenshots)],
    };
  }

  /** Build per-tool evidence signals from recorded `tool_running`/`tool_result`
   *  events: the signal text is the tool's captured stdout, and the source label
   *  carries the command/title so {@link classifyToolOutput} can class it. */
  private extractToolSignals(
    events: OrchestratorTaskDocument["events"],
  ): EvidenceSignal[] {
    const signals: EvidenceSignal[] = [];
    for (const event of events) {
      if (
        event.eventType !== "tool_running" &&
        event.eventType !== "tool_result"
      )
        continue;
      const toolCall = isRecord(event.data.toolCall)
        ? event.data.toolCall
        : event.data;
      const output = str(toolCall.output) ?? str(event.data.output);
      if (!output) continue;
      const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
      const command =
        str(rawInput.command) ??
        str(toolCall.title) ??
        str(toolCall.kind) ??
        "tool";
      signals.push({ text: output, source: command });
    }
    return signals;
  }

  /** URLs the router stamped as verified onto the task or session metadata
   *  (`subAgentVerifiedUrls`), separate from URLs mined out of free text. */
  private metadataVerifiedUrls(
    doc: OrchestratorTaskDocument,
    sessionId: string,
  ): string[] {
    const out: string[] = [];
    const session = doc.sessions.find((row) => row.sessionId === sessionId);
    for (const meta of [doc.task.metadata, session?.metadata]) {
      const raw = meta?.subAgentVerifiedUrls;
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        const url = str(entry);
        if (url) out.push(url);
      }
    }
    return out;
  }

  /**
   * Write the completion-evidence bundle as a single appended JSONL line and
   * record the artifact path on a task event so a reviewer can re-read exactly
   * what the verifier judged.
   *
   * Fire-and-forget: invoked with `void` from {@link buildCompletionEvidence},
   * so every IO step is wrapped — a failure logs and continues without throwing
   * into the `task_complete` event path. The path is already stamped on the
   * bundle by the caller, so a write failure only means the artifact never lands;
   * the evidence string still cites the (intended) path.
   */
  private async writeEvidenceTrajectory(
    taskId: string,
    sessionId: string,
    bundle: CompletionEvidenceBundle,
  ): Promise<void> {
    const trajectoryPath = bundle.trajectoryPath;
    if (!trajectoryPath) return;
    try {
      await mkdir(dirname(trajectoryPath), { recursive: true });
      const line = `${JSON.stringify({
        kind: "completion_evidence_bundle",
        taskId,
        sessionId,
        recordedAt: nowIso(),
        bundle,
      })}\n`;
      await appendFile(trajectoryPath, line, "utf8");
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        sessionId,
        eventType: "completion_evidence_persisted",
        summary: "Persisted completion-evidence bundle to trajectory artifact.",
        data: { trajectoryPath },
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      this.emitChange(taskId);
    } catch (err) {
      // error-policy:J7 trajectory write is fire-and-forget; a failed write only
      // means the artifact never lands, debug-logged, never breaks completion.
      this.log("debug", "persist evidence trajectory failed", {
        taskId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The completion-evidence trajectory file path: a `completion-evidence.jsonl`
   *  under the live session workdir's `.eliza/trajectories`, else a `~/.eliza`-
   *  scoped per-task dir when no workspace is available. Deterministic so it can
   *  be cited in the evidence before the file is actually written. */
  private async resolveTrajectoryPath(
    taskId: string,
    sessionId: string,
  ): Promise<string> {
    let dir = join(homedir(), ".eliza", "trajectories", taskId);
    try {
      const acp = this.acp();
      const live = acp ? await acp.getSession(sessionId) : undefined;
      const workdir = str(live?.workdir);
      if (workdir) dir = join(workdir, ".eliza", "trajectories");
    } catch {
      // error-policy:J4 the ACP workdir lookup is optional enrichment; on failure
      // fall back to the documented home-scoped trajectory dir.
    }
    return join(dir, "completion-evidence.jsonl");
  }

  /** The git change set for a completed session: prefer the live ACP session
   *  metadata (freshest), fall back to the mirrored store-session metadata. */
  private async resolveCompletionChangeSet(
    sessionId: string,
    doc: OrchestratorTaskDocument,
  ): Promise<WorkspaceChangeSet | undefined> {
    try {
      const acp = this.acp();
      if (acp) {
        const live = await acp.getSession(sessionId);
        const fromLive = readLastChangeSet(
          live?.metadata as Record<string, unknown> | undefined,
        );
        if (fromLive) return fromLive;
      }
    } catch {
      // error-policy:J4 the live ACP read is optional; fall through to the
      // mirrored store-session change-set copy.
    }
    const stored = doc.sessions.find(
      (session) => session.sessionId === sessionId,
    );
    return readLastChangeSet(stored?.metadata);
  }

  /** Screenshot / trajectory / other artifact references for the verifier to
   *  cite, from the durable artifact rows plus any artifact paths stamped on
   *  the task or its session metadata. */
  private collectArtifactRefs(
    doc: OrchestratorTaskDocument,
    sessionId: string,
  ): EvidenceArtifactRef[] {
    const refs: EvidenceArtifactRef[] = doc.artifacts
      .filter(
        (artifact) =>
          artifact.sessionId === sessionId || artifact.sessionId === undefined,
      )
      .map((artifact) => ({
        artifactType: artifact.artifactType,
        title: artifact.title,
        ref: artifact.path ?? artifact.uri,
      }));

    const session = doc.sessions.find((row) => row.sessionId === sessionId);
    for (const [label, meta] of [
      ["task", doc.task.metadata],
      ["session", session?.metadata],
    ] as const) {
      const screenshot = str(meta?.screenshotPath ?? meta?.screenshot);
      if (screenshot) {
        refs.push({
          artifactType: "screenshot",
          title: `${label} screenshot`,
          ref: screenshot,
        });
      }
      const trajectory = str(meta?.trajectoryPath ?? meta?.trajectory);
      if (trajectory) {
        refs.push({
          artifactType: "trajectory",
          title: `${label} trajectory`,
          ref: trajectory,
        });
      }
    }
    return refs;
  }

  /**
   * Advance a non-terminal task to `next`, but never override a status the
   * operator or validation owns. `validating`/`waiting_on_user`/`blocked` are
   * not stomped by a later `active`, and terminal tasks are immutable here.
   */
  private async advanceTaskStatus(
    taskId: string,
    next: OrchestratorTaskStatus,
  ): Promise<void> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return;
    const current = doc.task.status;
    if (TERMINAL_TASK_STATUSES.has(current)) return;
    if (doc.task.paused) return;
    if (next === current) return;
    // `active` is the weakest signal: only promote into it from `open`. A live
    // event (ready/tool_running) arriving while the task already parked on a
    // stronger state (blocked/validating/waiting_on_user) must not stomp it
    // back to active — short out silently here rather than routing an ordinary
    // event through the illegal-transition log below.
    if (next === "active" && current !== "open") return;
    if (!isLegalTaskStatusTransition(current, next)) {
      // A write the lifecycle table forbids means a caller wired a transition
      // the state machine does not model. Surface it instead of silently
      // corrupting the durable task status.
      this.log("warn", "rejected illegal task status transition", {
        taskId,
        from: current,
        to: next,
      });
      return;
    }
    await this.store.updateTask(taskId, { status: next });
  }

  private async markSessionAccountUnhealthy(
    sessionId: string,
    reason: "auth" | "rate-limit",
    detail?: string,
  ): Promise<void> {
    const found = await this.store.findSession(sessionId);
    const session = found?.session;
    if (!session?.accountProviderId || !session.accountId) return;
    const bridge = getCodingAccountBridge();
    if (!bridge) return;
    try {
      if (reason === "rate-limit") {
        await bridge.markRateLimited(
          session.accountProviderId,
          session.accountId,
          Date.now() + 5 * 60_000,
          detail,
        );
      } else {
        await bridge.markNeedsReauth(
          session.accountProviderId,
          session.accountId,
          detail,
        );
      }
    } catch (err) {
      // error-policy:J7 account-health marking is advisory for session
      // selection and must not fail the caller, but a swallowed failure leaves
      // a rate-limited/needs-reauth account looking healthy and eligible for
      // reuse — report it so the agent sees it and the mutation isn't lost.
      this.runtime.reportError(
        "OrchestratorTask.markSessionAccountUnhealthy",
        err,
        { sessionId, reason },
      );
      this.log("warn", "failed to mark session account unhealthy", {
        sessionId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async recordUsage(
    taskId: string,
    sessionId: string,
    usage: ParsedUsage,
  ): Promise<void> {
    // Dedup replayed/redelivered usage frames: the producer stamps a stable
    // per-turn sourceEventId, so a frame already recorded for this task must
    // not be summed a second time.
    if (usage.sourceEventId) {
      const doc = await this.store.getTask(taskId);
      if (doc?.usage.some((row) => row.sourceEventId === usage.sourceEventId)) {
        return;
      }
    }
    const found = await this.store.findSession(sessionId);
    const session = found?.session;
    // The terminal result often omits provider/model; the session record knows
    // which framework/model produced the turn, so fill the gaps from there.
    const provider =
      usage.provider !== "unknown"
        ? usage.provider
        : (session?.providerSource ?? session?.framework ?? usage.provider);
    const model = usage.model ?? session?.model;
    await this.store.addUsage({
      id: randomUUID(),
      taskId,
      sessionId,
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheTokens: usage.cacheTokens,
      costUsd: usage.costUsd,
      state: usage.state,
      sourceEventId: usage.sourceEventId,
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    if (!session) return;
    await this.store.updateSession(sessionId, {
      inputTokens: session.inputTokens + usage.inputTokens,
      outputTokens: session.outputTokens + usage.outputTokens,
      reasoningTokens: session.reasoningTokens + usage.reasoningTokens,
      cacheTokens: session.cacheTokens + usage.cacheTokens,
      costUsd: session.costUsd + (usage.costUsd ?? 0),
      usageState: usage.state,
    });
    if (session.accountProviderId && session.accountId) {
      const turnTokens =
        usage.inputTokens +
        usage.outputTokens +
        usage.reasoningTokens +
        usage.cacheTokens;
      void getCodingAccountBridge()
        ?.recordUsage(session.accountProviderId, session.accountId, {
          tokens: turnTokens,
          ok: true,
          ...(model ? { model } : {}),
        })
        // error-policy:J7 account-usage accounting is a side-channel that must
        // not fail the turn, but a swallowed failure silently under-counts a
        // provider account's spend (quota/billing drift) — report it.
        .catch((err) =>
          this.runtime.reportError("OrchestratorTask.recordAccountUsage", err, {
            taskId,
            sessionId,
            accountProviderId: session.accountProviderId,
          }),
        );
    }
  }

  private async recordMessage(
    taskId: string,
    input: AddMessageInput,
  ): Promise<void> {
    await this.store.addMessage({
      id: randomUUID(),
      taskId,
      sessionId: input.sessionId,
      senderKind: input.senderKind,
      direction: input.direction ?? "system",
      content: input.content,
      searchableText: input.content.toLowerCase(),
      timestamp: Date.now(),
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    });
    this.emitChange(taskId);
  }

  private async resolveTaskId(sessionId: string): Promise<string | undefined> {
    const cached = this.sessionTaskIndex.get(sessionId);
    if (cached) return cached;
    const found = await this.store.findSession(sessionId);
    if (!found) return undefined;
    this.sessionTaskIndex.set(sessionId, found.taskId);
    return found.taskId;
  }

  // ---- lifecycle ---------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<TaskThreadDetailDto> {
    const doc = await this.store.createTask(
      await this.withDefaultAcceptanceCriteria(input),
    );
    if (input.originalRequest) {
      await this.recordMessage(doc.task.id, {
        content: input.originalRequest,
        senderKind: "user",
        direction: "stdin",
      });
    }
    const detail = await this.store.getTask(doc.task.id);
    return toTaskThreadDetail(detail ?? doc);
  }

  /**
   * When a task is created WITHOUT acceptance criteria and with a non-trivial
   * goal, populate 3-5 measurable default criteria so the auto goal-verifier
   * (#8896) always has something to grill against instead of fast-pathing to
   * pass / parking forever in `validating`.
   *
   * - **No-op when criteria were supplied** — the caller's contract wins; the
   *   input is returned unchanged.
   * - **Gated** behind `ELIZA_REQUIRE_GOAL_CONTRACT` (default ON; `"0"`
   *   disables), mirroring {@link shouldAutoVerifyGoal}.
   * - **Defensive** — {@link generateDefaultAcceptanceCriteria} never throws;
   *   on any model failure it returns the static template set, so task creation
   *   can never be broken by criteria generation.
   */
  private async withDefaultAcceptanceCriteria(
    input: CreateTaskInput,
  ): Promise<CreateTaskInput> {
    const supplied = input.acceptanceCriteria;
    // Caller-supplied criteria are authoritative — never overwrite them.
    if (supplied && supplied.length > 0) return input;
    if (!shouldRequireGoalContract()) return input;
    if (!isNonTrivialGoal(input.goal)) return input;

    const hint = this.taskTypeHintFor(input);
    const generated = await generateDefaultAcceptanceCriteria(
      input.goal,
      hint,
      this.runtime,
    );
    if (generated.length === 0) return input;
    this.log(
      "debug",
      `auto-generated ${generated.length} default acceptance criteria for criteria-free task (type=${hint ?? detectTaskType(input.goal)})`,
    );
    return { ...input, acceptanceCriteria: generated };
  }

  /** Map an explicit `kind` on the create input to a task type when it lines up
   *  with a known template type, so the caller's stated kind beats keyword
   *  detection; otherwise let {@link detectTaskType} read the goal text. */
  private taskTypeHintFor(
    input: CreateTaskInput,
  ): OrchestratorTaskType | undefined {
    switch (input.kind) {
      case "coding":
      case "view-create":
      case "app-build":
      case "deploy":
        return input.kind;
      default:
        return undefined;
    }
  }

  async listTasks(filter: TaskListFilter = {}): Promise<TaskThreadDto[]> {
    const records = await this.store.listTasks(filter);
    const docs = await Promise.all(
      records.map((record) => this.store.getTask(record.id)),
    );
    return docs
      .filter((doc): doc is OrchestratorTaskDocument => doc !== null)
      .map(toTaskThread);
  }

  async getTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    return doc ? toTaskThreadDetail(doc) : null;
  }

  /**
   * Resolve the originating chat target for a task — the room + connector source
   * it was created from — so proactive surfaces (the TaskSupervisorService
   * digest, #8900) can post back to where the user is. The origin `source` is
   * read from the task record metadata stamped at create time. Returns null when
   * the task has no origin room (e.g. an API-created task with no chat).
   */
  async getTaskOriginTarget(
    taskId: string,
  ): Promise<{ roomId: string; source: string; worldId?: string } | null> {
    const doc = await this.store.getTask(taskId);
    const roomId = doc?.task.roomId;
    if (!roomId) return null;
    const meta = doc.task.metadata ?? {};
    const source =
      typeof meta.source === "string" && meta.source
        ? meta.source
        : "orchestrator";
    return {
      roomId,
      source,
      ...(doc.task.worldId ? { worldId: doc.task.worldId } : {}),
    };
  }

  async updateTask(
    taskId: string,
    patch: Partial<
      Pick<
        OrchestratorTaskRecord,
        | "title"
        | "goal"
        | "summary"
        | "acceptanceCriteria"
        | "priority"
        | "currentPlan"
        | "providerPolicy"
        | "metadata"
      >
    >,
  ): Promise<TaskThreadDetailDto | null> {
    const updated = await this.store.updateTask(taskId, omitUndefined(patch));
    if (!updated) return null;
    return this.getTask(taskId);
  }

  async pauseTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    await this.stopActiveSessions(doc);
    await this.store.updateTask(taskId, { paused: true });
    return this.getTask(taskId);
  }

  async resumeTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const updated = await this.store.updateTask(taskId, { paused: false });
    if (!updated) return null;
    return this.getTask(taskId);
  }

  async archiveTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    await this.stopActiveSessions(doc);
    await this.store.updateTask(taskId, {
      archived: true,
      status: "archived",
      archivedAt: nowIso(),
      closedAt: doc.task.closedAt ?? nowIso(),
    });
    return this.getTask(taskId);
  }

  async reopenTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    await this.store.updateTask(taskId, {
      archived: false,
      // A paused-then-archived task must not reopen frozen: paused:true would
      // keep advanceTaskStatus inert with no archive surface left to clear it.
      paused: false,
      status: doc.sessions.length > 0 ? "active" : "open",
      archivedAt: null,
      closedAt: null,
    });
    return this.getTask(taskId);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    await this.stopActiveSessions(doc);
    for (const session of doc.sessions) {
      this.sessionTaskIndex.delete(session.sessionId);
      this.recordFailureWarned.delete(session.sessionId);
    }
    return this.store.deleteTask(taskId);
  }

  async forkTask(
    taskId: string,
    overrides: Partial<CreateTaskInput> = {},
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    return this.createTask({
      title: overrides.title ?? `${doc.task.title} (fork)`,
      goal: overrides.goal ?? doc.task.goal,
      originalRequest: overrides.originalRequest ?? doc.task.originalRequest,
      kind: overrides.kind ?? doc.task.kind,
      priority: overrides.priority ?? doc.task.priority,
      acceptanceCriteria: overrides.acceptanceCriteria ?? [
        ...doc.task.acceptanceCriteria,
      ],
      ownerUserId: overrides.ownerUserId ?? doc.task.ownerUserId,
      worldId: overrides.worldId ?? doc.task.worldId,
      providerPolicy: overrides.providerPolicy ?? doc.task.providerPolicy,
      currentPlan: overrides.currentPlan ?? doc.task.currentPlan,
      parentTaskId: taskId,
      forkSource: doc.task.id,
      metadata: overrides.metadata ?? {},
    });
  }

  /** Promote a `validating` task to `done` (proof passed) or back to `active`
   * (proof failed → retry). The orchestrator never reports `done` without this. */
  async validateTask(
    taskId: string,
    result: {
      passed: boolean;
      summary?: string;
      evidence?: string;
      verifier?: string;
      humanOverride?: boolean;
    },
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    if (doc.task.status !== "validating" && !result.humanOverride) {
      throw new Error("Task must be validating before validation can finish");
    }
    const evidence =
      result.evidence ??
      result.summary ??
      (result.humanOverride
        ? result.passed
          ? "Human approved in the orchestrator UI."
          : "Human rejected in the orchestrator UI."
        : undefined);
    if (!evidence) {
      throw new Error("validation evidence is required");
    }
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      eventType: result.passed ? "validation_passed" : "validation_failed",
      summary: result.summary ?? evidence,
      timestamp: Date.now(),
      data: {
        evidence,
        verifier: result.verifier ?? "orchestrator",
        humanOverride: result.humanOverride === true,
      },
      createdAt: nowIso(),
    });
    if (result.passed) {
      await this.store.updateTask(taskId, {
        status: "done",
        summary: result.summary ?? doc.task.summary,
        closedAt: nowIso(),
      });
    } else {
      await this.store.updateTask(taskId, {
        status: "active",
        summary: result.summary ?? doc.task.summary,
      });
    }
    return this.getTask(taskId);
  }

  /**
   * Verify a freshly-`validating` task against its acceptance criteria before
   * promoting it to `done` (issue #8124). One linear pipeline runs inside the
   * re-entrancy guard:
   *
   * 1. **Structural envelope gate (#8895).** {@link parseCompletionEnvelope} reads
   *    the sub-agent's verbatim final message. A PRESENT-but-malformed envelope is
   *    blocked *before* any model spend and the worker is re-prompted with
   *    {@link envelopeCorrection}. An ABSENT envelope falls through unchanged
   *    (back-compat). A VALID envelope is stamped onto `metadata.completionEnvelope`
   *    and its {@link summarizeEnvelope} is prepended to the judge's evidence so the
   *    judge grills the contract, not prose.
   * 2. **Independent execution verifier (#8898).** For code-change tasks
   *    ({@link shouldRunIndependentVerify}) a SEPARATE read-only ACP session re-runs
   *    the tests/diff and returns an execution-grounded verdict. A failing verdict
   *    BLOCKS (provenance `independent-acp-verifier`); an inconclusive verdict keeps
   *    the task `validating` (never a false promotion on a verifier crash); a
   *    passing/skipped verdict falls through.
   * 3. **Text judge (fallback).** {@link verifyGoalCompletion} (`ModelType.TEXT_SMALL`)
   *    judges the evidence and promotes (→ `done`) or re-prompts.
   *
   * All three failure paths share one {@link reEngageOrEscalate} helper, one
   * `autoVerifyAttempts` counter, and one {@link MAX_AUTO_VERIFY_ATTEMPTS} cap, so a
   * malformed/failing worker is re-prompted a bounded number of times and then
   * parked on `waiting_on_user`.
   *
   * Fire-and-forget from the event bridge: failures here must never break the
   * session-event write path, so everything is wrapped and logged.
   */
  private async autoVerifyCompletion(
    taskId: string,
    sessionId: string,
    completionEvidence: string,
    rawCompletion: string,
  ): Promise<void> {
    if (!shouldAutoVerifyGoal()) return;
    // Re-entrancy guard: drop a second overlapping run for the same task (the
    // check-then-act across the model `await` would otherwise double-count).
    if (this.autoVerifyInFlight.has(taskId)) return;
    this.autoVerifyInFlight.add(taskId);
    try {
      const doc = await this.store.getTask(taskId);
      if (!doc) return;
      // Only act on the state the task_complete event just produced. A human or
      // the manual auto-validate route may have already moved it on.
      if (doc.task.status !== "validating") return;
      const acceptanceCriteria = doc.task.acceptanceCriteria;
      // Criteria-free tasks keep the prior behavior: stay `validating` for a
      // human/manual caller, no surprise model spend.
      if (acceptanceCriteria.length === 0) return;
      const attempts = num(doc.task.metadata?.autoVerifyAttempts);

      // 1. Structural envelope gate (#8895) — BEFORE any model spend.
      const parse = parseCompletionEnvelope(rawCompletion);
      let evidence = completionEvidence;
      if (parse.present && !parse.ok) {
        // Malformed contract: block the judge and re-prompt for a valid envelope.
        await this.reEngageOrEscalate({
          taskId,
          sessionId,
          correction: envelopeCorrection(parse.errors),
          eventType: "envelope_invalid",
          verifier: "completion-envelope",
          summary: `Completion envelope was malformed: ${parse.errors.join("; ")}`,
          missing: parse.errors,
          attempt: attempts,
        });
        return;
      }
      if (parse.present && parse.ok) {
        // Valid contract: stamp the structured fields and feed the judge a
        // contract-grounded evidence string instead of raw prose.
        await this.store.updateTask(taskId, {
          metadata: {
            ...doc.task.metadata,
            completionEnvelope: {
              diffSummary: parse.envelope.diffSummary,
              filesChanged: parse.envelope.filesChanged,
              ...(parse.envelope.realWorkdir
                ? { realWorkdir: parse.envelope.realWorkdir }
                : {}),
              ...(parse.envelope.verifiedChangedFiles
                ? { verifiedChangedFiles: parse.envelope.verifiedChangedFiles }
                : {}),
              ...(typeof parse.envelope.artifactsVerified === "boolean"
                ? { artifactsVerified: parse.envelope.artifactsVerified }
                : {}),
              ...(parse.envelope.missingArtifacts
                ? { missingArtifacts: parse.envelope.missingArtifacts }
                : {}),
              testResults: parse.envelope.testResults,
              acceptanceCriteriaStatus: parse.envelope.acceptanceCriteriaStatus,
              residualRisks: parse.envelope.residualRisks,
            },
          },
        });
        evidence = `${summarizeEnvelope(parse.envelope)}\n\n${completionEvidence}`;
      }

      // 2. Independent read-only execution verifier (#8898).
      const independent = await this.runIndependentVerify(
        taskId,
        doc,
        sessionId,
      );
      if (independent) {
        if (independent.inconclusive) {
          // A verifier crash/empty verdict is never a pass — keep validating.
          await this.store.addEvent({
            id: randomUUID(),
            taskId,
            sessionId,
            eventType: "independent_verify_inconclusive",
            summary: independent.summary,
            data: {
              verifier: INDEPENDENT_ACP_VERIFIER_NAME,
              unmet: independent.unmet,
              failedCommands: independent.failedCommands,
            },
            timestamp: Date.now(),
            createdAt: nowIso(),
          });
          this.emitChange(taskId);
          return;
        }
        if (!independent.passed) {
          // Execution disproved the worker's claim — block with distinct
          // provenance, then re-prompt with the concrete gaps.
          const blockEvidence = [
            independent.summary,
            independent.unmet.length > 0
              ? `Unmet criteria: ${independent.unmet.join("; ")}`
              : "",
            independent.failedCommands.length > 0
              ? `Failing commands: ${independent.failedCommands.join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          await this.validateTask(taskId, {
            passed: false,
            summary: independent.summary,
            evidence: blockEvidence,
            verifier: INDEPENDENT_ACP_VERIFIER_NAME,
          });
          const missing = [
            ...independent.unmet,
            ...independent.failedCommands.map((c) => `command failed: ${c}`),
          ];
          await this.reEngageOrEscalate({
            taskId,
            sessionId,
            correction: buildAutoVerifyCorrection(
              missing.length > 0 ? missing : [independent.summary],
              attempts + 1,
            ),
            eventType: "independent_verify_failed",
            verifier: INDEPENDENT_ACP_VERIFIER_NAME,
            summary: independent.summary,
            missing,
            attempt: attempts,
          });
          return;
        }
      }

      // 3. Text judge (fallback for non-code / criteria-light tasks).
      const verdict = await verifyGoalCompletion(
        this.runtime,
        {
          goal: doc.task.goal,
          acceptanceCriteria,
          completionEvidence: evidence,
        },
        {
          recordTrajectory: {
            roomId: doc.task.roomId,
            taskId,
            sessionId,
          },
        },
      );

      if (verdict.passed) {
        await this.validateTask(taskId, {
          passed: true,
          summary: verdict.summary,
          evidence: verdict.rawResponse || evidence,
          verifier: LLM_GOAL_VERIFIER_NAME,
        });
        // Notify live subscribers (SSE/UI) — this is a fire-and-forget hook with
        // no HTTP response to refresh the client, so emitChange is the only
        // signal that the task left `validating`. Every other branch emits too.
        this.emitChange(taskId);
        return;
      }

      await this.reEngageOrEscalate({
        taskId,
        sessionId,
        // Escalate the grill per attempt: `attempts` is the count of prior
        // failures, so `attempts + 1` is this correction's 1-based stage.
        correction: buildAutoVerifyCorrection(verdict.missing, attempts + 1),
        eventType: "auto_verify_failed",
        verifier: LLM_GOAL_VERIFIER_NAME,
        summary: verdict.summary,
        missing: verdict.missing,
        attempt: attempts,
      });
    } catch (err) {
      // error-policy:J7 auto-verify is fire-and-forget from the event bridge; a
      // failure warns and must not break the session-event write path.
      this.log("warn", "auto goal verification failed", {
        taskId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.autoVerifyInFlight.delete(taskId);
    }
  }

  /**
   * Shared re-prompt / escalation path for every failed completion verdict — the
   * malformed-envelope gate (#8895), the independent-verify block (#8898), and the
   * text judge. ONE `autoVerifyAttempts` counter and ONE
   * {@link MAX_AUTO_VERIFY_ATTEMPTS} cap govern all three: under the cap the
   * kept-alive worker is reactivated and re-prompted with `correction` (and a
   * reflexion post-mortem is recorded for the next respawn, #8899); at the cap, or
   * when the corrective send fails, the task is parked on `waiting_on_user` instead
   * of looping forever.
   *
   * @param attempt the count of PRIOR failed attempts (0-based); the helper persists
   *        `attempt + 1` as the new counter and uses it as the 1-based grill stage.
   */
  private async reEngageOrEscalate(args: {
    taskId: string;
    sessionId: string;
    correction: string;
    eventType: string;
    verifier: string;
    summary: string;
    missing: string[];
    attempt: number;
  }): Promise<void> {
    const {
      taskId,
      sessionId,
      correction,
      eventType,
      verifier,
      summary,
      missing,
      attempt,
    } = args;
    if (attempt >= MAX_AUTO_VERIFY_ATTEMPTS) {
      // Stop the loop: park for a human rather than re-prompting forever.
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        sessionId,
        eventType: "auto_verify_exhausted",
        summary: `Automatic verification failed ${attempt} time(s); escalating to a human.`,
        data: { verifier, missing, attempts: attempt },
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      await this.advanceTaskStatus(taskId, "waiting_on_user");
      this.emitChange(taskId);
      return;
    }
    // Persist the bumped attempt counter + a reflexion post-mortem first, so a
    // redelivered task_complete can't double-count and the next respawn (#8899)
    // can replay the gap. Re-read the doc so an upstream metadata write in this
    // same pass (e.g. the valid-envelope stamp) is preserved.
    const doc = await this.store.getTask(taskId);
    if (!doc) {
      // The task was deleted concurrently (e.g. the user cancelled during
      // auto-verify). Bail: there is nothing to re-engage, and writing partial
      // metadata back with `...doc?.task.metadata` spreading to `{}` would
      // clobber the completion envelope this very re-read exists to preserve.
      return;
    }
    const attemptReflections = [
      ...readAttemptReflections(doc.task.metadata),
      { attempt: attempt + 1, missing, summary },
    ].slice(-MAX_ATTEMPT_REFLECTIONS);
    await this.store.updateTask(taskId, {
      metadata: {
        ...doc.task.metadata,
        autoVerifyAttempts: attempt + 1,
        attemptReflections,
      },
    });
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      sessionId,
      eventType,
      summary,
      data: { verifier, missing, attempt: attempt + 1 },
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    try {
      // Reactivate the kept-alive session so the corrective turn lands on a
      // non-terminal record, then re-dispatch through the goal envelope.
      await this.store.updateSession(sessionId, {
        status: "ready",
        taskDelivered: false,
        stoppedAt: undefined,
      });
      await this.sendToTaskAgent(
        taskId,
        sessionId,
        correction,
        "validation_failed",
      );
      await this.store.updateTask(taskId, { status: "active" });
    } catch (sendErr) {
      // error-policy:J1 boundary — a failed corrective send becomes a structured
      // escalation (event + waiting_on_user), never a silent stall.
      // The kept-alive session could not take the follow-up — escalate rather
      // than silently leaving the task stuck in `validating`.
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        sessionId,
        eventType: "auto_verify_resend_failed",
        summary:
          "Automatic verification failed and the corrective follow-up could not be delivered; escalating to a human.",
        data: {
          verifier,
          missing,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        },
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      await this.advanceTaskStatus(taskId, "waiting_on_user");
    }
    this.emitChange(taskId);
  }

  /**
   * Independent read-only execution verifier (#8898). For code-change tasks, spawn
   * a SEPARATE read-only ACP session that re-runs the tests/diff and returns an
   * execution-grounded verdict. Returns `null` when the verifier is gated off
   * (non-code task, flag disabled, or no ACP / workdir available), so the caller
   * falls through to the text judge.
   */
  private async runIndependentVerify(
    taskId: string,
    doc: OrchestratorTaskDocument,
    sessionId: string,
  ): Promise<IndependentVerifierVerdict | null> {
    const changeSet = await this.resolveCompletionChangeSet(sessionId, doc);
    const hasCodeChanges = (changeSet?.changedFiles.length ?? 0) > 0;
    // shouldRunIndependentVerify wants (key) => string | undefined | null.
    // Resolve from runtime settings, then fall back to process.env so the
    // ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY flag is honored consistently with the
    // env-driven shouldAutoVerifyGoal gate (runtime.getSetting may be absent).
    const getSetting = (key: string): string | undefined => {
      const value = this.runtime.getSetting?.(key);
      if (typeof value === "string") return value;
      const fromEnv = process.env[key];
      return typeof fromEnv === "string" ? fromEnv : undefined;
    };
    if (!shouldRunIndependentVerify(getSetting, hasCodeChanges)) return null;
    const acp = this.acp();
    if (!acp) return null;
    const session = doc.sessions.find((s) => s.sessionId === sessionId);
    const workdir = session?.workdir;
    if (!workdir) return null;
    const diffSummary =
      changeSet && changeSet.changedFiles.length > 0
        ? renderChangeSetBody(changeSet)
        : undefined;
    return runIndependentVerification(
      {
        goal: doc.task.goal,
        acceptanceCriteria: doc.task.acceptanceCriteria,
        ...(diffSummary ? { diffSummary } : {}),
      },
      {
        spawnAndAwait: (prompt) =>
          this.spawnReadOnlyVerifier(acp, prompt, workdir, taskId, sessionId),
      },
    );
  }

  /**
   * Spawn the #8898 read-only verifier as an EPHEMERAL ACP session and resolve its
   * final completion text. The session runs under the `verifier` approval preset
   * (read + search + execute; writes denied at the transport) in the completed
   * worker's workdir and is torn down after its verdict. It is intentionally NOT
   * registered with the task store, so the event bridge's `resolveTaskId` ignores
   * its events and it never recurses into auto-verify.
   */
  private async spawnReadOnlyVerifier(
    acp: AcpService,
    prompt: string,
    workdir: string,
    taskId: string,
    reportingSessionId: string,
  ): Promise<string> {
    const timeoutMs = independentVerifyTimeoutMs(this.runtime);
    const live = await acp.getSession(reportingSessionId);
    const meta = live?.metadata;
    const parentDepth =
      isRecord(meta) && typeof meta.nestingDepth === "number"
        ? meta.nestingDepth
        : 0;
    const spawn = await acp.spawnSession({
      agentType: configuredDefaultAgentType(this.runtime) ?? "opencode",
      workdir,
      initialTask: prompt,
      approvalPreset: "verifier",
      // Draw on the reserved system-session headroom, not a worker slot: the
      // task being verified still holds its worker slot (orchestrator sessions
      // stay alive after task_complete), so counting the verifier as a worker
      // would deadlock validation behind the very cap it is trying to clear.
      slotClass: "system",
      metadata: {
        taskId,
        source: "independent-verifier",
        keepAliveAfterComplete: false,
        nestingDepth: parentDepth + 1,
      },
    });
    const verifierSessionId = spawn.sessionId;
    let unsubscribe: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `independent verifier session timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        unsubscribe = acp.onSessionEvent((sid, event, data) => {
          if (sid !== verifierSessionId) return;
          if (event === "task_complete") {
            clearTimeout(timer);
            const response = isRecord(data) ? str(data.response) : undefined;
            resolve(response ?? "");
          } else if (event === "error") {
            clearTimeout(timer);
            const message = isRecord(data) ? str(data.message) : undefined;
            reject(
              new Error(message ?? "independent verifier session errored"),
            );
          }
        });
      });
    } finally {
      unsubscribe?.();
      try {
        await acp.stopSession(verifierSessionId);
      } catch (stopErr) {
        // error-policy:J6 best-effort teardown of the ephemeral verifier session;
        // a failed stop is warned and must not mask the verdict.
        this.log("warn", "failed to stop independent verifier session", {
          sessionId: verifierSessionId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    }
  }

  async addMessage(taskId: string, input: AddMessageInput): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    await this.recordMessage(taskId, input);
    if (input.senderKind === "user")
      await this.store.updateTask(taskId, { lastUserTurnAt: nowIso() });
    return true;
  }

  /**
   * Record a user turn in the task room and relay it to every live sub-agent
   * as a goal-wrapped follow-up. This is the composer's entry point: talking to
   * the room steers the workers attached to it. Terminal sessions are skipped;
   * the message is still recorded so the room history stays complete.
   */
  async postUserMessage(
    taskId: string,
    content: string,
  ): Promise<{
    recorded: boolean;
    forwardedTo: string[];
    failedTo: Array<{ sessionId: string; error: string }>;
  } | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    await this.addMessage(taskId, {
      content,
      senderKind: "user",
      direction: "stdin",
    });
    const active = doc.sessions.filter(
      (s) => !TERMINAL_TASK_SESSION_STATUSES.has(s.status),
    );
    const forwardedTo: string[] = [];
    const failedTo: Array<{ sessionId: string; error: string }> = [];
    const acp = this.acp();
    if (!acp) {
      const error = "ACP service unavailable";
      if (active.length > 0) {
        for (const session of active) {
          failedTo.push({ sessionId: session.sessionId, error });
          await this.store.updateSession(session.sessionId, {
            status: "send_failed",
          });
        }
      } else {
        failedTo.push({ sessionId: "(auto-spawn)", error });
      }
      this.log("warn", "user message recorded but not delivered", {
        taskId,
        error,
      });
    } else if (active.length > 0) {
      const followUp = buildGoalFollowUp({
        goal: doc.task.goal,
        message: content,
        acceptanceCriteria: doc.task.acceptanceCriteria,
        reason: "user_message",
        taskRoomId: doc.task.taskRoomId ?? doc.task.roomId,
      });
      for (const session of active) {
        await this.store.updateSession(session.sessionId, {
          lastInputSentAt: Date.now(),
        });
        try {
          await acp.sendToSession(session.sessionId, followUp);
          forwardedTo.push(session.sessionId);
        } catch (err) {
          // error-policy:J1 per-session relay failure is collected into the
          // structured failedTo result and the session marked send_failed.
          const error = err instanceof Error ? err.message : String(err);
          failedTo.push({ sessionId: session.sessionId, error });
          await this.store.updateSession(session.sessionId, {
            status: "send_failed",
          });
          this.log("warn", "relay to active session failed", {
            sessionId: session.sessionId,
            error,
          });
        }
      }
    } else {
      // No active coding agent — auto-spawn one to work on the message so
      // messaging the orchestrator "just works" (parity with claude/codex):
      // the default framework (opencode + Cerebras) into a per-task workdir.
      try {
        await this.spawnAgentForTask(taskId, {
          task: content,
          workdir: await ensureTaskWorkdir(taskId),
        });
        forwardedTo.push("auto-spawned");
      } catch (err) {
        // error-policy:J1 auto-spawn failure is reported through the structured
        // failedTo result, not swallowed.
        const error = err instanceof Error ? err.message : String(err);
        failedTo.push({ sessionId: "(auto-spawn)", error });
        this.log("warn", "auto-spawn on user message failed", { error });
      }
    }
    return { recorded: true, forwardedTo, failedTo };
  }

  async createPlanRevision(
    taskId: string,
    input: CreatePlanRevisionInput,
  ): Promise<TaskPlanRevisionDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    if (
      input.basePlanRevisionId &&
      !findPlanRevision(doc, input.basePlanRevisionId)
    ) {
      throw new RecoveryConflictError("Base plan revision not found");
    }
    const timestamp = Date.now();
    const revision = {
      id: randomUUID(),
      taskId,
      plan: structuredClone(input.plan),
      basePlanRevisionId: input.basePlanRevisionId,
      editSummary: input.editSummary,
      createdBy: input.createdBy ?? "operator",
      metadata: input.metadata ?? {},
      timestamp,
      createdAt: nowIso(),
    };
    await this.store.addPlanRevision(revision);
    if (input.makeCurrent !== false) {
      await this.store.updateTask(taskId, { currentPlan: revision.plan });
    }
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      eventType: "plan_revision_created",
      summary: input.editSummary ?? "Plan revision created",
      data: {
        planRevisionId: revision.id,
        basePlanRevisionId: revision.basePlanRevisionId,
        createdBy: revision.createdBy,
      },
      timestamp,
      createdAt: revision.createdAt,
    });
    return toTaskPlanRevisionDto(revision);
  }

  async listPlanRevisions(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<TaskPlanRevisionDto> | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const page = paginate(doc.planRevisions, opts);
    return { ...page, items: page.items.map(toTaskPlanRevisionDto) };
  }

  async retryTaskTurn(
    taskId: string,
    input: RetryTaskTurnInput = {},
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const planRevision = findPlanRevision(doc, input.planRevisionId);
    if (input.planRevisionId && !planRevision) {
      throw new RecoveryConflictError("Plan revision not found");
    }
    const source = input.messageId
      ? doc.messages.find((message) => message.id === input.messageId)
      : undefined;
    if (input.messageId && !source) {
      throw new RecoveryConflictError("Source message not found");
    }
    const instruction = withPlanRevisionContext(
      retryInstruction(doc, input),
      planRevision,
    );
    const mode = input.mode ?? "same-session";
    if (mode === "new-session") {
      await this.spawnAgentForTask(taskId, {
        ...input.agent,
        task: instruction,
      });
      if (planRevision) {
        await this.store.updateTask(taskId, { currentPlan: planRevision.plan });
      }
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        sessionId: input.sessionId ?? source?.sessionId,
        eventType: "retry_turn_requested",
        summary: "Retry turn requested",
        data: {
          messageId: input.messageId,
          sessionId: input.sessionId,
          mode,
          instruction: input.instruction,
          planRevisionId: planRevision?.id,
        },
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      return this.getTask(taskId);
    }

    const sessionId =
      input.sessionId ??
      source?.sessionId ??
      latestActiveSession(doc)?.sessionId;
    if (!sessionId) {
      throw new RecoveryConflictError(
        "sessionId is required for same-session retry",
      );
    }
    const session = doc.sessions.find((item) => item.sessionId === sessionId);
    if (!session) throw new RecoveryConflictError("Session not found");
    if (TERMINAL_TASK_SESSION_STATUSES.has(session.status)) {
      throw new RecoveryConflictError(
        "Cannot retry in a terminal session; use new-session mode",
      );
    }
    const sent = await this.sendToTaskAgent(
      taskId,
      sessionId,
      instruction,
      "validation_failed",
    );
    if (!sent) throw new Error("Failed to send retry instruction");
    if (planRevision) {
      await this.store.updateTask(taskId, { currentPlan: planRevision.plan });
    }
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      sessionId,
      eventType: "retry_turn_requested",
      summary: "Retry turn requested",
      data: {
        messageId: input.messageId,
        sessionId,
        mode,
        instruction: input.instruction,
        planRevisionId: planRevision?.id,
      },
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    await this.store.updateTask(taskId, { paused: false, status: "active" });
    return this.getTask(taskId);
  }

  async rerunFromEvent(
    taskId: string,
    input: RerunFromEventInput,
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const planRevision = findPlanRevision(doc, input.planRevisionId);
    if (input.planRevisionId && !planRevision) {
      throw new RecoveryConflictError("Plan revision not found");
    }
    if (input.preserveHistory === false) {
      throw new RecoveryConflictError(
        "Destructive rerun is not supported; preserveHistory must be true",
      );
    }
    const event = doc.events.find((item) => item.id === input.eventId);
    if (!event) throw new RecoveryConflictError("Source event not found");
    if (input.stopActive === true) await this.stopActiveSessions(doc);
    if (planRevision) {
      await this.store.updateTask(taskId, { currentPlan: planRevision.plan });
    }
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      sessionId: event.sessionId,
      eventType: "rerun_from_event_requested",
      summary: "Rerun from event requested",
      data: {
        eventId: input.eventId,
        stopActive: input.stopActive === true,
        instruction: input.instruction,
        planRevisionId: planRevision?.id,
      },
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    await this.store.updateTask(taskId, { paused: false, status: "active" });
    await this.spawnAgentForTask(taskId, {
      ...input.agent,
      task: withPlanRevisionContext(
        rerunInstruction(event, input.instruction),
        planRevision,
      ),
    });
    return this.getTask(taskId);
  }

  async restartTask(
    taskId: string,
    input: RestartTaskInput = {},
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const planRevision = findPlanRevision(doc, input.planRevisionId);
    if (input.planRevisionId && !planRevision) {
      throw new RecoveryConflictError("Plan revision not found");
    }
    const instruction = withPlanRevisionContext(
      input.instruction?.trim() ||
        "Restart this task from the current durable context. Reinspect the task timeline, then continue until the goal is met or you are blocked.",
      planRevision,
    );
    await this.spawnAgentForTask(taskId, {
      ...input.agent,
      task: instruction,
    });
    if (input.stopActive !== false) await this.stopActiveSessions(doc);
    if (planRevision) {
      await this.store.updateTask(taskId, { currentPlan: planRevision.plan });
    }
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      eventType: "restart_requested",
      summary: "Task restart requested",
      data: {
        stopActive: input.stopActive !== false,
        instruction: input.instruction,
        planRevisionId: planRevision?.id,
      },
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    await this.store.updateTask(taskId, {
      paused: false,
      archived: false,
      archivedAt: null,
      closedAt: null,
      status: "active",
    });
    return this.getTask(taskId);
  }

  async restartWithEditedPlan(
    taskId: string,
    input: RestartWithEditedPlanInput,
  ): Promise<TaskThreadDetailDto | null> {
    const revision = await this.createPlanRevision(taskId, {
      plan: input.plan,
      basePlanRevisionId: input.basePlanRevisionId,
      editSummary: input.editSummary,
      createdBy: "operator",
      makeCurrent: false,
    });
    if (!revision) return null;
    return this.restartTask(taskId, {
      ...input,
      planRevisionId: revision.id,
      instruction:
        input.instruction ??
        input.editSummary ??
        "Restart with the edited plan revision.",
    });
  }

  async listMessages(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<TaskMessageDto> | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const page = paginate(doc.messages, opts);
    return { ...page, items: page.items.map(toTaskMessageDto) };
  }

  async listEvents(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<TaskEventDto> | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const page = paginate(doc.events, opts);
    return { ...page, items: page.items.map(toTaskEventDto) };
  }

  async listTimeline(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<TaskTimelineItemDto> | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    return paginate(
      [
        ...doc.messages.map(toTaskTimelineMessageDto),
        ...doc.events.map(toTaskTimelineEventDto),
      ],
      opts,
    );
  }

  async getUsage(taskId: string): Promise<TaskUsageSummary | null> {
    const doc = await this.store.getTask(taskId);
    return doc ? summarizeUsage(doc) : null;
  }

  // ---- sub-agent control -------------------------------------------------

  async spawnAgentForTask(
    taskId: string,
    opts: SpawnAgentForTaskOptions = {},
  ): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    // Nested-spawn guard: a sub-agent can spawn its own children, but only up to
    // a bounded depth so a misbehaving agent can't self-spawn without limit.
    const nestingDepth = opts.nestingDepth ?? 0;
    const maxNestingDepth = ((): number => {
      const raw = Number(process.env.ELIZA_ACP_MAX_NESTING_DEPTH);
      return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
    })();
    if (nestingDepth > maxNestingDepth) {
      throw new Error(
        `sub-agent nesting depth ${nestingDepth} exceeds the max of ${maxNestingDepth} (raise ELIZA_ACP_MAX_NESTING_DEPTH to allow deeper nesting)`,
      );
    }
    const acp = this.acp();
    if (!acp) throw new Error("ACP service unavailable");
    const workdir = opts.workdir
      ? await resolveAllowedWorkdir(opts.workdir)
      : undefined;

    const policy = doc.task.providerPolicy ?? {};
    // Give every sub-agent a distinct person-name. An explicit caller label
    // wins; otherwise pick a pooled name unique among the task's live sibling
    // sessions and distinct from the running agent. The same name is used as the
    // session label AND woven into the goal prompt so the agent knows who it is.
    const agentName = assignAgentName({
      explicitLabel: opts.label,
      activeNames: activeSessionNames(doc.sessions),
      mainAgentName: this.runtime.character?.name,
    });
    // Opt a task into a wider capability fence (e.g. the monetized-app
    // economics commands) via `metadata.capabilityProfile`. Unset → the
    // coding-only default fence.
    const capabilityProfile = coerceGoalCapabilityProfile(
      doc.task.metadata?.capabilityProfile,
    );
    const goalPrompt = buildGoalPrompt({
      agentName,
      goal: doc.task.goal,
      task: opts.task ?? doc.task.goal,
      acceptanceCriteria: doc.task.acceptanceCriteria,
      taskRoomId: doc.task.taskRoomId ?? doc.task.roomId,
      workdir,
      repo: opts.repo,
      // Replay prior failed-verification post-mortems so a re-spawn of this task
      // doesn't repeat them (#8899).
      attemptReflections: readAttemptReflections(doc.task.metadata),
      ...(capabilityProfile ? { capabilityProfile } : {}),
    });

    // Economics tasks drive the monetized-app loop through the parent-agent
    // Cloud command broker. Write a SKILLS.md into the workdir that advertises
    // the broker slug + its arg contract so the spawned agent knows how to call
    // back (the dispatcher in SubAgentRouter executes those requests).
    if (capabilityProfile === "economics" && workdir) {
      try {
        const manifest = await buildSkillsManifest(this.runtime, {
          recommendedSlugs: ["build-monetized-app", "eliza-cloud"],
          virtualSkills: [{ ...PARENT_AGENT_BROKER_MANIFEST_ENTRY }],
          // Economics tasks may deploy Cloud views — teach the sub-agent the
          // ViewKind contract so views are categorized correctly. (#8917)
          includeViewKindContract: true,
        });
        await writeFile(join(workdir, "SKILLS.md"), manifest.markdown, "utf8");
      } catch (err) {
        // error-policy:J7 SKILLS.md scaffolding is best-effort; a failed write is
        // warned and the spawn proceeds without it.
        this.runtime.logger?.warn?.(
          { src: "orchestrator-task-service", taskId, workdir },
          `failed to write SKILLS.md: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const result = await acp.spawnSession({
      // Coding-agent selection: explicit request → routing policy → the
      // deployment's configured default (ELIZA_ACP_DEFAULT_AGENT /
      // ELIZA_DEFAULT_AGENT_TYPE — e.g. "elizaos" for the eliza-code coding
      // sub-agent) → opencode as the safe fallback. Honoring the configured
      // default here keeps this spawn path consistent with acp-service's
      // `defaultAgent`; previously this hardcoded "opencode" because elizaos had
      // no ACP command, but elizaos is now a supported ACP agent via
      // ELIZA_ELIZAOS_ACP_COMMAND, so a host that selects it (local or cloud
      // image) gets eliza-code, while unconfigured hosts still get opencode.
      agentType:
        opts.framework ??
        policy.preferredFramework ??
        configuredDefaultAgentType(this.runtime) ??
        "opencode",
      workdir,
      initialTask: goalPrompt,
      model: opts.model ?? policy.model,
      approvalPreset: opts.approvalPreset,
      metadata: {
        taskId,
        roomId: doc.task.taskRoomId ?? doc.task.roomId,
        label: agentName,
        source: "orchestrator",
        // Persist the bare goal (the same key the direct-API spawn stamps) so
        // completion-time consumers that read the task text off session
        // metadata — the built-apps registry's app-build gate, interruption
        // relevance — see what this session is building.
        goal: doc.task.goal,
        // Orchestrator sessions outlive their first prompt so follow-ups and
        // validation re-dispatch can reuse them.
        keepAliveAfterComplete: true,
        // Carried so a child this sub-agent spawns can compute its own depth
        // (parent depth + 1) and the nesting guard above can enforce the cap.
        nestingDepth,
      },
    });

    const account = accountMetaFromSessionMetadata(
      result.metadata as Record<string, unknown> | undefined,
    );
    const ts = nowIso();
    const session: OrchestratorTaskSession = {
      id: randomUUID(),
      taskId,
      sessionId: result.sessionId,
      framework: result.agentType,
      providerSource: opts.providerSource ?? policy.providerSource,
      model: opts.model ?? policy.model,
      ...(account
        ? {
            accountProviderId: account.providerId,
            accountId: account.accountId,
            accountLabel: account.label,
          }
        : {}),
      label: agentName,
      originalTask: opts.task ?? doc.task.goal,
      goalPrompt,
      workdir: result.workdir,
      repo: opts.repo,
      status: result.status,
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: Date.now(),
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      taskDelivered: false,
      lastSeenDecisionIndex: 0,
      spawnedAt: Date.now(),
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      metadata: {},
      createdAt: ts,
      updatedAt: ts,
    };
    // The ACP spawn above already SUCCEEDED — the session is live and doing
    // work. Everything from here on is durable book-keeping. If the store is
    // degraded (e.g. #11641's pglite lookup failure) a throw here would bubble
    // a 500 to `POST /tasks/{id}/agents` even though the spawn worked, making
    // API consumers think it failed and possibly double-spawn. So record the
    // session best-effort and, on failure, still return a coherent detail that
    // reflects the live session instead of throwing.
    // Seed the in-memory index unconditionally so `resolveTaskId` resolves this
    // session's events even if the durable write below degrades.
    this.sessionTaskIndex.set(result.sessionId, taskId);
    try {
      await this.store.addSession(session);
      await this.advanceTaskStatus(taskId, "active");
      return this.getTask(taskId);
    } catch (err) {
      // error-policy:J4 the ACP spawn already succeeded (session is live); a
      // failed durable write degrades to a truthful live-session detail below,
      // never a false 500/404.
      this.log("warn", "spawn succeeded but recording the session failed", {
        taskId,
        sessionId: result.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return a detail that includes the just-spawned session so the caller
      // sees a 2xx with the real session info. Prefer a fresh read (the
      // addSession may have partially landed); fall back to the pre-spawn doc
      // with the new session appended so the response is never a false 404.
      // error-policy:J4 a failed fresh read degrades to the designed pre-spawn
      // fallback below (doc + appended session), never a false 404.
      const refreshed = await this.getTask(taskId).catch(() => null);
      if (refreshed?.sessions?.some((s) => s.sessionId === result.sessionId)) {
        return refreshed;
      }
      return toTaskThreadDetail({
        ...doc,
        sessions: [...doc.sessions, session],
      });
    }
  }

  /**
   * Bind an ACP session that was spawned OUTSIDE `spawnAgentForTask` (e.g. the
   * `TASKS:create` chat action, which spawns via `AcpService.spawnSession`
   * directly and does its own multi-part label / prefix / model routing) into
   * an existing task thread's session index.
   *
   * Without this the task store's `sessionTaskIndex` never learns about those
   * sessions, so `resolveTaskId` returns undefined, the event bridge drops
   * their events, and DTOs read `0/0 agents` with no token attribution.
   *
   * Idempotent: attaching the same sessionId twice is a no-op (the store's
   * `addSession` also upserts by sessionId). If the task doesn't exist, returns
   * `false` — callers treat that as a soft failure, same policy as thread-mint
   * failure in the create action.
   *
   * Only advances the task status to `active` for a non-terminal session; a
   * session that's already `completed` / `stopped` / `error` on arrival gets
   * indexed for history + token attribution but doesn't lie about liveness.
   */
  async attachSession(
    taskId: string,
    input: AttachSessionInput,
  ): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    // Idempotent short-circuit — already indexed against THIS task.
    if (this.sessionTaskIndex.get(input.sessionId) === taskId) {
      const existing = doc.sessions.find(
        (s) => s.sessionId === input.sessionId,
      );
      if (existing) return true;
    }
    const account = accountMetaFromSessionMetadata(input.metadata);
    const ts = nowIso();
    const now = Date.now();
    const originalTask = input.originalTask ?? doc.task.goal;
    const session: OrchestratorTaskSession = {
      id: randomUUID(),
      taskId,
      sessionId: input.sessionId,
      framework: input.agentType,
      ...(input.providerSource ? { providerSource: input.providerSource } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(account
        ? {
            accountProviderId: account.providerId,
            accountId: account.accountId,
            accountLabel: account.label,
          }
        : {}),
      label: input.label ?? input.sessionId,
      originalTask,
      ...(input.goalPrompt ? { goalPrompt: input.goalPrompt } : {}),
      workdir: input.workdir,
      ...(input.repo ? { repo: input.repo } : {}),
      status: input.status,
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: now,
      lastActivityAt: now,
      idleCheckCount: 0,
      taskDelivered: false,
      lastSeenDecisionIndex: 0,
      spawnedAt: now,
      ...(TERMINAL_TASK_SESSION_STATUSES.has(input.status)
        ? { stoppedAt: now }
        : {}),
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      metadata: {},
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.addSession(session);
    this.sessionTaskIndex.set(input.sessionId, taskId);
    // Only claim liveness if the session actually is live — a terminal-on-
    // arrival session (chat action's runPromptAndClose already stopped it) gets
    // indexed for history + future token attribution without falsely promoting
    // task status.
    if (!TERMINAL_TASK_SESSION_STATUSES.has(input.status)) {
      await this.advanceTaskStatus(taskId, "active");
    }
    return true;
  }

  async sendToTaskAgent(
    taskId: string,
    sessionId: string,
    message: string,
    reason: GoalFollowUpReason = "user_message",
  ): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    const session = doc.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return false;
    const acp = this.acp();
    if (!acp) throw new Error("ACP service unavailable");

    const followUp = buildGoalFollowUp({
      goal: doc.task.goal,
      message,
      acceptanceCriteria: doc.task.acceptanceCriteria,
      reason,
      taskRoomId: doc.task.taskRoomId ?? doc.task.roomId,
    });
    await this.recordMessage(taskId, {
      content: message,
      senderKind: reason === "user_message" ? "user" : "orchestrator",
      sessionId,
      direction: "stdin",
    });
    await this.store.updateSession(sessionId, { lastInputSentAt: Date.now() });
    try {
      await acp.sendToSession(sessionId, followUp);
    } catch (err) {
      // error-policy:J2 mark the session send_failed for observability, then
      // rethrow the original failure so the caller sees it.
      await this.store.updateSession(sessionId, { status: "send_failed" });
      throw err;
    }
    return true;
  }

  async stopTaskAgent(taskId: string, sessionId: string): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    const session = doc.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return false;
    const acp = this.acp();
    if (!acp) {
      await this.store.updateSession(sessionId, { status: "stop_failed" });
      await this.store.updateTask(taskId, { status: "interrupted" });
      throw new Error("ACP service unavailable; cannot stop active session");
    }
    try {
      await acp.stopSession(sessionId);
    } catch (err) {
      // error-policy:J2 mark the session stop_failed for observability, then
      // rethrow the original failure so the caller sees it.
      await this.store.updateSession(sessionId, {
        status: "stop_failed",
      });
      throw err;
    }
    await this.store.updateSession(sessionId, {
      status: "stopped",
      stoppedAt: Date.now(),
    });
    return true;
  }

  // ---- aggregate ---------------------------------------------------------

  async getStatus(): Promise<OrchestratorStatus> {
    const records = await this.store.listTasks({ includeArchived: false });
    const docs = (
      await Promise.all(records.map((record) => this.store.getTask(record.id)))
    ).filter((doc): doc is OrchestratorTaskDocument => doc !== null);

    const byStatus = {
      open: 0,
      active: 0,
      waiting_on_user: 0,
      blocked: 0,
      validating: 0,
      done: 0,
      failed: 0,
      archived: 0,
      interrupted: 0,
    } satisfies Record<OrchestratorTaskStatus, number>;

    let sessionCount = 0;
    let activeSessionCount = 0;
    const usageRows: OrchestratorTaskUsage[] = [];

    for (const doc of docs) {
      byStatus[doc.task.status] += 1;
      sessionCount += doc.sessions.length;
      activeSessionCount += doc.sessions.filter(
        (s) => !TERMINAL_TASK_SESSION_STATUSES.has(s.status),
      ).length;
      usageRows.push(...doc.usage);
    }

    return {
      taskCount: docs.length,
      activeTaskCount: byStatus.active,
      pausedTaskCount: docs.filter((doc) => doc.task.paused).length,
      blockedTaskCount: byStatus.blocked + byStatus.waiting_on_user,
      validatingTaskCount: byStatus.validating,
      sessionCount,
      activeSessionCount,
      usage: usageRows.length > 0 ? summarizeUsageRows(usageRows) : EMPTY_USAGE,
      byStatus,
    };
  }

  async getAccountOverview(): Promise<OrchestratorAccountOverview> {
    const records = await this.store.listTasks({ includeArchived: false });
    const docs = (
      await Promise.all(records.map((record) => this.store.getTask(record.id)))
    ).filter((doc): doc is OrchestratorTaskDocument => doc !== null);

    const assignments: OrchestratorAccountAssignment[] = [];
    for (const doc of docs) {
      for (const session of doc.sessions) {
        if (!session.accountId || !session.accountProviderId) continue;
        assignments.push({
          taskId: doc.task.id,
          taskTitle: doc.task.title,
          sessionId: session.sessionId,
          label: session.label,
          framework: session.framework,
          status: session.status,
          active: !TERMINAL_TASK_SESSION_STATUSES.has(session.status),
          accountProviderId: session.accountProviderId,
          accountId: session.accountId,
          accountLabel: session.accountLabel ?? session.accountId,
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          reasoningTokens: session.reasoningTokens,
          cacheTokens: session.cacheTokens,
          // totalTokens excludes cache (reported separately as cacheTokens) to
          // match TaskSessionDto/summarizeUsageRows — same field, same math.
          totalTokens:
            session.inputTokens +
            session.outputTokens +
            session.reasoningTokens,
          costUsd: session.costUsd,
          usageState: session.usageState,
        });
      }
    }

    const rawStrategy = this.runtime.getSetting?.(
      "ELIZA_CODING_ACCOUNT_STRATEGY",
    );
    const strategy =
      resolveCodingAccountStrategy(
        typeof rawStrategy === "string" ? rawStrategy : undefined,
      ) ?? "least-used";
    const availability = getCodingAccountBridge()?.describe() ?? {};

    return { strategy, availability, assignments };
  }

  /**
   * Loud readiness gate for the multi-account orchestrator: asserts the pool
   * has ≥1 healthy Codex AND ≥1 healthy Claude (≥2 each with `rotation`).
   * Unlike the per-spawn `selectCodingAccount` — which silently single-account
   * falls back so a thin pool never hard-fails a spawn — this is meant to fail
   * loudly (a CI/ops check + a 503 route) so a misconfigured pool is caught.
   */
  getAccountReadiness(
    opts: { rotation?: boolean } = {},
  ): CodingAccountReadiness {
    const availability = getCodingAccountBridge()?.describe() ?? {};
    return assessCodingAccountReadiness(availability, opts);
  }

  /**
   * Per-room participant roster: groups live sessions by their task room and
   * lists the orchestrator + owning user + each sub-agent (with its pooled
   * account). The accounts overview is a flat global map; this is the
   * room-scoped view the task-room sidebar renders. Only rooms with at least
   * one sub-agent session are included (an empty room has no roster to show).
   */
  async getRoomRoster(): Promise<OrchestratorRoomRosterOverview> {
    const records = await this.store.listTasks({ includeArchived: false });
    const docs = (
      await Promise.all(records.map((record) => this.store.getTask(record.id)))
    ).filter((doc): doc is OrchestratorTaskDocument => doc !== null);

    const orchestratorLabel = this.runtime.character?.name ?? "Orchestrator";
    const rooms: OrchestratorRoomRoster[] = [];

    for (const doc of docs) {
      if (doc.sessions.length === 0) continue;

      const subAgents: OrchestratorRoomParticipant[] = doc.sessions.map(
        (session) => ({
          kind: "sub_agent" as const,
          id: session.sessionId,
          label: session.label,
          framework: session.framework,
          status: session.status,
          active: !TERMINAL_TASK_SESSION_STATUSES.has(session.status),
          activeTool: session.activeTool,
          accountProviderId: session.accountProviderId,
          accountId: session.accountId,
          accountLabel: session.accountLabel ?? session.accountId,
          // Excludes cache, matching TaskSessionDto/assignment totalTokens.
          totalTokens:
            session.inputTokens +
            session.outputTokens +
            session.reasoningTokens,
          usageState: session.usageState,
        }),
      );
      const activeAgentCount = subAgents.filter((p) => p.active).length;

      const participants: OrchestratorRoomParticipant[] = [
        { kind: "orchestrator", id: "orchestrator", label: orchestratorLabel },
      ];
      if (doc.task.ownerUserId) {
        participants.push({
          kind: "user",
          id: doc.task.ownerUserId,
          label: doc.task.ownerUserId,
        });
      }
      participants.push(...subAgents);

      rooms.push({
        taskId: doc.task.id,
        taskTitle: doc.task.title,
        status: doc.task.status,
        roomId: doc.task.roomId,
        taskRoomId: doc.task.taskRoomId,
        activeAgentCount,
        multiParty: activeAgentCount > 1,
        participants,
      });
    }

    rooms.sort((a, b) => b.activeAgentCount - a.activeAgentCount);
    return { rooms };
  }

  async pauseAll(): Promise<number> {
    const records = await this.store.listTasks({ includeArchived: false });
    let paused = 0;
    for (const record of records) {
      if (TERMINAL_TASK_STATUSES.has(record.status) || record.paused) continue;
      await this.pauseTask(record.id);
      paused += 1;
    }
    return paused;
  }

  async resumeAll(): Promise<number> {
    const records = await this.store.listTasks({ includeArchived: false });
    let resumed = 0;
    for (const record of records) {
      if (!record.paused) continue;
      await this.resumeTask(record.id);
      resumed += 1;
    }
    return resumed;
  }

  // ---- internals ---------------------------------------------------------

  private async stopActiveSessions(
    doc: OrchestratorTaskDocument,
  ): Promise<void> {
    const active = doc.sessions.filter(
      (s) => !TERMINAL_TASK_SESSION_STATUSES.has(s.status),
    );
    if (active.length === 0) return;
    const acp = this.acp();
    if (!acp) {
      await Promise.all(
        active.map((session) =>
          this.store.updateSession(session.sessionId, {
            status: "stop_failed",
          }),
        ),
      );
      await this.store.updateTask(doc.task.id, { status: "interrupted" });
      throw new RecoveryConflictError(
        "ACP service unavailable; cannot stop active sessions",
      );
    }
    const failures: Array<{ sessionId: string; error: string }> = [];
    await Promise.all(
      active.map(async (session) => {
        try {
          await acp.stopSession(session.sessionId);
        } catch (err) {
          // error-policy:J1 collect per-session stop failures; the loop throws a
          // structured RecoveryConflictError afterward when any session failed.
          const error = err instanceof Error ? err.message : String(err);
          failures.push({ sessionId: session.sessionId, error });
          await this.store.updateSession(session.sessionId, {
            status: "stop_failed",
          });
          return;
        }
        await this.store.updateSession(session.sessionId, {
          status: "stopped",
          stoppedAt: Date.now(),
        });
      }),
    );
    if (failures.length > 0) {
      await this.store.updateTask(doc.task.id, { status: "interrupted" });
      throw new RecoveryConflictError(
        `Failed to stop ${failures.length} active session${
          failures.length === 1 ? "" : "s"
        }`,
      );
    }
  }

  private acp(): AcpService | undefined {
    return (
      this.runtime.getService<AcpService>(AcpService.serviceType) ?? undefined
    );
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void {
    this.runtime.logger?.[level]?.(
      `[OrchestratorTaskService] ${message}`,
      data,
    );
  }
}

function paginate<T extends { timestamp: number }>(
  items: T[],
  opts: { limit?: number; cursor?: string },
): PageResult<T> {
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 100;
  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const start = opts.cursor
    ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0)
    : 0;
  const page = sorted.slice(start, start + limit);
  const nextIndex = start + limit;
  return {
    items: page,
    nextCursor: nextIndex < sorted.length ? String(nextIndex) : null,
  };
}
