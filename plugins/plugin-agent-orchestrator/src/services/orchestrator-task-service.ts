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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import { assignAgentName } from "./agent-name-assignment.js";
import {
  buildGoalFollowUp,
  buildGoalPrompt,
  coerceGoalCapabilityProfile,
  type GoalFollowUpReason,
} from "./goal-prompt.js";
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
  type CreateTaskInput,
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
import type { ApprovalPreset } from "./types.js";
import {
  ensureTaskWorkdir,
  resolveAllowedWorkdir,
} from "./workdir-validation.js";

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
  databaseAdapter?: unknown;
  getSetting?: (key: string) => string | undefined | null;
};

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

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
  const state: UsageState =
    stateRaw === "measured" || stateRaw === "estimated" ? stateRaw : "measured";
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
        // ignore
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
      this.log("warn", "failed to record session event", {
        sessionId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
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
        // The sub-agent's todo/plan snapshot (already sanitized in AcpService)
        // becomes the task's durable currentPlan, which drives the plan/todo
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
        break;
      case "task_complete": {
        const summary = str(record.response);
        await this.store.updateSession(sessionId, {
          status: "completed",
          taskDelivered: true,
          completionSummary: summary ? truncate(summary) : undefined,
          stoppedAt: Date.now(),
        });
        await this.advanceTaskStatus(taskId, "validating");
        break;
      }
      case "error":
        await this.store.updateSession(sessionId, {
          status: "errored",
          stoppedAt: Date.now(),
        });
        break;
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
      default:
        break;
    }
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
    // `active` is the weakest signal: only promote into it from `open`.
    if (next === "active" && current !== "open") return;
    await this.store.updateTask(taskId, { status: next });
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
    const doc = await this.store.createTask(input);
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
    for (const session of doc.sessions)
      this.sessionTaskIndex.delete(session.sessionId);
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
        });
        await writeFile(join(workdir, "SKILLS.md"), manifest.markdown, "utf8");
      } catch (err) {
        this.runtime.logger?.warn?.(
          { src: "orchestrator-task-service", taskId, workdir },
          `failed to write SKILLS.md: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const result = await acp.spawnSession({
      // Default the orchestrator's coding agent to the vendored opencode
      // backend (auto-detects the user's Cerebras key) rather than the
      // unsupported "elizaos" native default, which has no ACP command.
      agentType: opts.framework ?? policy.preferredFramework ?? "opencode",
      workdir,
      initialTask: goalPrompt,
      model: opts.model ?? policy.model,
      approvalPreset: opts.approvalPreset,
      metadata: {
        taskId,
        roomId: doc.task.taskRoomId ?? doc.task.roomId,
        label: agentName,
        source: "orchestrator",
        // Orchestrator sessions outlive their first prompt so follow-ups and
        // validation re-dispatch can reuse them.
        keepAliveAfterComplete: true,
      },
    });

    const ts = nowIso();
    const session: OrchestratorTaskSession = {
      id: randomUUID(),
      taskId,
      sessionId: result.sessionId,
      framework: result.agentType,
      providerSource: opts.providerSource ?? policy.providerSource,
      model: opts.model ?? policy.model,
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
    await this.store.addSession(session);
    this.sessionTaskIndex.set(result.sessionId, taskId);
    await this.advanceTaskStatus(taskId, "active");
    return this.getTask(taskId);
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
