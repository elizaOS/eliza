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
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  getTrajectoryContext,
  type IAgentRuntime,
  projectWorldId,
  type RecordedTrajectory,
  resolveStateDir,
  resolveTrajectoryGate,
  rollUpTrajectoryUsage,
  Service,
  TRACE_ENV,
  type TrajectoryUsageRollup,
} from "@elizaos/core";
import {
  detectTaskType,
  generateDefaultAcceptanceCriteria,
  isNonTrivialGoal,
  type OrchestratorTaskType,
  shouldRequireGoalContract,
} from "./acceptance-criteria.js";
import { AcpService } from "./acp-service.js";
import {
  type AdmissionRecord,
  orderQueue,
  type QueueEntry,
  type SerializableSpawnOpts,
} from "./admission-queue.js";
import { assignAgentName } from "./agent-name-assignment.js";
import {
  accountMetaFromSessionMetadata,
  assessCodingAccountReadiness,
  type CodingAccountReadiness,
  classifyAccountFailure,
  getCodingAccountBridge,
  hasHealthyPooledAccount,
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
  MAX_ATTEMPT_REFLECTIONS,
  MAX_SESSION_RETRY_ATTEMPTS,
  nextTaskStatus,
  type OrchestratorAccountAssignment,
  type OrchestratorAccountOverview,
  type OrchestratorRoomParticipant,
  type OrchestratorRoomRoster,
  type OrchestratorRoomRosterOverview,
  type OrchestratorTaskDocument,
  type OrchestratorTaskPriority,
  type OrchestratorTaskRecord,
  type OrchestratorTaskSession,
  type OrchestratorTaskStatus,
  type OrchestratorTaskUsage,
  RETRY_BUDGET_EPOCH_METADATA_KEY,
  readRetryBudgetEpoch,
  resolveStateLostRespawnCap,
  resolveTaskTransition,
  stateLostRespawnUnderCap,
  type TaskLifecycleTrigger,
  type TaskListFilter,
  type TaskMessageDirection,
  type TaskMessageSenderKind,
  type TaskUsageSummary,
  TERMINAL_TASK_SESSION_STATUSES,
  TERMINAL_TASK_STATUSES,
  type UsageState,
} from "./orchestrator-task-types.js";
import {
  isParentAgentBrokerWired,
  PARENT_AGENT_BROKER_MANIFEST_ENTRY,
} from "./parent-agent-broker.js";
import {
  resolveBoundProjectCloudAppId,
  resolveTaskProjectId,
  resolveTaskSpawnWorkdir,
} from "./project-binding.js";
import { buildSkillsManifest } from "./skill-manifest.js";
import {
  configureSpendLedger,
  createTaskStoreSpendLedger,
} from "./spend-allowance.js";
import {
  AdmissionQueueFullError,
  type ApprovalPreset,
  SessionCapError,
  type SpawnResult,
  TERMINAL_SESSION_STATUSES,
} from "./types.js";
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

export interface TraceUsageArtifactError {
  path: string;
  reason: "read_failed" | "invalid_trajectory";
  message: string;
}

export interface TaskTraceUsageRollup extends TrajectoryUsageRollup {
  readState: "complete" | "partial";
  artifactCount: number;
  readableArtifactCount: number;
  unreadableArtifactCount: number;
  artifactErrors: TraceUsageArtifactError[];
}

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

/** Cap on child trajectories ingested per task_complete (#13775) so a runaway
 *  sub-agent can't flood the task doc; the store's MAX_ARTIFACTS also clamps. */
const MAX_CHILD_TRAJECTORY_ARTIFACTS = 20;

/** Default retention window for per-task child-trajectory dirs under the state
 *  dir (#14109). A per-task `<stateDir>/orchestrator/child-trajectories/<taskId>`
 *  dir is attach-by-reference (ingest never deletes its files), so without an
 *  aged reclaim it grows unbounded — the same disk-leak class as the 3.6TB
 *  worktree-farm incident (#13773), just relocated into the state dir. Reclaimed
 *  only once the owning task is terminal (or absent) AND the dir has been idle
 *  past this window, so an in-flight or not-yet-ingested trajectory is never
 *  deleted. 24h mirrors ACP_SCRATCH_GC_MAX_AGE_MS. Overridable via
 *  `ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS`. */
const CHILD_TRAJECTORY_GC_MAX_AGE_MS = 24 * 60 * 60_000;

/** Default upper bound on how long the independent verifier session may run
 *  before its await is abandoned (treated as inconclusive). Overridable via
 *  `ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY_TIMEOUT_MS`. */
const DEFAULT_INDEPENDENT_VERIFY_TIMEOUT_MS = 600_000;

/** Cadence of the admission-queue reconcile tick. Backstops the terminal-event
 * drain for slots freed silently (a swept-stale session emits no event). */
const ADMISSION_RECONCILE_INTERVAL_MS = 30_000;

/** Session events after which a worker slot may have freed, so the admission
 * queue should drain. Mirrors AcpService's terminal-status set. */
const ADMISSION_DRAIN_EVENTS: ReadonlySet<string> = new Set([
  "task_complete",
  "stopped",
  "error",
]);

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
  /**
   * Internal: the admission-queue drain sets this false so a cap race during a
   * replayed dispatch RETHROWS SessionCapError instead of self-parking. The
   * drain then re-parks the task at the head with its ORIGINAL admission record
   * (seniority + aging preserved); self-parking here would mint a fresh
   * enqueuedAt and push the task to the back of its band.
   */
  parkOnCap?: boolean;
}

/**
 * Descriptor for an already-spawned ACP session that we want to bind to an
 * existing task thread. Only what the attach path genuinely needs: identity,
 * workdir and status from the spawn, plus caller context that is not
 * discoverable from the SpawnResult.
 */
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

/** Sub-agent session statuses that mean the session died from an unrecoverable
 * fault (an `error` event), as opposed to a clean `stopped`/`completed` or an
 * operator-driven `send_failed`/`stop_failed`. Only these count against the
 * task's crash-retry budget in
 * {@link OrchestratorTaskService.advanceTaskOnSessionError}. */
const SESSION_ERROR_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "errored",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const ADMISSION_PRIORITIES: readonly OrchestratorTaskPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

function isAdmissionPriority(
  value: unknown,
): value is OrchestratorTaskPriority {
  return ADMISSION_PRIORITIES.includes(value as OrchestratorTaskPriority);
}

// Every SerializableSpawnOpts field is an optional string, so a persisted value
// is a valid spawn-opts payload iff each present key is a string.
function isSerializableSpawnOpts(
  value: unknown,
): value is SerializableSpawnOpts {
  if (!isRecord(value)) return false;
  for (const key of [
    "framework",
    "model",
    "workdir",
    "repo",
    "label",
    "task",
    "approvalPreset",
    "providerSource",
  ] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") return false;
  }
  return true;
}

/** Structural guard for a durable admission record read back off task metadata,
 * replacing the former `as unknown as AdmissionRecord` double cast with a real
 * narrowing so a malformed persisted payload is rejected instead of trusted. */
