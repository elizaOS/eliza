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
  roomId?: string;
  taskRoomId?: string;
  /** Lineage: the task this one was forked from, if any. */
  parentTaskId?: string;
  forkSource?: string;
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
 * Legal task-status transitions keyed by the current status. A task moves
 * between working states as its sub-agent sessions report progress, parks on
 * `waiting_on_user`/`blocked` when it needs input, and reaches exactly one
 * terminal status (`done`, `failed`, `archived`) that it can never leave.
 *
 * Two invariants make this the single source of truth: `failed` is reachable
 * from every non-terminal working state (a session can crash at any point), and
 * `done` is reachable only from `validating` (completion is gated on
 * verification). `advanceTaskStatus` enforces the map so an unmodeled write —
 * e.g. the historically missing `failed` producer (#13771), or a stray attempt
 * to jump straight to `done` without verifying — is rejected and logged rather
 * than silently corrupting the durable task record.
 */
export const LEGAL_TASK_STATUS_TRANSITIONS: Record<
  OrchestratorTaskStatus,
  ReadonlySet<OrchestratorTaskStatus>
> = {
  open: new Set([
    "active",
    "waiting_on_user",
    "blocked",
    "validating",
    "failed",
    "interrupted",
  ]),
  active: new Set([
    "waiting_on_user",
    "blocked",
    "validating",
    "failed",
    "interrupted",
  ]),
  waiting_on_user: new Set([
    "active",
    "blocked",
    "validating",
    "failed",
    "interrupted",
  ]),
  blocked: new Set([
    "active",
    "waiting_on_user",
    "validating",
    "failed",
    "interrupted",
  ]),
  validating: new Set([
    "active",
    "waiting_on_user",
    "blocked",
    "done",
    "failed",
    "interrupted",
  ]),
  interrupted: new Set([
    "active",
    "waiting_on_user",
    "blocked",
    "validating",
    "failed",
  ]),
  done: new Set(),
  failed: new Set(),
  archived: new Set(),
};

/** Whether the task lifecycle permits moving directly from `from` to `to`.
 * Terminal statuses have no outbound transitions. */
export function isLegalTaskStatusTransition(
  from: OrchestratorTaskStatus,
  to: OrchestratorTaskStatus,
): boolean {
  return LEGAL_TASK_STATUS_TRANSITIONS[from]?.has(to) ?? false;
}
