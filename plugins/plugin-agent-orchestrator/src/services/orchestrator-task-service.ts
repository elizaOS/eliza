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
import { type IAgentRuntime, Service } from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import {
  buildGoalFollowUp,
  buildGoalPrompt,
  type GoalFollowUpReason,
} from "./goal-prompt.js";
import {
  summarizeUsage,
  summarizeUsageRows,
  type TaskThreadDetailDto,
  type TaskThreadDto,
  toTaskThread,
  toTaskThreadDetail,
} from "./orchestrator-task-mapper.js";
import { OrchestratorTaskStore } from "./orchestrator-task-store.js";
import {
  type CreateTaskInput,
  type OrchestratorTaskDocument,
  type OrchestratorTaskUsage,
  type OrchestratorTaskRecord,
  type OrchestratorTaskSession,
  type OrchestratorTaskStatus,
  type TaskListFilter,
  type TaskMessageDirection,
  type TaskMessageSenderKind,
  type TaskUsageSummary,
  TERMINAL_TASK_SESSION_STATUSES,
  TERMINAL_TASK_STATUSES,
  type UsageState,
} from "./orchestrator-task-types.js";
import type { ApprovalPreset } from "./types.js";
import { resolveAllowedWorkdir } from "./workdir-validation.js";

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
      this.unsubscribe = acp.onSessionEvent((sessionId, event, data) => {
        void this.onSessionEvent(sessionId, event, data);
      });
    } else {
      this.log(
        "warn",
        "ACP service unavailable at start; session events will not be recorded",
      );
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
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
    const evidence = result.evidence ?? result.summary;
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
    if (acp && active.length > 0) {
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
    }
    return { recorded: true, forwardedTo, failedTo };
  }

  async listMessages(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<OrchestratorTaskDocument["messages"][number]>> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return { items: [], nextCursor: null };
    return paginate(doc.messages, opts);
  }

  async listEvents(
    taskId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PageResult<OrchestratorTaskDocument["events"][number]>> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return { items: [], nextCursor: null };
    return paginate(doc.events, opts);
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
    const goalPrompt = buildGoalPrompt({
      goal: doc.task.goal,
      task: opts.task ?? doc.task.goal,
      acceptanceCriteria: doc.task.acceptanceCriteria,
      taskRoomId: doc.task.taskRoomId ?? doc.task.roomId,
      workdir,
      repo: opts.repo,
    });

    const result = await acp.spawnSession({
      agentType: opts.framework ?? policy.preferredFramework,
      workdir,
      initialTask: goalPrompt,
      model: opts.model ?? policy.model,
      approvalPreset: opts.approvalPreset,
      metadata: {
        taskId,
        roomId: doc.task.taskRoomId ?? doc.task.roomId,
        label: opts.label,
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
      label: opts.label ?? `${result.agentType} agent`,
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
      senderKind: reason === "orchestrator" ? "orchestrator" : "user",
      sessionId,
      direction: "stdin",
    });
    await this.store.updateSession(sessionId, { lastInputSentAt: Date.now() });
    await acp.sendToSession(sessionId, followUp);
    return true;
  }

  async stopTaskAgent(taskId: string, sessionId: string): Promise<boolean> {
    const doc = await this.store.getTask(taskId);
    if (!doc) return false;
    const session = doc.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return false;
    const acp = this.acp();
    if (acp) {
      try {
        await acp.stopSession(sessionId);
      } catch (err) {
        await this.store.updateSession(sessionId, {
          status: "stop_failed",
        });
        throw err;
      }
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
    const acp = this.acp();
    if (!acp) return;
    const active = doc.sessions.filter(
      (s) => !TERMINAL_TASK_SESSION_STATUSES.has(s.status),
    );
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
      throw new Error(
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
