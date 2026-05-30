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
