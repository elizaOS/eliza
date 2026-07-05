/**
 * Domain types for the durable orchestrator task layer.
 *
 * A "task" is the unit of orchestration: a goal, its acceptance criteria, the
 * sub-agent sessions working it, the event/message timeline, token usage, and
 * lifecycle. This is the contract the `/orchestrator` view consumes — the
 * route layer maps {@link OrchestratorTaskDocument} into the frontend
 * `CodingAgentTaskThread` / `CodingAgentTaskThreadDetail` DTOs.
 *
 * @module services/orchestrator-task-types
 */

/** Lifecycle states. `validating` gates `done`: a sub-agent's `task_complete`
 * moves the task to `validating`, never straight to `done`. */
export type OrchestratorTaskStatus =
  | "open"
  | "active"
  | "waiting_on_user"
  | "blocked"
  | "validating"
  | "done"
  | "failed"
  | "archived"
  | "interrupted";

export type OrchestratorTaskPriority = "low" | "normal" | "high" | "urgent";

/** Whether token/cost numbers are real, inferred, or simply not reported by
 * the provider. The UI renders these three cases distinctly so an operator is
 * never misled by a confident-looking `0`. */
export type UsageState = "measured" | "estimated" | "unavailable";

export type TaskMessageSenderKind =
  | "user"
  | "orchestrator"
  | "sub_agent"
  | "system";

export type TaskMessageDirection =
  | "stdout"
  | "stderr"
  | "stdin"
  | "keys"
  | "system";

export type ArtifactVerificationStatus =
  | "pending"
  | "passed"
  | "failed"
  | "unknown";

export interface OrchestratorTaskRecord {
  id: string;
  title: string;
  goal: string;
  kind: string;
  status: OrchestratorTaskStatus;
  priority: OrchestratorTaskPriority;
  originalRequest: string;
  summary?: string;
  acceptanceCriteria: string[];
  currentPlan?: Record<string, unknown>;
  ownerUserId?: string;
  worldId?: string;
  /** Registered Project this task is bound to (id from the core project
   * registry). Bound tasks resolve their spawn workdir from the project's
   * localPath, so every session of the task targets the same repo. Undefined =
   * unbound (workdir re-resolved per session from routes/convention). */
  projectId?: string;
  roomId?: string;
  taskRoomId?: string;
  /** Lineage: the task this one was forked from, if any. */
  parentTaskId?: string;
  forkSource?: string;
  /**
   * Durable workdir/repo binding, pinned at the task's FIRST successful spawn
   * and reused for every follow-up spawn of the same task. Without it,
   * `resolveSpawnWorkdir` re-resolves per spawn from mutable routing env, so a
   * task could silently migrate repos between sessions. An explicit
   * caller-supplied workdir still wins and re-pins the binding.
   *
   * Stopgap for the first-class Project entity (#13776 item 3): a future
   * `projectId` on this record supersedes it, at which point the workdir is
   * derived from the bound project rather than snapshotted here.
   */
  boundWorkdir?: string;
  boundRepo?: string | null;
  /** Provider/model/subscription policy applied to spawned sub-agents. */
  providerPolicy?: TaskProviderPolicy;
  paused: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  archivedAt?: string | null;
  lastUserTurnAt?: string;
  lastCoordinatorTurnAt?: string;
  /** Epoch ms of the most recent activity — the list sort key. */
  lastActivityAt: number;
  metadata: Record<string, unknown>;
}

/**
 * A Reflexion-style verbal post-mortem captured when an automatic verification
 * attempt fails. Stored on the task (under `metadata.attemptReflections`) and
 * injected into the re-spawn prompt so a retried sub-agent doesn't repeat the
 * same mistakes. See #8899.
 */
export interface AttemptReflection {
  /** 1-based attempt number this reflection is for. */
  attempt: number;
  /** Acceptance criteria / evidence the verifier found missing. */
  missing: string[];
  /** The verifier's one-line summary of why the attempt fell short. */
  summary: string;
}

/** Cap on retained reflections — keep the most recent few to bound prompt size. */
export const MAX_ATTEMPT_REFLECTIONS = 5;

/** Crash-retry budget: how many times an unrecoverable session error may
 * re-dispatch a task's sub-agent lineage before the task goes terminal
 * `failed`. Bounds the general-crash respawn the same way
 * `MAX_AUTO_VERIFY_ATTEMPTS` bounds verification re-prompts. */
export const MAX_SESSION_RETRY_ATTEMPTS = 3;

/** The metadata key both the durable session `retryCount` and the router's
 * respawn-lineage counter fold into, so the two subsystems name ONE counter.
 * The router carries this forward across respawns via `sanitizeSuccessorMetadata`;
 * the task service mirrors it onto the typed `OrchestratorTaskSession.retryCount`.
 * Keep the historical key so lineages spawned before this reconciliation still
 * resolve their prior count. */
