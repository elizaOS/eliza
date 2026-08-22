/**
 * LifeOps decorates the runtime-owned approval execution capability with owner
 * prompts and escalation tasks. The agent service remains the
 * only SQL state-machine implementation, so every consumer shares the same
 * subject-scoped CAS and durable execution-attempt protocol.
 */
import { randomUUID } from "node:crypto";
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  createApprovalQueue as createRuntimeApprovalQueue,
  getAgentEventService,
  PgApprovalQueue as RuntimePgApprovalQueue,
  resolveApprovalService,
} from "@elizaos/agent";
import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskInput,
} from "@elizaos/plugin-scheduling";
import type {
  ApprovalAction,
  ApprovalChannel,
  ApprovalEnqueueInput,
  ApprovalEnqueueResult,
  ApprovalExecutionCapability,
  ApprovalExecutionClaim,
  ApprovalExecutionCompletion,
  ApprovalExecutionFailure,
  ApprovalExecutionMutation,
  ApprovalExecutionReconciliation,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalResolution,
} from "./approval-queue.types.js";
import { ApprovalQueueCompatibilityError } from "./approval-queue.types.js";
import { getChannelRegistry } from "./channels/index.js";
import { buildApprovalChoiceText } from "./choice-markers.js";
import type { TransactionalDb } from "./sql.js";

interface AssistantEventEmitter {
  emit?: (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    agentId?: string;
  }) => void;
}

function emitApprovalChoiceEvent(
  runtime: IAgentRuntime,
  input: { requestId: string; reason: string; action: ApprovalAction },
): void {
  const eventService = getAgentEventService(
    runtime,
  ) as AssistantEventEmitter | null;
  if (!eventService?.emit) return;
  eventService.emit({
    runId: randomUUID(),
    stream: "assistant",
    agentId: String(runtime.agentId),
    data: {
      text: buildApprovalChoiceText(input),
      source: "lifeops-approval",
      requestId: input.requestId,
      action: input.action,
    },
  });
}

const APPROVAL_ESCALATION_CHANNEL_ORDER = [
  "telegram",
  "signal",
  "whatsapp",
  "discord",
  "sms",
  "voice",
  "imessage",
  "email",
  "x_dm",
  "push",
  "in_app",
] as const;

function approvalEscalationSteps(
  runtime: IAgentRuntime,
  preferredChannel: ApprovalChannel,
): NonNullable<ScheduledTaskInput["escalation"]>["steps"] {
  const registry = getChannelRegistry(runtime);
  const registered = new Set(registry?.list().map((channel) => channel.kind));
  const ordered = [preferredChannel, ...APPROVAL_ESCALATION_CHANNEL_ORDER];
  const seen = new Set<string>();
  return ordered
    .filter((channelKey) => {
      if (seen.has(channelKey) || !registered.has(channelKey)) return false;
      seen.add(channelKey);
      const channel = registry?.get(channelKey);
      return (
        channelKey === "push" ||
        channelKey === "in_app" ||
        Boolean(channel?.send)
      );
    })
    .map((channelKey, index) => ({
      channelKey,
      delayMinutes: index === 0 ? 0 : 15,
      intensity: index === 0 ? "normal" : "urgent",
    }));
}

async function scheduleApprovalTask(
  runtime: IAgentRuntime,
  input: {
    agentId: string;
    requestId: string;
    subjectUserId: string;
    action: ApprovalAction;
    channel: ApprovalChannel;
    reason: string;
    requestedBy: string;
    createdAt: Date;
  },
): Promise<string> {
  const runner = getScheduledTaskRunner(runtime, { agentId: input.agentId });
  const task = await runner.schedule({
    kind: "approval",
    promptInstructions: `Approval needed: ${input.reason}. Reply "approve ${input.requestId}" or "reject ${input.requestId}".`,
    trigger: { kind: "once", atIso: input.createdAt.toISOString() },
    priority: "high",
    completionCheck: {
      kind: "user_acknowledged",
      params: { requestId: input.requestId },
    },
    escalation: {
      steps: approvalEscalationSteps(runtime, input.channel),
    },
    output: {
      destination: "in_app_card",
      fallback: {
        title: "Approval needed",
        body: `${input.reason} Reply "approve ${input.requestId}" or "reject ${input.requestId}".`,
      },
    },
    subject: { kind: "self", id: input.subjectUserId },
    idempotencyKey: `approval:${input.requestId}`,
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: input.agentId,
    ownerVisible: true,
    metadata: {
      approvalRequestId: input.requestId,
      approvalAction: input.action,
      approvalChannel: input.channel,
      requestedBy: input.requestedBy,
      pendingPromptRoomId: `approval:${input.requestId}`,
      pendingPromptAction: input.action,
    },
  });
  logger.info(
    `[ApprovalQueue] scheduled approval task ${task.taskId} for ${input.requestId}`,
  );
  return task.taskId;
}

export interface ApprovalQueueOptions {
  readonly agentId: string;
}

