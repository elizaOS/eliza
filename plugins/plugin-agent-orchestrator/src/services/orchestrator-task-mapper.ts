/**
 * Maps the durable {@link OrchestratorTaskDocument} into the wire DTOs the
 * `/orchestrator` frontend consumes. These shapes mirror
 * `packages/ui/src/api/client-types-cloud.ts` (`CodingAgentTaskThread` /
 * `CodingAgentTaskThreadDetail`) and extend them with the orchestrator-native
 * fields the research report calls for: priority, pause state, provider policy,
 * the full room-message timeline, and a token/cost usage summary. The plugin
 * and `packages/ui` are separate packages communicating over HTTP, so the
 * structural agreement between these DTOs and the client types is enforced by
 * a contract test rather than a shared import.
 *
 * @module services/orchestrator-task-mapper
 */

import type {
  ArtifactVerificationStatus,
  OrchestratorTaskDocument,
  OrchestratorTaskPriority,
  OrchestratorTaskStatus,
  OrchestratorTaskUsage,
  TaskMessageDirection,
  TaskMessageSenderKind,
  TaskProviderPolicy,
  TaskUsageSummary,
  UsageState,
} from "./orchestrator-task-types.js";
import { TERMINAL_TASK_SESSION_STATUSES } from "./orchestrator-task-types.js";

/** Admission-queue state surfaced on a task when it is parked at the session
 * cap (#13772). `position` is 1-based and filled by the service from the live
 * dispatch order; the mapper derives only `state` + `enqueuedAt` from durable
 * metadata (it has no view of the in-memory order), leaving `position` at 0. */
export interface TaskAdmissionDto {
  state: "queued";
  position: number;
  enqueuedAt: string;
}

export interface TaskThreadDto {
  id: string;
  title: string;
  kind: string;
  status: OrchestratorTaskStatus;
  priority: OrchestratorTaskPriority;
  paused: boolean;
  originalRequest: string;
  summary?: string;
  sessionCount: number;
  activeSessionCount: number;
  latestSessionId: string | null;
  latestSessionLabel: string | null;
  latestSessionModel: string | null;
  latestAccountProviderId: string | null;
  latestAccountId: string | null;
  latestAccountLabel: string | null;
  parentTaskId: string | null;
  /**
   * The task's stable workdir/repo. Prefers the durable binding pinned at first
   * spawn (`task.boundWorkdir`/`boundRepo`) over the most-recent session's
   * workdir so the UI shows where follow-up spawns will actually land, not just
   * where the last one happened to run. Falls back to the latest session for
   * pre-binding tasks. See #13776 item 3.
   */
  latestWorkdir: string | null;
  latestRepo: string | null;
  /** Registered Project this task is bound to (null = unbound). Lets the task
   * list group by project without fetching each task's detail. */
  projectId: string | null;
  latestActivityAt: number | null;
  decisionCount: number;
  usage: TaskUsageSummary;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
  /** Present only while the task is parked in the admission queue. */
  admission?: TaskAdmissionDto;
}