export const SESSION_RETRY_METADATA_KEY = "buildVerifyRetryCount";

/** Read the canonical retry count off a free-form session-metadata bag (the ACP
 * `SessionInfo.metadata`, which is untyped by construction). One typed accessor
 * replaces scattered untyped reads so the counter has a single definition across
 * the router and the task service. Non-numeric / missing reads to 0. */
export function readSessionRetryCount(
  metadata: Record<string, unknown> | undefined,
): number {
  const raw = metadata?.[SESSION_RETRY_METADATA_KEY];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface TaskProviderPolicy {
  /** Preferred sub-agent framework: claude | codex | opencode | elizaos | pi-agent. */
  preferredFramework?: string;
  /** Where inference/credentials are sourced: user-claude | user-openai | eliza-cloud | local. */
  providerSource?: string;
  model?: string;
}

export interface OrchestratorTaskSession {
  id: string;
  taskId: string;
  sessionId: string;
  framework: string;
  providerSource?: string;
  model?: string;
  /** Linked-account provider id (e.g. `anthropic-subscription`) when the
   * sub-agent was spawned against a specific pooled account. */
  accountProviderId?: string;
  /** Pooled account id this sub-agent authenticated as. */
  accountId?: string;
  /** Human label of the pooled account (e.g. "Work"). */
  accountLabel?: string;
  label: string;
  originalTask: string;
  goalPrompt?: string;
  workdir: string;
  repo?: string;
  status: string;
  activeTool?: string;
  decisionCount: number;
  autoResolvedCount: number;
  registeredAt: number;
  lastActivityAt: number;
  idleCheckCount: number;
  taskDelivered: boolean;
  completionSummary?: string;
  lastSeenDecisionIndex: number;
  lastInputSentAt?: number;
  spawnedAt: number;
  stoppedAt?: number;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsd: number;
  usageState: UsageState;
  // Trace correlation (#13775). `traceId` and `parentTrajectoryStepId` are
  // stamped at spawn from the parent turn's trajectory context and forwarded to
  // the sub-agent via env; `childTrajectoryIds` accumulates the sub-agent's own
  // trajectory ids ingested on task_complete. Optional — a session spawned
  // before rollout, or by a non-eliza backend that self-records no traces, has
  // none.
  traceId?: string;
  parentTrajectoryStepId?: string;
  childTrajectoryIds?: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One coding sub-agent's binding to a pooled account, with its spend. */
export interface OrchestratorAccountAssignment {
  taskId: string;
  taskTitle: string;
  sessionId: string;
  label: string;
  framework: string;
  status: string;
  active: boolean;
  accountProviderId: string;
  accountId: string;
  accountLabel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  /** Cumulative attributed tokens for this session (input+output+reasoning;
   * cache reported separately as cacheTokens) — same definition as
   * TaskSessionDto.totalTokens so per-session and per-account numbers agree.
   * Note: least-used selection ranks by the OAuth usage probe (sessionPct),
   * not this token count. */
  totalTokens: number;
  costUsd: number;
  usageState: UsageState;
}

export interface OrchestratorAccountProviderAvailability {
  providerId: string;
  total: number;
  enabled: number;
  healthy: number;
}

/** Accounts surface for the orchestrator dashboard: which accounts can serve
 * which agent type, the active strategy, and the live sub-agent → account map. */
export interface OrchestratorAccountOverview {
  strategy: string;
  availability: Record<string, OrchestratorAccountProviderAvailability[]>;
  assignments: OrchestratorAccountAssignment[];
}

export type OrchestratorRoomParticipantKind =
  | "orchestrator"
  | "user"
  | "sub_agent";

/** One participant in a task room. `sub_agent` rows carry their pooled account
 * + live spend; `orchestrator`/`user` rows identify the two human-facing ends. */
export interface OrchestratorRoomParticipant {
  kind: OrchestratorRoomParticipantKind;
  /** sessionId for a sub_agent; "orchestrator" or the ownerUserId otherwise. */
  id: string;
  label: string;
  framework?: string;
  status?: string;
  active?: boolean;
  activeTool?: string;
  accountProviderId?: string;
  accountId?: string;
  accountLabel?: string;
  totalTokens?: number;
  usageState?: UsageState;
}

/** A single task room with its grouped participant roster — the orchestrator,
 * the owning user, and every sub-agent attached to THIS room. The accounts
 * overview is a flat global map; this groups the same sessions by room. */
export interface OrchestratorRoomRoster {
  taskId: string;
  taskTitle: string;
  status: OrchestratorTaskStatus;
  roomId?: string;
  taskRoomId?: string;
  /** Non-terminal sub-agent sessions live in the room right now. */
  activeAgentCount: number;
  /** More than one sub-agent live in the room (drives ambient suppression). */
  multiParty: boolean;
  participants: OrchestratorRoomParticipant[];
}

/** Per-room roster surface for the orchestrator dashboard. */
export interface OrchestratorRoomRosterOverview {
  rooms: OrchestratorRoomRoster[];
}

export interface OrchestratorTaskEvent {
  id: string;
  taskId: string;
  sessionId?: string;
  eventType: string;
  summary: string;
  data: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export interface OrchestratorTaskMessage {
  id: string;
  taskId: string;
  sessionId?: string;
  roomId?: string;
  messageId?: string;
  senderKind: TaskMessageSenderKind;
  direction: TaskMessageDirection;
  content: string;
  searchableText: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestratorTaskUsage {
  id: string;
  taskId: string;
  sessionId?: string;
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsd?: number;
  state: UsageState;
  sourceEventId?: string;
  timestamp: number;
  createdAt: string;
}

export interface OrchestratorTaskArtifact {
  id: string;
  taskId: string;
  sessionId?: string;
  artifactType: string;
  title: string;
  path?: string;
  uri?: string;
  mimeType?: string;
  verificationStatus: ArtifactVerificationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestratorTaskDecision {
  id: string;
  taskId: string;
  sessionId?: string;
  event: string;
  decisionType: string;
  actionSelected: string;
  promptText: string;
  promptExcerpt: string;
  response?: string;
  reasoning: string;
  timestamp: number;
  createdAt: string;
}

export interface OrchestratorTaskPlanRevision {
  id: string;
  taskId: string;
  plan: Record<string, unknown>;
  basePlanRevisionId?: string;
  editSummary?: string;
  createdBy: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

/** The full persisted unit. One document per task; child collections live
 * inline so a single read returns everything the detail view needs. */
export interface OrchestratorTaskDocument {
  task: OrchestratorTaskRecord;
  sessions: OrchestratorTaskSession[];
  events: OrchestratorTaskEvent[];
  messages: OrchestratorTaskMessage[];
  usage: OrchestratorTaskUsage[];
  artifacts: OrchestratorTaskArtifact[];
  decisions: OrchestratorTaskDecision[];
  planRevisions: OrchestratorTaskPlanRevision[];
}

export interface TaskListFilter {
  status?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  /** Restrict to tasks bound to this project (indexed column on the SQL
   * backend; structural filter elsewhere). */
  projectId?: string;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  originalRequest?: string;
  kind?: string;
  priority?: OrchestratorTaskPriority;
  acceptanceCriteria?: string[];
  ownerUserId?: string;
  worldId?: string;
  /** Explicit project binding. When omitted, {@link createTask} attempts to
   * bind by realpath-matching {@link workdir} against a registered project; no
   * match leaves the task unbound. */
  projectId?: string;
  /** Resolved spawn workdir hint used to bind the task to a registered project
   * by realpath when {@link projectId} is absent. Not persisted on the record. */
  workdir?: string;
  roomId?: string;
  taskRoomId?: string;
  parentTaskId?: string;
  forkSource?: string;
  providerPolicy?: TaskProviderPolicy;
  currentPlan?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Aggregate token usage rolled up across a task's sessions. */
export interface TaskUsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  state: UsageState;
  byProvider: Array<{
    provider: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheTokens: number;
    totalTokens: number;
    costUsd: number;
    state: UsageState;
  }>;
}

/** Statuses that mean a sub-agent session is finished. Mirrors the ACP
 * `TERMINAL_SESSION_STATUSES` plus the task-thread terminal values. */
export const TERMINAL_TASK_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "completed",
  "done",
  "error",
  "errored",
  "cancelled",
]);

export const TERMINAL_TASK_STATUSES: ReadonlySet<OrchestratorTaskStatus> =
  new Set(["done", "failed", "archived"]);

/**
 * The named lifecycle triggers that drive a task's status. Every durable
 * task-status write goes through exactly one of these via the legal-transition
 * table below, so "which events can produce `failed`" (and every other status)
 * is answered in one place instead of being scattered across the event bridge,
 * the verifier, and the recovery/interrupt paths. Adding a status write means
 * adding a trigger here and an edge to {@link TASK_STATUS_TRANSITIONS}; there is
 * no other legal way to move a task's status.
 *
 * - `session_active` — a sub-agent reported liveness (ready/tool_running); the
 *   weakest signal, it only promotes an untouched `open` task. It deliberately
 *   does NOT reactivate `blocked`/`waiting_on_user`/`validating` — those are
 *   stronger states a mere activity ping must not clear; reactivation from them
 *   is an explicit operator move (restart/resume/retry), never a session event.
 * - `session_blocked` — the sub-agent hit a hard block it can't self-resolve.
 * - `awaiting_user` — the task needs human input to proceed (login required,
 *   auto-verify budget exhausted, corrective send failed).
 * - `completion_reported` — a sub-agent claimed done; gates on validation.
 * - `validation_passed` / `validation_failed` — the verifier's verdict.
 * - `retrying` — a recoverable crash is being re-dispatched under budget.
 * - `unrecoverable` — a crash with no budget left; the sole producer of `failed`.
 * - `interrupted` — an operator stop / lost-ACP interrupt.
 * - `archived` / `reopened` — operator archive lifecycle.
 * - `restarted` — an operator restart re-engages a fresh sub-agent.
 */
export type TaskLifecycleTrigger =
  | "session_active"
  | "session_blocked"
  | "awaiting_user"
  | "completion_reported"
  | "validation_passed"
  | "validation_failed"
  | "retrying"
  | "unrecoverable"
  | "interrupted"
  | "archived"
  | "reopened"
  | "restarted";

/**
 * The single legal-transition table: `from × trigger → to`. A trigger absent
 * from a `from` state's row is illegal from that state and {@link nextTaskStatus}
 * rejects it — this is what makes "`failed` has no producer" structurally
 * impossible to reintroduce (the `unrecoverable` edges are the producer) and
 * stops a stale `active` from stomping `blocked`/`validating`/terminal.
 *
 * Terminal states (`done`/`failed`/`archived`) only leave via the operator
 * triggers (`reopened`/`restarted`/`archived`); no session event mutates them.
 * A same-status self-edge is always legal and is a no-op the caller can skip.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<
    OrchestratorTaskStatus,
    Partial<Record<TaskLifecycleTrigger, OrchestratorTaskStatus>>
  >
> = {
  open: {
    session_active: "active",
    session_blocked: "blocked",
    awaiting_user: "waiting_on_user",
    completion_reported: "validating",
    unrecoverable: "failed",
    interrupted: "interrupted",
    archived: "archived",
  },
  active: {
    session_blocked: "blocked",
    awaiting_user: "waiting_on_user",
    completion_reported: "validating",
    retrying: "active",
    unrecoverable: "failed",
    interrupted: "interrupted",
    archived: "archived",
  },
  waiting_on_user: {
    session_blocked: "blocked",
    completion_reported: "validating",
    retrying: "active",
    unrecoverable: "failed",
    interrupted: "interrupted",
    archived: "archived",
  },
  blocked: {
    awaiting_user: "waiting_on_user",
    completion_reported: "validating",
    retrying: "active",
    unrecoverable: "failed",
    interrupted: "interrupted",
    archived: "archived",
  },
  validating: {
    validation_passed: "done",
    validation_failed: "active",
    awaiting_user: "waiting_on_user",
    retrying: "active",
    unrecoverable: "failed",
    interrupted: "interrupted",
    archived: "archived",
  },
  interrupted: {
    completion_reported: "validating",
    retrying: "active",
    restarted: "active",
    unrecoverable: "failed",
    archived: "archived",
  },
  done: {
    reopened: "open",
    restarted: "active",
    archived: "archived",
  },
  failed: {
    reopened: "open",
    restarted: "active",
    archived: "archived",
  },
  archived: {
    reopened: "open",
    restarted: "active",
  },
};

/**
 * Resolve the target status for a `(from, trigger)` pair against
 * {@link TASK_STATUS_TRANSITIONS}. Throws on an illegal transition — callers
 * never fall back to a silent default, so an illegal move surfaces as a bug at
 * its origin rather than as a mis-set status downstream. Use this at call sites
 * where the trigger MUST be legal (operator lifecycle actions); use
 * {@link resolveTaskTransition} on the event-bridge path where a stale/out-of-
 * order session event legitimately doesn't apply and should be a no-op.
 */
export function nextTaskStatus(
  from: OrchestratorTaskStatus,
  trigger: TaskLifecycleTrigger,
): OrchestratorTaskStatus {
  const to = resolveTaskTransition(from, trigger);
  if (to !== null) return to;
  throw new Error(
    `Illegal task transition: no edge for trigger "${trigger}" from status "${from}"`,
  );
}

/**
 * Table lookup that returns `null` (not a throw) for an illegal transition, so
 * the event bridge can drop a session event that doesn't apply to the current
 * status (a late `session_active` after the task already reached `validating`)
 * without crashing the write path.
 */
export function resolveTaskTransition(
  from: OrchestratorTaskStatus,
  trigger: TaskLifecycleTrigger,
): OrchestratorTaskStatus | null {
  return TASK_STATUS_TRANSITIONS[from][trigger] ?? null;
}