function isAdmissionRecord(value: unknown): value is AdmissionRecord {
  return (
    isRecord(value) &&
    value.state === "queued" &&
    typeof value.enqueuedAt === "string" &&
    isAdmissionPriority(value.priorityAtEnqueue) &&
    isSerializableSpawnOpts(value.spawnOpts)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a positive-integer setting value, falling back to `fallback` when the
 * value is absent, non-numeric, or ≤ 0. Used for the admission-queue tunables. */
function parsePositiveIntSetting(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  private readonly taskWorkdirBindQueues = new Map<string, Promise<void>>();
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
  // Admission queue (#13772): taskIds parked because the worker cap was full.
  // The durable truth is each task's `metadata.admission` record; this array is
  // the in-memory dispatch order, rebuilt from the store on start(). Ordering is
  // recomputed at drain time (priority band + aging), so insertion order here is
  // not authoritative — membership is.
  private readonly admissionQueue: string[] = [];
  // Serializes drainAdmissionQueue so a terminal-event drain and the reconcile
  // tick can't both dispatch the same parked task. A promise-chain mutex.
  private admissionDrainLock = Promise.resolve();
  private admissionReconcileTimer: NodeJS.Timeout | undefined;

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
    // Reclaim aged per-task child-trajectory dirs under the state dir (#14109).
    // Ingest attaches by reference and never deletes, and no workspace-GC path
    // reaches the state dir, so without this the dir grows without bound. Runs
    // once at start, after the store is wired; best-effort so a sweep hiccup
    // never blocks service start (below).
    void this.gcChildTrajectoryDirs().catch((err) => {
      // error-policy:J7 startup GC is a disk-hygiene convenience; a failure is
      // reported (the leak stays observable) but must not abort service start.
      this.runtime.reportError?.(
        "OrchestratorTask.gcChildTrajectoryDirs",
        err,
        {},
      );
    });
    // Resume any tasks parked before a restart, then arm the reconcile tick that
    // drains the queue even when no terminal session event fires (a sweptStale
    // session frees a slot silently). Best-effort: a store hiccup here must not
    // block session-event binding below.
    if (this.admissionQueueEnabled()) {
      await this.rebuildAdmissionQueueFromStore().catch((err) => {
        // error-policy:J7 admission-queue rebuild is a start-time convenience; a
        // failure is reported (parked tasks won't auto-resume until a live
        // enqueue re-seeds them) but must not abort service start.
        this.runtime.reportError(
          "OrchestratorTask.rebuildAdmissionQueue",
          err,
          {},
        );
      });
      this.admissionReconcileTimer = setInterval(() => {
        void this.drainAdmissionQueue();
      }, ADMISSION_RECONCILE_INTERVAL_MS);
      this.admissionReconcileTimer.unref?.();
    }
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
    if (this.admissionReconcileTimer) {
      clearInterval(this.admissionReconcileTimer);
      this.admissionReconcileTimer = undefined;
    }
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
        await this.advanceTaskStatus(taskId, "session_active");
        break;
      case "tool_running": {
        const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
        await this.store.updateSession(sessionId, {
          status: "tool_running",
          activeTool: str(toolCall.title) ?? str(toolCall.kind),
        });
        await this.advanceTaskStatus(taskId, "session_active");
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
        await this.advanceTaskStatus(taskId, "session_blocked");
        break;
      case "login_required":
        await this.store.updateSession(sessionId, { status: "blocked" });
        await this.advanceTaskStatus(taskId, "awaiting_user");
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
        // Attach the sub-agent's own recorded trajectories (its inner model
        // prompts/responses) as task artifacts under the shared traceId (#13775).
        // error-policy:J7 diagnostics-must-not-kill-the-loop — trace ingest is
        // observability; a failure is reported but must not block task validation.
        try {
          await this.ingestChildTrajectories(taskId, sessionId);
        } catch (err) {
          this.runtime.reportError?.(
            "OrchestratorTaskService.ingestChildTrajectories",
            err,
            { taskId, sessionId },
          );
        }
        await this.advanceTaskStatus(taskId, "completion_reported");
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
        // A late error for a session that already delivered its result is a
        // teardown race (the process dropped its state AFTER task_complete
        // posted), not a work failure — the router suppresses its respawn for
        // exactly this case (router-loop-guard `state_lost` completion claim).
        // It must not overwrite the `completed` session record with `errored`,
        // inflate the crash-retry budget, or knock a `validating` task back to
        // `active` mid-verification (that aborts validateTask — status is no
        // longer `validating` — and wedges the task with no live worker). The
        // raw event is already on the task timeline via recordSessionEvent.
        const prior = (await this.store.findSession(sessionId))?.session;
        if (prior?.status === "completed") break;
        await this.store.updateSession(sessionId, {
          status: "errored",
          stoppedAt: Date.now(),
        });
        await this.advanceTaskOnSessionError(taskId, sessionId, {
          failureKind,
          message,
        });
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
    // A terminal session event frees (or may free) a worker slot. Kick the
    // admission drain so a parked task dispatches the instant a slot opens,
    // rather than waiting on the 30s reconcile tick. Fire-and-forget: the drain
    // is serialized internally and never rejects into this write path.
    if (ADMISSION_DRAIN_EVENTS.has(event) && this.admissionQueueEnabled()) {
      void this.drainAdmissionQueue();
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
   * Root under the state dir holding every task's child-trajectory dir (#13775),
   * i.e. `<stateDir>/orchestrator/child-trajectories`. Swept by
   * {@link gcChildTrajectoryDirs} on start (#14109).
   */
  private childTrajectoriesRoot(): string {
    return join(resolveStateDir(), "orchestrator", "child-trajectories");
  }

  /**
   * Per-task directory a spawned sub-agent's file recorder writes its own
   * trajectories into (#13775), scanned on task_complete.
   *
   * NOTE (#14109): this lives under the state dir, NOT a workspace scratch root,
   * so `AcpService.gcOrphanedScratchDirs` (which only scans configured workspace
   * roots) never reclaims it, and ingest is attach-by-reference (the JSON files
   * are never deleted after being attached). Reclamation is therefore explicit,
   * via {@link gcChildTrajectoryDirs}, an age-gated startup sweep of
   * {@link childTrajectoriesRoot}.
   */
  private childTrajectoryDir(taskId: string): string {
    return join(this.childTrajectoriesRoot(), taskId);
  }

  /**
   * Bounded retention for the child-trajectory state dir (#14109). A per-task
   * `<stateDir>/orchestrator/child-trajectories/<taskId>` dir is written by a
   * sub-agent's recorder and attached by reference on task_complete — the files
   * are never deleted after ingest, and no workspace-GC path reaches the state
   * dir. Left unchecked it grows without bound (the disk-leak class #13773
   * exists to prevent, relocated into the state dir).
   *
   * Runs once at startup (mirroring `AcpService.cleanOrphanedScratchWorkdirs`).
   * For each per-task dir it reclaims ONLY when BOTH hold:
   *  - the owning task is terminal in this store, OR has no task doc at all
   *    (an orphan left by a crashed/purged task) — a live task keeps its dir; and
   *  - the dir has been idle (newest entry's mtime) past the retention window.
   *
   * The age gate is the load-bearing safety: a not-yet-ingested or in-flight
   * trajectory is recent by construction, so it is never deleted even if its
   * task doc looks terminal (e.g. a respawned session still writing). Deletes
   * are best-effort; a locked/vanished dir is skipped and retried next boot.
   */
  private async gcChildTrajectoryDirs(): Promise<void> {
    const root = this.childTrajectoriesRoot();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      // error-policy:J3 an absent root is the expected empty shape (no task has
      // ever recorded a child trajectory) — explicit zero-work result, never a
      // masked read failure.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.runtime.reportError?.(
        "OrchestratorTaskService.gcChildTrajectoryDirs",
        err,
        { phase: "readdir", root },
      );
      return;
    }

    const maxAgeMs = parsePositiveIntSetting(
      this.readSetting("ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS"),
      CHILD_TRAJECTORY_GC_MAX_AGE_MS,
    );
    const now = Date.now();
    let reclaimed = 0;
    let kept = 0;

    await Promise.allSettled(
      entries.map(async (taskId) => {
        const path = join(root, taskId);
        try {
          const st = await stat(path);
          if (!st.isDirectory()) {
            kept++;
            return;
          }
        } catch {
          // error-policy:J6 vanished mid-scan — nothing left to reclaim.
          return;
        }

        // A live (non-terminal) task is still producing trajectories under this
        // dir — never reclaim it. An absent task doc is an orphan (its task was
        // purged/never persisted): reclaimable, but still age-gated below so a
        // dir a brand-new task is actively writing isn't yanked out from under
        // it before its doc lands.
        let taskIsReclaimable: boolean;
        try {
          const doc = await this.store.getTask(taskId);
          taskIsReclaimable =
            !doc || TERMINAL_TASK_STATUSES.has(doc.task.status);
        } catch (err) {
          // error-policy:J7 DATA-LOSS GUARD. A store read failure must not be
          // read as "no task" — that would treat a live task's dir as an orphan
          // and delete work. Keep the dir; the next boot retries with real data.
          this.runtime.reportError?.(
            "OrchestratorTaskService.gcChildTrajectoryDirs",
            err,
            { phase: "store.getTask", taskId },
          );
          kept++;
          return;
        }
        if (!taskIsReclaimable) {
          kept++;
          return;
        }

        // Age gate: newest mtime across the dir tree (the recorder nests files
        // under an <agentId>/ subdir). A trajectory written since the retention
        // window — i.e. possibly not yet ingested, or from a respawned session
        // still running — keeps the whole dir. Fall back to the dir's own mtime
        // for an empty dir.
        let newestMtimeMs = 0;
        try {
          const rel = await readdir(path, { recursive: true });
          const stats = await Promise.all(
            rel.map((p) =>
              stat(join(path, p)).then(
                (s) => s.mtimeMs,
                () => 0,
              ),
            ),
          );
          newestMtimeMs = stats.reduce((max, m) => Math.max(max, m), 0);
          if (newestMtimeMs === 0) {
            newestMtimeMs = (await stat(path)).mtimeMs;
          }
        } catch {
          // error-policy:J6 vanished mid-scan — nothing left to reclaim.
          return;
        }
        if (now - newestMtimeMs <= maxAgeMs) {
          kept++;
          return;
        }

        try {
          await rm(path, { recursive: true, force: true });
          reclaimed++;
        } catch (err) {
          // error-policy:J6 best-effort GC; a locked/vanished dir is skipped so
          // the sweep continues and retries next boot.
          this.log("warn", "child-trajectory GC: failed to remove dir", {
            taskId,
            path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    if (reclaimed > 0 || kept > 0) {
      this.log("info", "reclaimed aged child-trajectory dirs", {
        reclaimed,
        kept,
        root,
        olderThanMs: maxAgeMs,
      });
    }
  }

  /**
   * The trace-correlation env stamped onto a spawned sub-agent (#13775). Carries
   * the parent turn's traceId + parent step so the child's self-recorded
   * trajectories join the parent's trace, and — only when the shared gate is on
   * — points the child recorder at {@link childTrajectoryDir}. The trajectory
   * flag is ALWAYS set explicitly ("1"/"0") so the broad ELIZA_ env forwarding
   * in AcpService never leaks the parent's value ambiguously.
   */
  private buildChildTraceEnv(taskId: string): Record<string, string> {
    const ctx = getTrajectoryContext();
    const env: Record<string, string> = {
      [TRACE_ENV.TRACE_ID]: ctx?.traceId ?? randomUUID(),
      [TRACE_ENV.TASK_ID]: taskId,
    };
    if (ctx?.trajectoryStepId) {
      env[TRACE_ENV.PARENT_STEP_ID] = ctx.trajectoryStepId;
    }
    if (resolveTrajectoryGate().enabled) {
      env.ELIZA_TRAJECTORY_LOGGING = "1";
      env.ELIZA_TRAJECTORY_DIR = this.childTrajectoryDir(taskId);
    } else {
      env.ELIZA_TRAJECTORY_LOGGING = "0";
    }
    return env;
  }

  /**
   * On task_complete, attach the sub-agent's own recorded trajectories (elizaos
   * / pi-agent children self-record their inner model prompts/responses under
   * {@link childTrajectoryDir}) to the task as `trajectory` artifacts and record
   * their ids on the session (#13775). Attach-by-reference: the file stays where
   * the child wrote it; no normalize-and-copy. A missing or empty dir is a
   * legitimate empty result — a non-eliza backend self-records nothing, and a
   * gate-off run writes nothing — never an error. Returns the ingested
   * trajectory ids so the caller can append them to the session record.
   */
  private async ingestChildTrajectories(
    taskId: string,
    sessionId: string,
  ): Promise<string[]> {
    const dir = this.childTrajectoryDir(taskId);
    let files: string[];
    try {
      // Recursive string listing (the recorder nests trajectories under an
      // <agentId>/ subdir); resolve each to an absolute path.
      const relPaths = await readdir(dir, { recursive: true });
      files = relPaths
        .filter((p) => p.endsWith(".json"))
        .map((p) => join(dir, p));
    } catch (err) {
      // error-policy:J4 a missing child-trajectory dir is the designed empty
      // result (non-eliza backend or gate off); only ENOENT degrades silently.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    if (files.length === 0) return [];

    // Dedupe against files this task already recorded (#14110). The trajectory
    // dir is per-TASK but `task_complete` fires per-SESSION-completion, so a
    // re-completion of the same session or a respawned second session re-scans
    // the same files. Without this guard each pass re-attaches them as brand-new
    // artifacts (fresh `randomUUID()` ids) and re-stamps the *current* session's
    // correlation onto files an *earlier* session actually recorded — corrupting
    // the file↔DB trace join #13871 exists to provide. The already-recorded
    // artifact paths are the persistent dedupe key: they survive restart with
    // the task document, and skipping them preserves the original ingesting
    // session's correlation (we never touch an already-attached artifact).
    const existingArtifactPaths = new Set(
      ((await this.store.getTask(taskId))?.artifacts ?? [])
        .filter((a) => a.artifactType === "trajectory" && a.path)
        .map((a) => a.path as string),
    );
    const freshFiles = files.filter((path) => !existingArtifactPaths.has(path));
    if (freshFiles.length === 0) return [];

    // Newest first, capped so a runaway child can't flood the task doc; the
    // store's MAX_ARTIFACTS also clamps. Cap applies to genuinely-new files only
    // so a large already-ingested backlog can't starve fresh trajectories out of
    // the window.
    const withMtime = await Promise.all(
      freshFiles.map(async (path) => ({
        path,
        mtimeMs: (await stat(path)).mtimeMs,
      })),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const capped = withMtime.slice(0, MAX_CHILD_TRAJECTORY_ARTIFACTS);

    const session = (await this.store.findSession(sessionId))?.session;
    const ingested: string[] = [];
    for (const { path } of capped) {
      // The recorder names files `<trajectoryId>.json`.
      const trajectoryId = basename(path, ".json");
      await this.store.addArtifact({
        id: randomUUID(),
        taskId,
        sessionId,
        artifactType: "trajectory",
        title: `Sub-agent trajectory ${trajectoryId}`,
        path,
        verificationStatus: "pending",
        metadata: {
          correlation: {
            traceId: session?.traceId,
            taskId,
            sessionId,
            parentStepId: session?.parentTrajectoryStepId,
            childTrajectoryId: trajectoryId,
          },
        },
        createdAt: nowIso(),
      });
      ingested.push(trajectoryId);
    }

    if (ingested.length > 0) {
      // Union-dedupe the id list too: even though path-dedupe above prevents
      // re-ingesting a file, two distinct files sharing a `<trajectoryId>.json`
      // basename (or a legacy pre-fix duplicate row) must not append a repeat id.
      const existing = session?.childTrajectoryIds ?? [];
      const merged = [...new Set([...existing, ...ingested])];
      if (merged.length !== existing.length) {
        await this.store.updateSession(sessionId, {
          childTrajectoryIds: merged,
        });
      }
    }
    return ingested;
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
   * The single durable task-status write. Every status change on the event
   * bridge, the verifier, and the crash producer routes a named
   * {@link TaskLifecycleTrigger} through {@link resolveTaskTransition}, so the
   * legal-transition table — not scattered inline guards — decides the target.
   * An illegal `(from, trigger)` (a stale/out-of-order session event that no
   * longer applies, e.g. a late `session_active` after `validating`) is dropped
   * as a no-op rather than stomping the current status. Terminal immutability
   * and the "weak `active` only promotes `open`" rule are encoded as absent
   * edges in the table, not as branches here. Paused tasks never advance from a
   * session event; operator lifecycle writes (pause/resume/archive/restart) set
   * their own status directly and clear `paused` where appropriate.
   */
  private async advanceTaskStatus(
    taskId: string,
    trigger: TaskLifecycleTrigger,
  ): Promise<void> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return;
    if (doc.task.paused) return;
    const next = resolveTaskTransition(doc.task.status, trigger);
    if (next === null || next === doc.task.status) return;
    await this.store.updateTask(taskId, { status: next });
  }

  /**
   * The `failed` producer. An unrecoverable session error moves a task to
   * terminal `failed`. Until this existed, an `error` event marked the SESSION
   * errored and (for auth/429) failed the account over, but never touched the
   * task status, so a crashed sub-agent left the task stuck `active`/`validating`
   * forever, waiting on the 3-minute stall watchdog or a human.
   *
   * Status termination MUST agree with whether `sub-agent-router.ts` will
   * respawn the crash, because the retry budget below only advances when a
   * FURTHER error re-enters — and a further error only exists if a respawn
   * produced a new session. The router respawns exactly two crash classes:
   *   - `session_state_lost` (respawnStateLost, always under the lineage cap), and
   *   - a pooled-account failure (rate-limit / needs-reauth) while a healthy
   *     sibling account remains (in-router account failover).
   * A PLAIN crash — a non-zero exit, a `TypeError`, a build-tool segfault — is
   * respawned by NEITHER path, so no successor session is ever spawned, no
   * further error re-enters, and a `retrying` (non-terminal) verdict wedges the
   * task forever (the P0 #13771 this producer exists to prevent). Such a crash
   * is therefore terminal on its FIRST occurrence.
   *
   * - Un-respawnable crash → `unrecoverable`: terminal `failed` immediately.
   * - Respawnable crash under budget → `retrying` (task returns to `active`) so
   *   the router's respawn can re-engage a fresh worker; if that successor also
   *   crashes it re-enters here and the budget still drives `failed`.
   * - Respawnable crash, budget spent → `unrecoverable`: terminal `failed`.
   *
   * Budget = {@link MAX_SESSION_RETRY_ATTEMPTS} errored sessions across THIS
   * task's lineage (each respawn is a fresh session row, so the count of
   * terminally-errored sessions IS the retry count — no separate counter to
   * drift). The erroring session's typed `retryCount` is stamped with that
   * lineage count so the durable record carries the budget position, reconciling
   * the field the router's respawn lineage also tracks.
   *
   * `login_required` is handled separately (→ `waiting_on_user`) because there a
   * human genuinely can unblock; a plain crash cannot, so it must not park.
   */
  private async advanceTaskOnSessionError(
    taskId: string,
    sessionId: string,
    failure: { failureKind?: string; message: string },
  ): Promise<void> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return;
    if (doc.task.paused) return;
    if (TERMINAL_TASK_STATUSES.has(doc.task.status)) return;

    // Scope the budget to the current run: an operator `restartTask` stamps a
    // budget epoch, and sessions spawned before it (a prior failed run's dead
    // lineage) must not count, or a restarted task re-fails on its first blip
    // (#14104). Absent epoch → every session counts (pre-restart lifetime).
    const budgetEpoch = readRetryBudgetEpoch(doc.task.metadata);
    const erroredSessionIds = new Set(
      doc.sessions
        .filter(
          (s) =>
            SESSION_ERROR_STATUSES.has(s.status) && s.spawnedAt >= budgetEpoch,
        )
        .map((s) => s.sessionId),
    );
    erroredSessionIds.add(sessionId);
    const erroredSessions = erroredSessionIds.size;
    // The just-errored session's status was written to `errored` before this
    // runs, so it is already counted. Stamp that lineage position onto the
    // canonical typed counter.
    await this.store.updateSession(sessionId, { retryCount: erroredSessions });

    const respawnable = this.routerWillRespawn(
      doc.sessions.find((s) => s.sessionId === sessionId),
      failure,
      erroredSessions,
    );
    // `routerWillRespawn` already folds the state-lost respawn cap into its
    // verdict via the SAME gate + effective cap the router's loop-guard uses
    // (#14104), so a state-lost lineage goes terminal on exactly the error the
    // router refuses to respawn — including when an operator raises or lowers
    // ACPX_STATE_LOST_RESPAWN_CAP. The account-failover class carries no
    // per-lineage router cap, so the shared errored-session budget still bounds
    // it here. An un-respawnable crash fails on its first occurrence — nothing
    // will re-drive it, so a non-terminal verdict wedges.
    const stateLost = failure.failureKind === "session_state_lost";
    const budgetSpent =
      !stateLost && erroredSessions >= MAX_SESSION_RETRY_ATTEMPTS;
    const terminal = !respawnable || budgetSpent;
    await this.store.addEvent({
      id: randomUUID(),
      taskId,
      sessionId,
      eventType: terminal ? "task_failed" : "session_error_retrying",
      summary: terminal
        ? `Sub-agent failed unrecoverably after ${erroredSessions} attempt(s); task marked failed.`
        : `Sub-agent errored (attempt ${erroredSessions}/${MAX_SESSION_RETRY_ATTEMPTS}); retrying.`,
      data: {
        failureKind: failure.failureKind ?? null,
        message: failure.message,
        attempt: erroredSessions,
        budget: MAX_SESSION_RETRY_ATTEMPTS,
        respawnable,
      },
      timestamp: Date.now(),
      createdAt: nowIso(),
    });
    await this.advanceTaskStatus(
      taskId,
      terminal ? "unrecoverable" : "retrying",
    );
    this.emitChange(taskId);
  }

  /**
   * Whether `sub-agent-router.ts` will deterministically respawn this crash —
   * the same gate the router itself uses, mirrored here so status termination
   * and respawn agree. Only these two classes get a successor session:
   *   - `session_state_lost`, respawned by the router only while the lineage's
   *     errored count stays under the effective respawn cap. `erroredSessions`
   *     is the 1-based lineage position of the just-errored session, which the
   *     router tracks as its own per-lineage state-lost count; consulting the
   *     SAME cap + gate here means the task goes terminal on exactly the error
   *     the router refuses to respawn, so no 4th orphan worker spawns against a
   *     `failed` task (#14104).
   *   - a pooled-account failure whose message classifies as rate-limit /
   *     needs-reauth, while the session carried a pooled account and a healthy
   *     sibling remains for failover.
   * Everything else is un-respawnable and must fail immediately.
   */
  private routerWillRespawn(
    session: OrchestratorTaskSession | undefined,
    failure: { failureKind?: string; message: string },
    erroredSessions: number,
  ): boolean {
    if (failure.failureKind === "session_state_lost") {
      return stateLostRespawnUnderCap(
        erroredSessions,
        resolveStateLostRespawnCap(this.runtime),
      );
    }
    if (classifyAccountFailure(failure.message) === null) return false;
    if (!session?.accountProviderId || !session.accountId) return false;
    return hasHealthyPooledAccount(session.framework);
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
    const bound = this.bindProject(input);
    const doc = await this.store.createTask(
      await this.withDefaultAcceptanceCriteria(bound),
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
   * Stamp the task's project binding: an explicit `projectId` (validated against
   * the registry) wins; otherwise the resolved `workdir` is realpath-matched to
   * a registered project. The `workdir` hint is stripped so it is never
   * persisted on the record — only the resolved `projectId` is. No match leaves
   * the task unbound, preserving per-session workdir re-resolution.
   *
   * A bound task is also stamped with the project's memory world (#13776 D3),
   * derived per-agent via core's `projectWorldId(agentId, projectId)` — the
   * single source of truth (#14171); Worlds are agent-scoped, so the runtime's
   * agentId is part of the derivation. Its subagents are thus partitioned to the
   * project and never see another project's injected context. A caller-supplied
   * `worldId` is authoritative and wins — only an unset one is filled from the
   * binding.
   */
  private bindProject(input: CreateTaskInput): CreateTaskInput {
    const projectId = resolveTaskProjectId(input);
    const { workdir: _workdir, ...rest } = input;
    const worldId =
      rest.worldId ??
      (projectId ? projectWorldId(this.runtime.agentId, projectId) : undefined);
    return { ...rest, projectId, worldId };
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
    if (!doc) return null;
    return this.withAdmissionPosition(toTaskThreadDetail(doc));
  }

  /** Fill the DTO's `admission.position` from the live DISPATCH order (1-based,
   * priority-band + aging applied), which the mapper cannot see. A parked task
   * not currently in the in-memory queue keeps position 0. */
  private async withAdmissionPosition<T extends TaskThreadDetailDto>(
    detail: T,
  ): Promise<T> {
    if (!detail.admission) return detail;
    const { queuedTaskIds } = await this.getAdmissionSnapshot();
    const idx = queuedTaskIds.indexOf(detail.id);
    detail.admission = {
      ...detail.admission,
      position: idx >= 0 ? idx + 1 : 0,
    };
    return detail;
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

  /**
   * Pause is a HARD stop: it kills the ACP subprocesses (they can't be
   * re-attached later — a subprocess is gone once stopped), then sets `paused`.
   * When it actually stopped in-flight work it records `pausedWithActiveWork` so
   * {@link resumeTask} knows to re-engage a fresh worker rather than flip a flag
   * on a task with no running agent — the two must be symmetric or resume is a
   * silent no-op (the #13771 bug).
   */
  async pauseTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    // A paused task must not dispatch — drop it from the in-memory order but
    // KEEP its admission record so resume can replay the original spawn.
    await this.dequeueAdmission(taskId, false);
    const hadActiveWork = doc.sessions.some(
      (s) => !TERMINAL_TASK_SESSION_STATUSES.has(s.status),
    );
    await this.stopActiveSessions(doc);
    await this.store.updateTask(taskId, {
      paused: true,
      metadata: { ...doc.task.metadata, pausedWithActiveWork: hadActiveWork },
    });
    return this.getTask(taskId);
  }

  /**
   * Resume clears `paused` and, symmetrically with {@link pauseTask}, re-engages
   * the work pause stopped: because pause kills the subprocesses, resume must
   * spawn a FRESH sub-agent to continue from the task's durable context (goal,
   * criteria, timeline all survive on the store). A task paused before any
   * sub-agent ran (`pausedWithActiveWork` unset/false) just unpauses — there is
   * nothing to re-engage. A terminal task never re-engages.
   */
  async resumeTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    const shouldReEngage =
      doc.task.metadata?.pausedWithActiveWork === true &&
      !TERMINAL_TASK_STATUSES.has(doc.task.status);
    const nextMetadata = { ...doc.task.metadata };
    delete nextMetadata.pausedWithActiveWork;
    const updated = await this.store.updateTask(taskId, {
      paused: false,
      metadata: nextMetadata,
    });
    if (!updated) return null;
    // If the task was parked when paused, re-seed the in-memory order from its
    // retained admission record so it competes for a slot again. A resumed task
    // that already ran (had a session) carries no admission record and is a
    // no-op here.
    const admission = OrchestratorTaskService.admissionOf(doc.task);
    if (
      admission &&
      this.admissionQueueEnabled() &&
      !this.admissionQueue.includes(taskId)
    ) {
      this.admissionQueue.push(taskId);
      void this.drainAdmissionQueue();
    }
    // A task interrupted mid-work (pausedWithActiveWork) had its subprocesses
    // killed by pause, so resume must spawn a FRESH sub-agent to continue from
    // durable context rather than flip a flag on a task with no running agent.
    if (shouldReEngage && this.acp()) {
      await this.store.addEvent({
        id: randomUUID(),
        taskId,
        eventType: "resume_reengaged",
        summary:
          "Task resumed; re-engaging a sub-agent to continue the interrupted work.",
        data: {},
        timestamp: Date.now(),
        createdAt: nowIso(),
      });
      await this.spawnAgentForTask(taskId, {
        task: "Resume this task from its current durable context. Reinspect the task timeline and any partial work, then continue until the goal is met or you are blocked.",
      });
    }
    return this.getTask(taskId);
  }

  async archiveTask(taskId: string): Promise<TaskThreadDetailDto | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    await this.dequeueAdmission(taskId);
    await this.stopActiveSessions(doc);
    // Re-read after stopActiveSessions, which may have advanced the status, and
    // resolve the archive target through the transition table rather than
    // writing `"archived"` literally: the `archived` trigger is legal from every
    // state, so this is total, but going through the table keeps that table row
    // live (a legality regression there now fails this write) instead of dead
    // documentation the operator path silently bypasses.
    const current = (await this.store.getTask(taskId)) ?? doc;
    await this.store.updateTask(taskId, {
      archived: true,
      status: nextTaskStatus(current.task.status, "archived"),
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
    await this.dequeueAdmission(taskId);
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
    const projectId = overrides.projectId ?? doc.task.projectId ?? undefined;
    const projectChanged =
      overrides.projectId !== undefined &&
      overrides.projectId !== doc.task.projectId;
    const worldId = projectChanged
      ? undefined
      : (overrides.worldId ?? doc.task.worldId);
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
      worldId,
      projectId,
      workdir: overrides.workdir,
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
      await this.advanceTaskStatus(taskId, "awaiting_user");
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
      // Route the validating→active retry through the transition table so an
      // operator archive/pause that landed while the judge was running is not
      // stomped by a direct status write (illegal moves drop as no-ops).
      await this.advanceTaskStatus(taskId, "validation_failed");
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
      await this.advanceTaskStatus(taskId, "awaiting_user");
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
      // Undefined defers to acp-service's defaultAgent (eliza-code on the
      // native transport); opencode is opt-in via explicit settings only.
      agentType: configuredDefaultAgentType(this.runtime),
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
    // Open a fresh budget epoch BEFORE the first spawn of the new run so the
    // prior (failed) run's dead errored sessions no longer count toward the
    // crash-retry budget — otherwise a restarted task re-fails on its first
    // recoverable blip while the router respawns anyway (#14104). Merge into the
    // existing bag: `updateTask` replaces `metadata` wholesale.
    await this.store.updateTask(taskId, {
      metadata: {
        ...doc.task.metadata,
        [RETRY_BUDGET_EPOCH_METADATA_KEY]: Date.now(),
      },
    });
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

  /**
   * Per-trace token/cost roll-up across this task's INGESTED SUB-AGENT
   * TRAJECTORY FILES (#13775 item 5). Distinct from {@link getUsage}: that sums
   * the ACP terminal `OrchestratorTaskUsage` frames (the spend a sub-agent's
   * ACP surface reported for the whole session); this reads the file-recorder
   * `trajectory` artifacts item 2 attached and sums their inner per-model-call
   * metrics, grouped by the shared `traceId`. The two count different things
   * (ACP-reported session spend vs. file-recorded inner-call spend) and are
   * deliberately kept apart so nothing is double-summed. For an eliza-backend
   * sub-agent whose ACP frame is coarse/absent, this is the only surface that
   * attributes the real inner spend to the logical run.
   *
   * Attach-by-reference means the files live where the child wrote them. A
   * missing/unreadable/parse-failed file keeps the endpoint partial: readable
   * files still contribute to totals, and failed files are returned as
   * `artifactErrors` so operators never mistake partial spend for a complete
   * clean roll-up.
   */
  async getTraceUsage(taskId: string): Promise<TaskTraceUsageRollup | null> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return null;
    // Dedupe by path: `ingestChildTrajectories` rescans the task-wide child
    // dir on every task_complete, so a multi-session / retried task can hold
    // more than one artifact row pointing at the SAME trajectory file. Summing
    // each row would double-count that file's tokens/cost, so read each
    // distinct path once.
    const paths = [
      ...new Set(
        doc.artifacts
          .filter(
            (artifact) =>
              artifact.artifactType === "trajectory" && Boolean(artifact.path),
          )
          .map((artifact) => artifact.path as string),
      ),
    ];
    const trajectories: RecordedTrajectory[] = [];
    const artifactErrors: TraceUsageArtifactError[] = [];
    for (const path of paths) {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        // A well-formed trajectory carries a metrics block; anything else is a
        // mislabeled artifact and is surfaced as partial rather than trusted.
        if (
          parsed &&
          typeof parsed === "object" &&
          "metrics" in parsed &&
          parsed.metrics &&
          typeof parsed.metrics === "object"
        ) {
          trajectories.push(parsed as RecordedTrajectory);
        } else {
          artifactErrors.push({
            path,
            reason: "invalid_trajectory",
            message: "Trajectory artifact does not contain metrics.",
          });
        }
      } catch (err) {
        // error-policy:J4 trace usage is a user-facing accounting surface; keep
        // readable totals available, but return artifactErrors/readState so a
        // corrupt or missing file cannot look like complete zero spend.
        const message = err instanceof Error ? err.message : String(err);
        artifactErrors.push({
          path,
          reason: "read_failed",
          message,
        });
        this.log("warn", "partial trace usage due to unreadable artifact", {
          taskId,
          path,
          error: message,
        });
      }
    }
    const rollup = rollUpTrajectoryUsage(trajectories);
    return {
      ...rollup,
      readState: artifactErrors.length > 0 ? "partial" : "complete",
      artifactCount: paths.length,
      readableArtifactCount: trajectories.length,
      unreadableArtifactCount: artifactErrors.length,
      artifactErrors,
    };
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
    // Resolve the spawn workdir through the SHARED precedence resolver so this
    // direct-service path and the SPAWN_AGENT action path can never diverge on
    // the same task+input (#14108): project localPath > explicit caller workdir
    // > first-spawn `boundWorkdir`.
    //
    // - A project-bound task ALWAYS spawns in its project's localPath, even via
    //   this API/service entry point (previously this path ignored `projectId`
    //   entirely, so a bound task could land in `boundWorkdir` or an explicit
    //   workdir — the divergence #14108 reports). When an explicit workdir loses
    //   to the binding the resolver logs loudly instead of silently swapping.
    // - An explicit caller workdir otherwise wins and re-pins the binding.
    // - Else a follow-up spawn reuses the workdir pinned at first spawn so it
    //   can't silently migrate repos when routing env drifts between sessions
    //   (#13776).
    //
    // A project localPath / `boundWorkdir` was validated when first bound, so
    // reuse of those skips the allow-list probe — they may point at a configured
    // project root the probe would otherwise reject once env drifts. Only a
    // freshly-supplied explicit workdir is re-probed.
    const resolvedWorkdir = resolveTaskSpawnWorkdir({
      projectId: doc.task.projectId,
      boundWorkdir: doc.task.boundWorkdir,
      explicitWorkdir: opts.workdir,
    });
    const workdir =
      resolvedWorkdir.source === "explicit" && resolvedWorkdir.workdir
        ? await resolveAllowedWorkdir(resolvedWorkdir.workdir)
        : resolvedWorkdir.workdir;

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
    const brokerWired = isParentAgentBrokerWired(this.runtime);
    // A task bound to a Project that already owns a Cloud app carries that app's
    // id into the prompt so the worker updates it rather than minting a duplicate
    // (#14119). Null for unbound tasks or projects with no Cloud app.
    const cloudAppId =
      resolveBoundProjectCloudAppId(doc.task.projectId) ?? undefined;
    const goalPrompt = buildGoalPrompt({
      agentName,
      goal: doc.task.goal,
      task: opts.task ?? doc.task.goal,
      acceptanceCriteria: doc.task.acceptanceCriteria,
      taskRoomId: doc.task.taskRoomId ?? doc.task.roomId,
      workdir,
      repo: opts.repo,
      ...(cloudAppId ? { cloudAppId } : {}),
      // Replay prior failed-verification post-mortems so a re-spawn of this task
      // doesn't repeat them (#8899).
      attemptReflections: readAttemptReflections(doc.task.metadata),
      ...(capabilityProfile ? { capabilityProfile } : {}),
      brokerWired,
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

    // Trace correlation (#13775): stamp the parent turn's traceId +
    // parent-step onto the sub-agent env so its self-recorded trajectories join
    // the parent's trace, and point ELIZA_TRAJECTORY_DIR at a per-task child dir
    // this service scans on task_complete. When the gate is off we forward an
    // explicit ELIZA_TRAJECTORY_LOGGING="0": the broad ELIZA_ env forwarding
    // (acp-service.forwardableSubAgentEnv) would otherwise leak the parent's
    // ambiguous value to the child.
    const traceEnv = this.buildChildTraceEnv(taskId);

    const framework =
      opts.framework ??
      policy.preferredFramework ??
      configuredDefaultAgentType(this.runtime);
    let result: SpawnResult;
    try {
      result = await acp.spawnSession({
        env: traceEnv,
        // Coding-agent selection: explicit request → routing policy → the
        // deployment's configured default (ELIZA_ACP_DEFAULT_AGENT /
        // ELIZA_DEFAULT_AGENT_TYPE). When none of those apply, `framework` is
        // undefined and spawnSession resolves acp-service's `defaultAgent`
        // (eliza-code under the native transport) — the single source of
        // truth, so an unconfigured host dogfoods eliza-code rather than a
        // vendored CLI. opencode remains available only as an explicit
        // selection (settings/routing/request).
        agentType: framework,
        workdir,
        initialTask: goalPrompt,
        model: opts.model ?? policy.model,
        approvalPreset: opts.approvalPreset,
        // Economics tasks drive the monetized-app loop; enrich the always-written
        // SKILLS.md with the Cloud app-build skills and the ViewKind contract so a
        // deploying sub-agent categorizes any view it ships (#8917). The broker
        // skill entry itself is added by spawnSession when the router is wired.
        ...(capabilityProfile === "economics"
          ? {
              skillsManifest: {
                recommendedSlugs: ["build-monetized-app", "eliza-cloud"],
                includeViewKindContract: true,
              },
            }
          : {}),
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
    } catch (err) {
      // The worker cap is full. A TOP-LEVEL spawn parks in the admission queue
      // (task stays `open`, admission metadata persisted) and the caller gets a
      // truthful detail with the queued position instead of a hard failure. A
      // NESTED spawn (a running sub-agent spawning a child) must NOT park — its
      // parent is blocked awaiting the child, so queuing would deadlock; it
      // re-throws so the parent sees the cap and can back off.
      if (
        err instanceof SessionCapError &&
        err.slotClass === "worker" &&
        nestingDepth === 0 &&
        opts.parkOnCap !== false &&
        this.admissionQueueEnabled()
      ) {
        return this.enqueueAdmission(taskId, doc.task.priority, {
          framework: opts.framework,
          model: opts.model ?? policy.model,
          workdir: opts.workdir,
          repo: opts.repo,
          label: opts.label,
          task: opts.task,
          approvalPreset: opts.approvalPreset,
          providerSource: opts.providerSource ?? policy.providerSource,
        });
      }
      throw err;
    }

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
      // Trace correlation (#13775): persisted so task_complete can ingest child
      // trajectories under the same header the sub-agent was spawned with.
      ...(traceEnv[TRACE_ENV.TRACE_ID]
        ? { traceId: traceEnv[TRACE_ENV.TRACE_ID] }
        : {}),
      ...(traceEnv[TRACE_ENV.PARENT_STEP_ID]
        ? { parentTrajectoryStepId: traceEnv[TRACE_ENV.PARENT_STEP_ID] }
        : {}),
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
      // A task can be spawned directly (API/action) while it is still parked in
      // the admission queue — e.g. a slot freed silently and the user beat the
      // reconcile tick. Clear the parked state now the spawn succeeded, or the
      // next drain would replay the stale admission record and dispatch a
      // DUPLICATE agent for the same goal. No-op for non-parked tasks.
      await this.dequeueAdmission(taskId);
      await this.store.addSession(session);
      // Pin (or re-pin, on explicit override) the durable workdir/repo binding
      // from the workdir the session actually landed in, so subsequent
      // follow-up spawns of this task reuse it deterministically (#13776).
      await this.bindTaskWorkdir(taskId, doc.task, result.workdir, opts.repo, {
        // Only an explicit caller workdir that actually WON (source=explicit)
        // may re-pin the binding. A project-bound task's localPath won here, so
        // an ignored explicit `opts.workdir` must NOT be treated as a rebind
        // request (#14108) — the project binding, not the pin, is authoritative.
        allowRebind:
          resolvedWorkdir.source === "explicit" &&
          Boolean(opts.workdir) &&
          Boolean(doc.task.boundWorkdir) &&
          doc.task.boundWorkdir !== result.workdir,
      });
      await this.advanceTaskStatus(taskId, "session_active");
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
   * Pin the task's durable workdir/repo binding. Idempotent for a stable
   * workdir: the FIRST spawn sets `boundWorkdir`; later spawns only re-pin when
   * the caller lands the session in a DIFFERENT directory (an explicit user
   * override), which is the intended "override wins and updates the binding"
   * behavior. `spawnAgentForTask` reads `boundWorkdir` back as its default so a
   * follow-up with no explicit workdir deterministically reuses the first
   * session's directory instead of re-resolving from mutable routing env.
   *
   * `current` is the caller's already-loaded task record (attachSession /
   * spawnAgentForTask both hold a fresh doc); passing it avoids a redundant
   * read. Stopgap for #13776 item 3 — a future `task.projectId` supersedes this.
   */
  private async bindTaskWorkdir(
    taskId: string,
    current: OrchestratorTaskRecord,
    workdir: string | undefined,
    repo: string | undefined,
    opts: { allowRebind?: boolean } = {},
  ): Promise<void> {
    if (!workdir) return;
    const previous =
      this.taskWorkdirBindQueues.get(taskId)?.catch(
        // error-policy:J5 bind queue promises are awaited by the originating
        // bind call; the continuation must still run so one failed bind does
        // not permanently block later corrections.
        () => undefined,
      ) ?? Promise.resolve();
    const canSetRepo = (latest: OrchestratorTaskRecord) =>
      !latest.boundWorkdir ||
      (latest.boundWorkdir === workdir && current.boundWorkdir === workdir) ||
      opts.allowRebind === true;
    const next = previous.then(async () => {
      const latest = (await this.store.getTask(taskId))?.task ?? current;
      const canSetWorkdir = !latest.boundWorkdir || opts.allowRebind === true;
      const patch: Partial<OrchestratorTaskRecord> = {};
      const workdirChanged = latest.boundWorkdir !== workdir;
      if (canSetWorkdir && workdirChanged) patch.boundWorkdir = workdir;
      if (canSetRepo(latest) && repo && latest.boundRepo !== repo) {
        patch.boundRepo = repo;
      } else if (canSetWorkdir && workdirChanged && latest.boundRepo) {
        patch.boundRepo = null;
      }
      if (Object.keys(patch).length === 0) return;
      await this.store.updateTask(taskId, patch);
    });
    this.taskWorkdirBindQueues.set(taskId, next);
    try {
      await next;
    } finally {
      if (this.taskWorkdirBindQueues.get(taskId) === next) {
        this.taskWorkdirBindQueues.delete(taskId);
      }
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
    // Pin the durable workdir/repo binding at first spawn so follow-up spawns of
    // this task reuse it instead of re-resolving from routing env (#13776).
    await this.bindTaskWorkdir(taskId, doc.task, input.workdir, input.repo, {
      allowRebind:
        Boolean(doc.task.boundWorkdir) &&
        doc.task.boundWorkdir !== input.workdir,
    });
    // Only claim liveness if the session actually is live — a terminal-on-
    // arrival session (chat action's runPromptAndClose already stopped it) gets
    // indexed for history + future token attribution without falsely promoting
    // task status.
    if (!TERMINAL_TASK_SESSION_STATUSES.has(input.status)) {
      await this.advanceTaskStatus(taskId, "session_active");
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
      // Route through the transition table: a task that already reached a
      // terminal state (done/failed/archived) but still holds a live keepAlive
      // session whose stop we can't attempt must NOT be stomped to `interrupted`
      // — `done → interrupted` has no table edge, so this is a legal no-op there
      // and only interrupts a genuinely non-terminal task.
      await this.advanceTaskStatus(taskId, "interrupted");
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
      await this.advanceTaskStatus(doc.task.id, "interrupted");
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
      // A terminal task holding a live keepAlive session whose ACP stop fails
      // must not regress to `interrupted`; the table makes that a legal no-op
      // while still interrupting a non-terminal one.
      await this.advanceTaskStatus(doc.task.id, "interrupted");
      throw new RecoveryConflictError(
        `Failed to stop ${failures.length} active session${
          failures.length === 1 ? "" : "s"
        }`,
      );
    }
  }

  // ---- admission queue (#13772) -----------------------------------------

  /** The queue is on by default; `ELIZA_ACP_ADMISSION_QUEUE=0` disables it and
   * restores hard-fail-at-cap for spawnAgentForTask (the SessionCapError is
   * re-thrown). */
  private admissionQueueEnabled(): boolean {
    const raw = this.readSetting("ELIZA_ACP_ADMISSION_QUEUE");
    return raw !== "0";
  }

  /** Max parked tasks. A cap-park beyond this depth is back-pressure the caller
   * must see, not more queue (AdmissionQueueFullError → 429). */
  private admissionQueueDepthCap(): number {
    return parsePositiveIntSetting(
      this.readSetting("ELIZA_ACP_ADMISSION_QUEUE_DEPTH"),
      32,
    );
  }

  /** Aging promotion interval: a queued entry gains one priority band per this
   * many ms waited, so a low-priority task can't starve (guard #1). */
  private admissionAgingMs(): number {
    return parsePositiveIntSetting(
      this.readSetting("ELIZA_ACP_QUEUE_AGING_MS"),
      600_000,
    );
  }

  private readSetting(key: string): string | undefined {
    const raw = this.runtime.getSetting?.(key);
    if (typeof raw === "string" && raw.length > 0) return raw;
    const env = process.env[key];
    return typeof env === "string" && env.length > 0 ? env : undefined;
  }

  /** Read the admission record off a task's metadata, or null if not queued. */
  private static admissionOf(
    task: OrchestratorTaskRecord,
  ): AdmissionRecord | null {
    const admission = task.metadata?.admission;
    if (isAdmissionRecord(admission)) {
      return admission;
    }
    return null;
  }

  /** Persist (or clear) the admission record on a task's metadata. updateTask
   * shallow-merges `task`, so we replace the whole metadata object to add/remove
   * the single `admission` key without disturbing the rest. */
  private async writeAdmission(
    taskId: string,
    admission: AdmissionRecord | null,
  ): Promise<void> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return;
    const nextMeta = { ...doc.task.metadata };
    if (admission) nextMeta.admission = admission;
    else delete nextMeta.admission;
    await this.store.updateTask(taskId, { metadata: nextMeta });
  }

  /**
   * Park a task that met the worker cap. Persists the admission record, seeds
   * the in-memory order, kicks a drain (a slot may have freed between the cap
   * check and here), and returns the task detail carrying the queued position.
   * Throws AdmissionQueueFullError when the queue is at its depth cap.
   */
  private async enqueueAdmission(
    taskId: string,
    priority: OrchestratorTaskPriority,
    spawnOpts: SerializableSpawnOpts,
  ): Promise<TaskThreadDetailDto | null> {
    if (
      !this.admissionQueue.includes(taskId) &&
      this.admissionQueue.length >= this.admissionQueueDepthCap()
    ) {
      throw new AdmissionQueueFullError(this.admissionQueueDepthCap());
    }
    const admission: AdmissionRecord = {
      state: "queued",
      enqueuedAt: nowIso(),
      priorityAtEnqueue: priority,
      spawnOpts,
    };
    await this.writeAdmission(taskId, admission);
    if (!this.admissionQueue.includes(taskId)) this.admissionQueue.push(taskId);
    this.log("info", "task parked in admission queue", {
      taskId,
      priority,
      depth: this.admissionQueue.length,
    });
    // A slot may have freed between the cap rejection and this write; try now.
    void this.drainAdmissionQueue();
    return this.getTask(taskId);
  }

  /**
   * Remove a task from the in-memory dispatch order. Lifecycle transitions call
   * this so a parked spawn stops competing for a slot.
   *
   * `clearMetadata` controls the durable record: archive/delete/cancel clear it
   * (the parked spawn is moot); pause keeps it so resume can replay the ORIGINAL
   * spawnOpts instead of re-admitting with an empty request.
   */
  private async dequeueAdmission(
    taskId: string,
    clearMetadata = true,
  ): Promise<void> {
    const idx = this.admissionQueue.indexOf(taskId);
    if (idx >= 0) this.admissionQueue.splice(idx, 1);
    if (!clearMetadata) return;
    const doc = await this.store.getTask(taskId);
    if (doc && OrchestratorTaskService.admissionOf(doc.task)) {
      await this.writeAdmission(taskId, null);
    }
  }

  /** Rebuild the in-memory dispatch order from the store on start() so a restart
   * mid-queue resumes deterministically. Scans `open` tasks for a queued
   * admission record and seeds `admissionQueue` in current priority order. */
  private async rebuildAdmissionQueueFromStore(): Promise<void> {
    const open = await this.store.listTasks({ status: "open" });
    const entries: QueueEntry[] = [];
    for (const task of open) {
      const admission = OrchestratorTaskService.admissionOf(task);
      if (!admission) continue;
      // A paused task keeps its durable admission record (pauseTask passes
      // clearMetadata=false so resume can replay the original spawn) but must
      // NOT re-enter the dispatch order — resumeTask re-seeds it explicitly.
      if (task.paused) continue;
      entries.push({
        taskId: task.id,
        enqueuedAt: admission.enqueuedAt,
        priorityAtEnqueue: admission.priorityAtEnqueue,
      });
    }
    const ordered = orderQueue(entries, Date.now(), this.admissionAgingMs());
    this.admissionQueue.length = 0;
    for (const entry of ordered) this.admissionQueue.push(entry.taskId);
    if (this.admissionQueue.length > 0) {
      this.log("info", "rebuilt admission queue from store", {
        depth: this.admissionQueue.length,
      });
    }
  }

  /**
   * Full capacity + queue overview for `GET /api/orchestrator/capacity`: live
   * worker/system slot accounting plus the ordered admission queue with each
   * entry's 1-based position, priority, and enqueue time. Unlike the provider
   * snapshot this route payload MAY carry timestamps — it is a live poll, not a
   * cached planner segment.
   */
  async getCapacityOverview(): Promise<{
    maxSessions: number;
    systemHeadroom: number;
    activeWorkers: number;
    activeSystem: number;
    freeWorkerSlots: number;
    freeSystemSlots: number;
    queueDepth: number;
    queue: Array<{
      taskId: string;
      position: number;
      priority: OrchestratorTaskPriority;
      enqueuedAt: string;
    }>;
  }> {
    const acp = this.acp();
    const capacity = acp
      ? await acp.getCapacity()
      : {
          maxSessions: 0,
          systemHeadroom: 0,
          activeWorkers: 0,
          activeSystem: 0,
          freeWorkerSlots: 0,
          freeSystemSlots: 0,
        };
    const entries = orderQueue(
      await this.currentQueueEntries(),
      Date.now(),
      this.admissionAgingMs(),
    );
    return {
      maxSessions: capacity.maxSessions,
      systemHeadroom: capacity.systemHeadroom,
      activeWorkers: capacity.activeWorkers,
      activeSystem: capacity.activeSystem,
      freeWorkerSlots: capacity.freeWorkerSlots,
      freeSystemSlots: capacity.freeSystemSlots,
      queueDepth: entries.length,
      queue: entries.map((entry, index) => ({
        taskId: entry.taskId,
        position: index + 1,
        priority: entry.priorityAtEnqueue,
        enqueuedAt: entry.enqueuedAt,
      })),
    };
  }

  /** Snapshot for the provider + capacity route: current queue depth and the
   * ordered taskIds. Counts/ids only — NO timestamps — so the provider segment
   * stays cache-stable turn over turn. */
  async getAdmissionSnapshot(): Promise<{
    queueDepth: number;
    queuedTaskIds: string[];
  }> {
    const entries: QueueEntry[] = [];
    for (const taskId of this.admissionQueue) {
      const doc = await this.store.getTask(taskId);
      const admission = doc && OrchestratorTaskService.admissionOf(doc.task);
      if (!admission) continue;
      entries.push({
        taskId,
        enqueuedAt: admission.enqueuedAt,
        priorityAtEnqueue: admission.priorityAtEnqueue,
      });
    }
    const ordered = orderQueue(entries, Date.now(), this.admissionAgingMs());
    return {
      queueDepth: ordered.length,
      queuedTaskIds: ordered.map((e) => e.taskId),
    };
  }

  /**
   * Dispatch parked tasks into freed worker slots, most-eligible first.
   * Serialized via a promise-chain lock so a terminal-event drain and the
   * reconcile tick never double-dispatch. For each free slot it re-reads the
   * head task's live state (terminal entries are dropped with their record;
   * paused entries are dropped from the order but KEEP the record for resume),
   * clears the admission record, and replays the saved spawn with
   * `parkOnCap: false`. A fresh SessionCapError re-parks the head with its
   * original record and stops the pass (another spawn raced us). When no slot
   * is free but the queue is
   * non-empty, one idle keepAlive session whose task is already terminal is
   * reclaimed to unblock the queue.
   */
  private async drainAdmissionQueue(): Promise<void> {
    const run = this.admissionDrainLock.then(() => this.drainOnce());
    this.admissionDrainLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drainOnce(): Promise<void> {
    const acp = this.acp();
    if (!acp) return;
    // Bound the pass by the current queue length so a task re-parked at the head
    // (SessionCapError race) can't spin this loop.
    let budget = this.admissionQueue.length;
    while (budget-- > 0 && this.admissionQueue.length > 0) {
      const capacity = await acp.getCapacity();
      if (capacity.freeWorkerSlots <= 0) {
        // No worker slot free. Reclaim one idle keepAlive session whose task has
        // already reached a terminal state (its slot is dead weight) so the
        // queue isn't starved by workers that finished but stayed alive.
        const reclaimed = await this.reclaimIdleSession(acp);
        if (!reclaimed) break;
        continue;
      }
      const ordered = orderQueue(
        await this.currentQueueEntries(),
        Date.now(),
        this.admissionAgingMs(),
      );
      const head = ordered[0];
      if (!head) break;
      // Drop the head from the in-memory order up front; a re-park below will
      // re-add it. This keeps the loop from re-selecting the same head when the
      // task turned out to be terminal/paused.
      const idx = this.admissionQueue.indexOf(head.taskId);
      if (idx >= 0) this.admissionQueue.splice(idx, 1);
      const doc = await this.store.getTask(head.taskId);
      const admission = doc && OrchestratorTaskService.admissionOf(doc.task);
      if (!doc || !admission) continue;
      if (TERMINAL_TASK_STATUSES.has(doc.task.status)) {
        await this.writeAdmission(head.taskId, null);
        continue;
      }
      // A pause that raced this pass: drop the task from the dispatch order but
      // KEEP the durable record — pauseTask retained it so resume can replay
      // the original spawn (clearing it here would make resume a silent no-op).
      if (doc.task.paused) continue;
      await this.writeAdmission(head.taskId, null);
      try {
        await this.spawnAgentForTask(head.taskId, {
          ...admission.spawnOpts,
          approvalPreset: admission.spawnOpts.approvalPreset as
            | ApprovalPreset
            | undefined,
          // A cap race must RETHROW so the catch below re-parks with the
          // original record; the spawn's own self-park would reset seniority.
          parkOnCap: false,
        });
      } catch (err) {
        if (err instanceof SessionCapError) {
          // A concurrent spawn took the slot. Re-park at the head and stop —
          // the next terminal event or reconcile tick drains again.
          await this.writeAdmission(head.taskId, admission);
          if (!this.admissionQueue.includes(head.taskId)) {
            this.admissionQueue.unshift(head.taskId);
          }
          break;
        }
        // error-policy:J7 the dispatch of a parked task failed for a non-cap
        // reason (bad workdir, transport error). Report it so the agent/owner
        // sees the parked task did not launch; do not silently drop or re-park
        // forever (that would spin the reconcile tick).
        this.runtime.reportError("OrchestratorTask.drainAdmissionQueue", err, {
          taskId: head.taskId,
        });
      }
    }
  }

  /** The queue's entries with their live admission records, for ordering. */
  private async currentQueueEntries(): Promise<QueueEntry[]> {
    const entries: QueueEntry[] = [];
    for (const taskId of this.admissionQueue) {
      const doc = await this.store.getTask(taskId);
      const admission = doc && OrchestratorTaskService.admissionOf(doc.task);
      if (!admission) continue;
      entries.push({
        taskId,
        enqueuedAt: admission.enqueuedAt,
        priorityAtEnqueue: admission.priorityAtEnqueue,
      });
    }
    return entries;
  }

  /**
   * Free one worker slot for the queue by stopping the oldest live keepAlive
   * session whose owning task has already reached a terminal state. Such a
   * session is finished work holding a slot; reclaiming it is safe and unblocks
   * queued tasks (starvation guard #2). Returns true when a session was stopped.
   */
  private async reclaimIdleSession(acp: AcpService): Promise<boolean> {
    const sessions = await acp.listSessions();
    const candidates: Array<{ id: string; createdAt: number }> = [];
    for (const session of sessions) {
      if (TERMINAL_SESSION_STATUSES.has(session.status)) continue;
      // Resolve via `resolveTaskId`, not the in-memory `sessionTaskIndex`
      // directly: after a parent restart the index is empty but pre-restart
      // keepAlive sessions are still live, so the session→task mapping only
      // exists in the durable store. Reading the index alone leaves this guard
      // unable to reclaim any pre-restart session, starving queued tasks behind
      // zombie sessions whose owning tasks are already terminal (#14106).
      const taskId = await this.resolveTaskId(session.id);
      if (!taskId) continue;
      const doc = await this.store.getTask(taskId);
      if (!doc || !TERMINAL_TASK_STATUSES.has(doc.task.status)) continue;
      candidates.push({
        id: session.id,
        createdAt: session.createdAt.getTime(),
      });
    }
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    const victim = candidates[0];
    if (!victim) return false;
    try {
      await acp.stopSession(victim.id);
      this.log("info", "reclaimed idle keepAlive session for queued task", {
        sessionId: victim.id,
      });
      return true;
    } catch (err) {
      // error-policy:J7 idle-reclaim is a best-effort starvation guard; a failed
      // stop is reported (so a wedged session is visible) but must not abort the
      // drain — the reconcile tick retries.
      this.runtime.reportError("OrchestratorTask.reclaimIdleSession", err, {
        sessionId: victim.id,
      });
      return false;
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