export interface TaskSessionDto {
  id: string;
  threadId: string;
  sessionId: string;
  framework: string;
  providerSource: string | null;
  model: string | null;
  accountProviderId: string | null;
  accountId: string | null;
  accountLabel: string | null;
  label: string;
  originalTask: string;
  workdir: string;
  repo: string | null;
  status: string;
  activeTool: string | null;
  decisionCount: number;
  autoResolvedCount: number;
  registeredAt: number;
  lastActivityAt: number;
  idleCheckCount: number;
  taskDelivered: boolean;
  completionSummary: string | null;
  lastSeenDecisionIndex: number;
  lastInputSentAt: number | null;
  stoppedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheTokens: number;
  costUsd: number;
  usageState: UsageState;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDecisionDto {
  id: string;
  threadId: string;
  sessionId: string;
  event: string;
  promptText: string;
  decision: string;
  response: string | null;
  reasoning: string;
  timestamp: number;
  createdAt: string;
}

export interface TaskEventDto {
  id: string;
  threadId: string;
  sessionId: string | null;
  eventType: string;
  timestamp: number;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TaskArtifactDto {
  id: string;
  threadId: string;
  sessionId: string | null;
  artifactType: string;
  title: string;
  path: string | null;
  uri: string | null;
  mimeType: string | null;
  verificationStatus: ArtifactVerificationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskMessageDto {
  id: string;
  threadId: string;
  sessionId: string | null;
  senderKind: TaskMessageSenderKind;
  direction: TaskMessageDirection;
  content: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type TaskTimelineItemDto =
  | {
      id: string;
      kind: "message";
      threadId: string;
      sessionId: string | null;
      timestamp: number;
      createdAt: string;
      message: TaskMessageDto;
    }
  | {
      id: string;
      kind: "event";
      threadId: string;
      sessionId: string | null;
      timestamp: number;
      createdAt: string;
      event: TaskEventDto;
    };

export interface TaskTranscriptDto {
  id: string;
  threadId: string;
  sessionId: string;
  timestamp: number;
  direction: TaskMessageDirection;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskPlanRevisionDto {
  id: string;
  threadId: string;
  plan: Record<string, unknown>;
  basePlanRevisionId: string | null;
  editSummary: string | null;
  createdBy: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export interface TaskThreadDetailDto extends TaskThreadDto {
  goal: string;
  roomId: string | null;
  taskRoomId: string | null;
  worldId: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  parentTaskId: string | null;
  acceptanceCriteria: string[];
  currentPlan: Record<string, unknown> | null;
  providerPolicy: TaskProviderPolicy | null;
  lastUserTurnAt: string | null;
  lastCoordinatorTurnAt: string | null;
  metadata: Record<string, unknown>;
  sessions: TaskSessionDto[];
  decisions: TaskDecisionDto[];
  events: TaskEventDto[];
  artifacts: TaskArtifactDto[];
  messages: TaskMessageDto[];
  transcripts: TaskTranscriptDto[];
  planRevisions: TaskPlanRevisionDto[];
}

function latestSession(doc: OrchestratorTaskDocument) {
  return doc.sessions.reduce<
    OrchestratorTaskDocument["sessions"][number] | null
  >(
    (latest, session) =>
      !latest || session.lastActivityAt > latest.lastActivityAt
        ? session
        : latest,
    null,
  );
}

function rollUpUsageState(states: UsageState[]): UsageState {
  if (states.length === 0 || states.includes("unavailable")) {
    return "unavailable";
  }
  if (states.includes("estimated")) return "estimated";
  return "measured";
}

export function toTaskEventDto(
  event: OrchestratorTaskDocument["events"][number],
): TaskEventDto {
  return {
    id: event.id,
    threadId: event.taskId,
    sessionId: event.sessionId ?? null,
    eventType: event.eventType,
    timestamp: event.timestamp,
    summary: event.summary,
    data: event.data,
    createdAt: event.createdAt,
  };
}

export function toTaskMessageDto(
  message: OrchestratorTaskDocument["messages"][number],
): TaskMessageDto {
  return {
    id: message.id,
    threadId: message.taskId,
    sessionId: message.sessionId ?? null,
    senderKind: message.senderKind,
    direction: message.direction,
    content: message.content,
    timestamp: message.timestamp,
    metadata: message.metadata,
    createdAt: message.createdAt,
  };
}

export function toTaskTimelineMessageDto(
  message: OrchestratorTaskDocument["messages"][number],
): TaskTimelineItemDto {
  const dto = toTaskMessageDto(message);
  return {
    id: `message:${message.id}`,
    kind: "message",
    threadId: dto.threadId,
    sessionId: dto.sessionId,
    timestamp: dto.timestamp,
    createdAt: dto.createdAt,
    message: dto,
  };
}

export function toTaskTimelineEventDto(
  event: OrchestratorTaskDocument["events"][number],
): TaskTimelineItemDto {
  const dto = toTaskEventDto(event);
  return {
    id: `event:${event.id}`,
    kind: "event",
    threadId: dto.threadId,
    sessionId: dto.sessionId,
    timestamp: dto.timestamp,
    createdAt: dto.createdAt,
    event: dto,
  };
}

export function toTaskPlanRevisionDto(
  revision: OrchestratorTaskDocument["planRevisions"][number],
): TaskPlanRevisionDto {
  return {
    id: revision.id,
    threadId: revision.taskId,
    plan: structuredClone(revision.plan),
    basePlanRevisionId: revision.basePlanRevisionId ?? null,
    editSummary: revision.editSummary ?? null,
    createdBy: revision.createdBy,
    metadata: structuredClone(revision.metadata),
    timestamp: revision.timestamp,
    createdAt: revision.createdAt,
  };
}

/** Aggregate per-session usage into the by-provider breakdown plus a total. The
 * state is rolled up so the UI can render measured / estimated / unavailable
 * distinctly instead of showing a confident `0`. */
export function summarizeUsageRows(
  usage: readonly OrchestratorTaskUsage[],
): TaskUsageSummary {
  const byKey = new Map<
    string,
    TaskUsageSummary["byProvider"][number] & { states: UsageState[] }
  >();
  for (const entry of usage) {
    const key = `${entry.provider}::${entry.model ?? ""}`;
    const bucket = byKey.get(key) ?? {
      provider: entry.provider,
      model: entry.model,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable" as UsageState,
      states: [] as UsageState[],
    };
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.reasoningTokens += entry.reasoningTokens;
    bucket.cacheTokens += entry.cacheTokens;
    bucket.costUsd += entry.costUsd ?? 0;
    bucket.states.push(entry.state);
    byKey.set(key, bucket);
  }

  const byProvider = [...byKey.values()].map((bucket) => {
    const totalTokens =
      bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens;
    const { states, ...rest } = bucket;
    return { ...rest, totalTokens, state: rollUpUsageState(states) };
  });

  const total = byProvider.reduce(
    (acc, provider) => {
      acc.inputTokens += provider.inputTokens;
      acc.outputTokens += provider.outputTokens;
      acc.reasoningTokens += provider.reasoningTokens;
      acc.cacheTokens += provider.cacheTokens;
      acc.costUsd += provider.costUsd;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
    },
  );

  return {
    ...total,
    totalTokens: total.inputTokens + total.outputTokens + total.reasoningTokens,
    state: rollUpUsageState(byProvider.map((p) => p.state)),
    byProvider,
  };
}

export function summarizeUsage(
  doc: OrchestratorTaskDocument,
): TaskUsageSummary {
  return summarizeUsageRows(doc.usage);
}

export function toTaskThread(doc: OrchestratorTaskDocument): TaskThreadDto {
  const latest = latestSession(doc);
  const latestRepo = Object.hasOwn(doc.task, "boundRepo")
    ? (doc.task.boundRepo ?? null)
    : (latest?.repo ?? null);
  const activeSessionCount = doc.sessions.filter(
    (session) => !TERMINAL_TASK_SESSION_STATUSES.has(session.status),
  ).length;
  const admission = deriveAdmission(doc);
  return {
    id: doc.task.id,
    title: doc.task.title,
    kind: doc.task.kind,
    status: doc.task.status,
    priority: doc.task.priority,
    paused: doc.task.paused,
    originalRequest: doc.task.originalRequest,
    summary: doc.task.summary,
    sessionCount: doc.sessions.length,
    activeSessionCount,
    latestSessionId: latest?.sessionId ?? null,
    latestSessionLabel: latest?.label ?? null,
    latestSessionModel: latest?.model ?? null,
    latestAccountProviderId: latest?.accountProviderId ?? null,
    latestAccountId: latest?.accountId ?? null,
    latestAccountLabel: latest?.accountLabel ?? null,
    parentTaskId: doc.task.parentTaskId ?? null,
    latestWorkdir: doc.task.boundWorkdir ?? latest?.workdir ?? null,
    latestRepo,
    projectId: doc.task.projectId ?? null,
    latestActivityAt: doc.task.lastActivityAt,
    decisionCount: doc.decisions.length,
    usage: summarizeUsage(doc),
    createdAt: doc.task.createdAt,
    updatedAt: doc.task.updatedAt,
    closedAt: doc.task.closedAt ?? null,
    archivedAt: doc.task.archivedAt ?? null,
    ...(admission ? { admission } : {}),
  };
}

/** Derive the admission DTO from a task's durable metadata. `position` stays 0
 * here — only the service, which holds the live dispatch order, can fill it. */
function deriveAdmission(
  doc: OrchestratorTaskDocument,
): TaskAdmissionDto | null {
  const admission = doc.task.metadata?.admission;
  if (
    typeof admission === "object" &&
    admission !== null &&
    (admission as Record<string, unknown>).state === "queued" &&
    typeof (admission as Record<string, unknown>).enqueuedAt === "string"
  ) {
    return {
      state: "queued",
      position: 0,
      enqueuedAt: (admission as Record<string, unknown>).enqueuedAt as string,
    };
  }
  return null;
}

export function toTaskThreadDetail(
  doc: OrchestratorTaskDocument,
): TaskThreadDetailDto {
  return {
    ...toTaskThread(doc),
    goal: doc.task.goal,
    roomId: doc.task.roomId ?? null,
    taskRoomId: doc.task.taskRoomId ?? null,
    worldId: doc.task.worldId ?? null,
    projectId: doc.task.projectId ?? null,
    ownerUserId: doc.task.ownerUserId ?? null,
    parentTaskId: doc.task.parentTaskId ?? null,
    acceptanceCriteria: doc.task.acceptanceCriteria,
    currentPlan: doc.task.currentPlan ?? null,
    providerPolicy: doc.task.providerPolicy ?? null,
    lastUserTurnAt: doc.task.lastUserTurnAt ?? null,
    lastCoordinatorTurnAt: doc.task.lastCoordinatorTurnAt ?? null,
    metadata: doc.task.metadata,
    sessions: doc.sessions.map((session) => ({
      id: session.id,
      threadId: session.taskId,
      sessionId: session.sessionId,
      framework: session.framework,
      providerSource: session.providerSource ?? null,
      model: session.model ?? null,
      accountProviderId: session.accountProviderId ?? null,
      accountId: session.accountId ?? null,
      accountLabel: session.accountLabel ?? null,
      label: session.label,
      originalTask: session.originalTask,
      workdir: session.workdir,
      repo: session.repo ?? null,
      status: session.status,
      activeTool: session.activeTool ?? null,
      decisionCount: session.decisionCount,
      autoResolvedCount: session.autoResolvedCount,
      registeredAt: session.registeredAt,
      lastActivityAt: session.lastActivityAt,
      idleCheckCount: session.idleCheckCount,
      taskDelivered: session.taskDelivered,
      completionSummary: session.completionSummary ?? null,
      lastSeenDecisionIndex: session.lastSeenDecisionIndex,
      lastInputSentAt: session.lastInputSentAt ?? null,
      stoppedAt: session.stoppedAt ?? null,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      reasoningTokens: session.reasoningTokens,
      totalTokens:
        session.inputTokens + session.outputTokens + session.reasoningTokens,
      cacheTokens: session.cacheTokens,
      costUsd: session.costUsd,
      usageState: session.usageState,
      metadata: session.metadata,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })),
    decisions: doc.decisions.map((decision) => ({
      id: decision.id,
      threadId: decision.taskId,
      sessionId: decision.sessionId ?? "",
      event: decision.event,
      promptText: decision.promptText,
      decision: decision.actionSelected,
      response: decision.response ?? null,
      reasoning: decision.reasoning,
      timestamp: decision.timestamp,
      createdAt: decision.createdAt,
    })),
    events: doc.events.map(toTaskEventDto),
    artifacts: doc.artifacts.map((artifact) => ({
      id: artifact.id,
      threadId: artifact.taskId,
      sessionId: artifact.sessionId ?? null,
      artifactType: artifact.artifactType,
      title: artifact.title,
      path: artifact.path ?? null,
      uri: artifact.uri ?? null,
      mimeType: artifact.mimeType ?? null,
      verificationStatus: artifact.verificationStatus,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
    })),
    messages: doc.messages.map(toTaskMessageDto),
    transcripts: doc.messages
      .filter((message) => message.sessionId)
      .map((message) => ({
        id: message.id,
        threadId: message.taskId,
        sessionId: message.sessionId as string,
        timestamp: message.timestamp,
        direction: message.direction,
        content: message.content,
        metadata: message.metadata,
        createdAt: message.createdAt,
      })),
    planRevisions: doc.planRevisions.map(toTaskPlanRevisionDto),
  };
}