class LifeOpsApprovalQueue implements ApprovalQueue {
  readonly capability = APPROVAL_EXECUTION_CAPABILITY;
  readonly protocolVersion = APPROVAL_EXECUTION_PROTOCOL_VERSION;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
    private readonly delegate: ApprovalExecutionCapability,
  ) {}

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    return (await this.enqueueWithResult(input)).request;
  }

  /**
   * A replayed idempotency key returns the existing row untouched: the owner
   * already has a task and a prompt for it, and re-surfacing would duplicate
   * both.
   */
  async enqueueWithResult(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult> {
    const enqueued = await this.delegate.enqueueWithResult(input);
    if (enqueued.reused) return enqueued;
    try {
      await this.surfaceEnqueuedApproval(enqueued.request);
    } catch (error) {
      // error-policy:J2 The approval row and ScheduledTask are one owner-visible
      // operation. Remove the still-pending row before adding context.
      await this.delegate.removePending(
        enqueued.request.id,
        input.subjectUserId,
      );
      throw new Error(
        `[ApprovalQueue] failed to schedule approval task for ${enqueued.request.id}; rolled back approval row`,
        { cause: error },
      );
    }
    return enqueued;
  }

  /**
   * The owner already confirmed this at an authenticated boundary, so no task,
   * chat choice, or notification is raised — a prompt here would ask for
   * consent that was just given.
   */
  enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.delegate.enqueueConfirmed(input, resolution);
  }

  enqueueTransactional(
    input: ApprovalEnqueueInput,
    tx: TransactionalDb,
  ): Promise<ApprovalEnqueueResult> {
    return this.delegate.enqueueTransactional(input, tx);
  }

  async surfaceEnqueuedApproval(request: ApprovalRequest): Promise<void> {
    await scheduleApprovalTask(this.runtime, {
      agentId: this.agentId,
      requestId: request.id,
      subjectUserId: request.subjectUserId,
      action: request.action,
      channel: request.channel,
      reason: request.reason,
      requestedBy: request.requestedBy,
      createdAt: request.createdAt,
    });
    try {
      emitApprovalChoiceEvent(this.runtime, {
        requestId: request.id,
        reason: request.reason,
        action: request.action,
      });
    } catch (error) {
      // error-policy:J7 Chat choice emission is a diagnostic side-channel.
      this.runtime.reportError("ApprovalQueue.chatChoice", error, {
        requestId: request.id,
        action: request.action,
      });
    }
  }

  list(filter: ApprovalListFilter): Promise<ReadonlyArray<ApprovalRequest>> {
    return this.delegate.list(filter);
  }

  byId(id: string, subjectUserId: string): Promise<ApprovalRequest | null> {
    return this.delegate.byId(id, subjectUserId);
  }

  byIdempotencyKey(
    idempotencyKey: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    return this.delegate.byIdempotencyKey(idempotencyKey, subjectUserId);
  }

  approve(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.delegate.approve(id, subjectUserId, resolution);
  }

  reject(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.delegate.reject(id, subjectUserId, resolution);
  }

  claimExecution(claim: ApprovalExecutionClaim): Promise<ApprovalRequest> {
    return this.delegate.claimExecution(claim);
  }

  markDispatchStarted(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest> {
    return this.delegate.markDispatchStarted(mutation);
  }

  markDone(completion: ApprovalExecutionCompletion): Promise<ApprovalRequest> {
    return this.delegate.markDone(completion);
  }

  markRetryableFailure(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest> {
    return this.delegate.markRetryableFailure(failure);
  }

  markReconciliationRequired(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest> {
    return this.delegate.markReconciliationRequired(failure);
  }

  recoverUnstartedExecution(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest> {
    return this.delegate.recoverUnstartedExecution(mutation);
  }

  reconcileExecution(
    reconciliation: ApprovalExecutionReconciliation,
  ): Promise<ApprovalRequest> {
    return this.delegate.reconcileExecution(reconciliation);
  }

  markExpired(id: string, subjectUserId: string): Promise<ApprovalRequest> {
    return this.delegate.markExpired(id, subjectUserId);
  }

  removePending(id: string, subjectUserId: string): Promise<void> {
    return this.delegate.removePending(id, subjectUserId);
  }

  purgeExpired(now: Date): Promise<ReadonlyArray<string>> {
    return this.delegate.purgeExpired(now);
  }
}

function assertExecutionCapability(
  candidate: unknown,
): ApprovalExecutionCapability {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    (candidate as { capability?: unknown }).capability !==
      APPROVAL_EXECUTION_CAPABILITY ||
    (candidate as { protocolVersion?: unknown }).protocolVersion !==
      APPROVAL_EXECUTION_PROTOCOL_VERSION
  ) {
    throw new ApprovalQueueCompatibilityError(
      (candidate as { capability?: unknown } | null)?.capability,
      (candidate as { protocolVersion?: unknown } | null)?.protocolVersion,
    );
  }
  return candidate as ApprovalExecutionCapability;
}

export function createApprovalQueue(
  runtime: IAgentRuntime,
  options: ApprovalQueueOptions,
): ApprovalQueue {
  const service = resolveApprovalService(runtime);
  const candidate = service
    ? service.getExecutionCapability(
        APPROVAL_EXECUTION_PROTOCOL_VERSION,
        options.agentId,
      )
    : createRuntimeApprovalQueue(runtime, options);
  return new LifeOpsApprovalQueue(
    runtime,
    options.agentId,
    assertExecutionCapability(candidate),
  );
}

export { RuntimePgApprovalQueue as PgApprovalQueue };
