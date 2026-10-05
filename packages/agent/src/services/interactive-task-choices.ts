/** Task binding over the existing durable message-interaction protocol. */
import { createHash } from "node:crypto";
import {
  BUTTON_INTERACTION_PROFILE,
  createConnectorInteractionCapabilityProfile,
  decodeMessageInteractionCallback,
  encodeMessageInteractionCallback,
  type MessageInteractionSession,
  MessageInteractionSessionAuthority,
  type MessageInteractionSessionStore,
} from "@elizaos/core";
import type { InteractiveTask } from "@elizaos/core/protocol";
import {
  ElizaError,
  type TaskChoiceWidget,
  validateTaskChoiceWidget,
} from "@elizaos/core/protocol";
import type { InteractiveTaskRuntime } from "./interactive-task-runtime.ts";

function fail(): never {
  throw new ElizaError("Task choice is no longer current", {
    code: "TASK_CHOICE_STALE",
  });
}
function bindings(task: InteractiveTask, contextKey: string, choiceId: string) {
  return {
    ...task.owner,
    audience: { kind: "task", id: task.id },
    roomId: task.id,
    sourceMessageId: `${task.id}:${task.epoch}:${contextKey}:${choiceId}`,
  };
}
function referenceFor(
  task: InteractiveTask,
  contextKey: string,
  block: TaskChoiceWidget["block"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        task.id,
        task.owner.actorId,
        task.owner.agentId,
        task.owner.connector,
        task.epoch,
        task.authorization.decisionId,
        contextKey,
        block.id,
        block.scope,
        block.prompt ?? null,
        block.options.map((option) => [
          option.value,
          option.label,
          option.description ?? null,
        ]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}
export class InteractiveTaskChoices {
  constructor(
    private readonly runtime: InteractiveTaskRuntime,
    private readonly store: MessageInteractionSessionStore,
    private readonly clock: () => number = Date.now,
  ) {}
  private active(taskId: string): InteractiveTask {
    const task = this.runtime.get(taskId);
    if (task.status !== "active" || task.authorization.state !== "active")
      fail();
    return task;
  }
  private matches(
    session: MessageInteractionSession,
    task: InteractiveTask,
    contextKey: string,
  ): boolean {
    const meta = session.effect.metadata;
    return (
      session.authorization.state === "active" &&
      session.effect.kind === "task-choice" &&
      meta?.taskId === task.id &&
      meta.epoch === task.epoch &&
      meta.contextKey === contextKey &&
      typeof meta.choiceId === "string" &&
      session.authorization.decisionId === task.authorization.decisionId &&
      session.bindings.actorId === task.owner.actorId &&
      session.bindings.agentId === task.owner.agentId &&
      session.bindings.connector.source === task.owner.connector.source &&
      session.bindings.connector.accountId === task.owner.connector.accountId
    );
  }
  async offer(
    taskId: string,
    contextKey: string,
    block: TaskChoiceWidget["block"],
  ): Promise<TaskChoiceWidget> {
    block = structuredClone(block);
    const task = this.active(taskId);
    // Identical rerenders reuse one session. Context includes product review facts;
    // epoch and authority prevent reuse after Pause, restart or account changes.
    const reference = referenceFor(task, contextKey, block);
    const widget: TaskChoiceWidget = {
      schemaVersion: 1,
      taskId,
      epoch: task.epoch,
      contextKey,
      callbackData: encodeMessageInteractionCallback(reference),
      expiresAt: new Date(this.clock() + 10 * 60 * 1000).toISOString(),
      state: "pending",
      block: structuredClone(block),
    };
    validateTaskChoiceWidget(widget);
    let session = await this.store.get(reference);
    if (!session) {
      const authority = new MessageInteractionSessionAuthority(this.store, {
        clock: this.clock,
        referenceFactory: () => reference,
      });
      try {
        session = (
          await authority.create({
            block,
            profile: createConnectorInteractionCapabilityProfile({
              template: BUTTON_INTERACTION_PROFILE,
              source: task.owner.connector.source,
              accountId: task.owner.connector.accountId,
              targetKind: "task",
              targetId: task.id,
            }),
            bindings: bindings(task, contextKey, block.id),
            purpose: "choice",
            flow: "native",
            authorization: {
              decisionId: task.authorization.decisionId,
              policyRevision: task.authorization.policyRevision,
              decidedAt: task.authorization.decidedAt,
            },
            effect: {
              kind: "task-choice",
              metadata: {
                taskId,
                epoch: task.epoch,
                contextKey,
                choiceId: block.id,
              },
            },
            expiresAt: widget.expiresAt,
          })
        ).session;
      } catch (error) {
        if (
          !(error instanceof ElizaError) ||
          error.code !== "MESSAGE_INTERACTION_ALREADY_EXISTS"
        )
          throw error;
        session = await this.store.get(reference);
      }
    }
    const current = this.active(taskId);
    if (!session || !this.matches(session, current, contextKey)) fail();
    widget.expiresAt = session.expiresAt;
    widget.state = session.consume.state;
    return widget;
  }
  /** Rehydrate a host-issued presentation without creating a new offer or effect. */
  async refresh(value: TaskChoiceWidget): Promise<TaskChoiceWidget> {
    validateTaskChoiceWidget(value);
    const widget = structuredClone(value);
    const task = this.active(widget.taskId);
    const reference = decodeMessageInteractionCallback(widget.callbackData);
    if (
      !reference ||
      widget.epoch !== task.epoch ||
      reference !== referenceFor(task, widget.contextKey, widget.block)
    )
      fail();
    const session = await this.store.get(reference);
    const current = this.active(widget.taskId);
    if (
      !session ||
      !this.matches(session, current, widget.contextKey) ||
      Date.parse(session.expiresAt) <= this.clock()
    )
      fail();
    return {
      ...widget,
      expiresAt: session.expiresAt,
      state: session.consume.state,
    };
  }
  async respond(args: {
    taskId: string;
    contextKey: string;
    callbackData: string;
    value: string;
    execute: (input: {
      value: string;
      operationId: string;
      isCurrent: () => boolean;
    }) => Promise<Record<string, string | number | boolean | null>>;
  }) {
    const reference = decodeMessageInteractionCallback(args.callbackData);
    if (!reference) fail();
    const task = this.active(args.taskId),
      session = await this.store.get(reference);
    if (!session || !this.matches(session, task, args.contextKey)) fail();
    const choiceId = session.effect.metadata?.choiceId;
    if (typeof choiceId !== "string") fail();
    const isCurrent = () => {
      try {
        return this.matches(session, this.active(args.taskId), args.contextKey);
      } catch {
        return false;
      }
    };
    if (!isCurrent()) fail();
    return new MessageInteractionSessionAuthority(this.store, {
      clock: this.clock,
    }).consumeWithOutcome({
      callbackData: args.callbackData,
      bindings: bindings(task, args.contextKey, choiceId),
      replayKey: `task-choice:${reference}`,
      response: { value: args.value },
      executor: {
        execute: async ({ idempotencyKey, response }) => {
          if (!isCurrent() || typeof response.value !== "string") fail();
          const result = await args.execute({
            value: response.value,
            operationId: `choice-${reference}`,
            isCurrent,
          });
          return {
            receiptId: `choice-${reference}`,
            idempotencyKey,
            status: "completed",
            completedAt: new Date(this.clock()).toISOString(),
            result,
          };
        },
      },
    });
  }
}
