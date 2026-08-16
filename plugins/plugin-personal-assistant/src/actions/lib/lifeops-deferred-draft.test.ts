/**
 * Verifies that a pending owner-Todo draft cannot bypass its durable action
 * when Stage 1 claims the save already happened.
 */
import type {
  IAgentRuntime,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  coerceDeferredLifeDraft,
  type DeferredLifeDefinitionDraft,
  deferredOwnerTodoRoutingEvaluator,
  isExplicitScheduleDecline,
} from "./lifeops-deferred-draft.js";

function awaitingScheduleDraft(): DeferredLifeDefinitionDraft {
  return {
    awaitingField: "schedule",
    intent: "add a todo: buy sandpaper",
    operation: "create_definition",
    createdAt: Date.now(),
    sourceMessageId: "clarify-message",
    request: {
      kind: "task",
      metadata: { ownerSurface: "OWNER_TODOS" },
      title: "buy sandpaper",
    },
  };
}

function pendingTodoDraft(): DeferredLifeDefinitionDraft {
  return {
    intent: "Add buy oat milk with no due date",
    operation: "create_definition",
    createdAt: Date.now(),
    sourceMessageId: "preview-message",
    request: {
      cadence: { kind: "unscheduled" },
      kind: "task",
      metadata: { ownerSurface: "OWNER_TODOS" },
      reminderPlan: null,
      title: "Buy oat milk",
    },
  };
}

function context(
  args: {
    draft?: DeferredLifeDefinitionDraft;
    replyEffectStatus?: "applied" | "non_applied";
    actionName?: string;
    text?: string;
  } = {},
): ResponseHandlerEvaluatorContext {
  const draft = args.draft;
  return {
    runtime: {
      actions: [{ name: args.actionName ?? "OWNER_TODOS" }],
      getCache: vi.fn(async () => null),
    } as unknown as IAgentRuntime,
    message: {
      content: { text: args.text ?? "Yes, save that todo." },
      entityId: "owner-entity",
      roomId: "owner-room",
    },
    state: draft
      ? {
          data: {
            actionResults: [
              {
                success: false,
                data: {
                  actionName: "OWNER_TODOS",
                  deferred: true,
                  lifeDraft: draft,
                  requiresConfirmation: true,
                  saved: false,
                },
              },
            ],
          },
        }
      : {},
    availableContexts: [{ id: "simple" }, { id: "tasks" }],
    messageHandler: {
      processMessage: "RESPOND",
      plan: {
        candidateActions: [],
        contexts: ["tasks"],
        reply: "Saved the todo.",
        replyEffectStatus: args.replyEffectStatus ?? "applied",
      },
      thought: "The owner confirmed the draft.",
    },
  } as unknown as ResponseHandlerEvaluatorContext;
}

describe("deferred owner-Todo routing", () => {
  it("replaces an ungrounded completion with the exact owner action", async () => {
    const input = context({ draft: pendingTodoDraft() });

    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(input)).toBe(true);
    expect(await deferredOwnerTodoRoutingEvaluator.evaluate(input)).toEqual({
      requiresTool: true,
      addContexts: ["tasks"],
      clearCandidateActions: true,
      addCandidateActions: ["OWNER_TODOS"],
      clearParentActionHints: true,
      addParentActionHints: ["OWNER_TODOS"],
      clearReply: true,
      debug: [
        'pending owner Todo draft "Buy oat milk" requires a durable OWNER_TODOS result before completion',
      ],
    });
  });

  it("routes explicit owner consent even when Stage 1 omits the completion claim", async () => {
    expect(
      await deferredOwnerTodoRoutingEvaluator.shouldRun(
        context({
          draft: pendingTodoDraft(),
          replyEffectStatus: "non_applied",
        }),
      ),
    ).toBe(true);
  });

  it("does not intercept a non-applied neutral follow-up", async () => {
    expect(
      await deferredOwnerTodoRoutingEvaluator.shouldRun(
        context({
          draft: pendingTodoDraft(),
          replyEffectStatus: "non_applied",
          text: "Maybe later.",
        }),
      ),
    ).toBe(false);
  });

  it("routes an applied neutral claim only for repair, not as owner consent", async () => {
    const input = context({
      draft: pendingTodoDraft(),
      replyEffectStatus: "applied",
      text: "Maybe later.",
    });

    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(input)).toBe(true);
    expect(
      await deferredOwnerTodoRoutingEvaluator.evaluate(input),
    ).toMatchObject({
      clearReply: true,
      addCandidateActions: ["OWNER_TODOS"],
    });
  });

  it("requires both a pending draft and the registered owner action", async () => {
    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(context())).toBe(
      false,
    );
    expect(
      await deferredOwnerTodoRoutingEvaluator.shouldRun(
        context({ draft: pendingTodoDraft(), actionName: "REPLY" }),
      ),
    ).toBe(false);
  });

  it("does not reroute a reminder draft through the Todo store", async () => {
    const reminderDraft = pendingTodoDraft();
    reminderDraft.request.metadata = { ownerSurface: "OWNER_REMINDERS" };

    expect(
      await deferredOwnerTodoRoutingEvaluator.shouldRun(
        context({ draft: reminderDraft }),
      ),
    ).toBe(false);
  });
});

describe("awaiting-schedule drafts (F32)", () => {
  it("coerce accepts a cadence-less draft only with the awaiting-schedule marker", () => {
    const parked = coerceDeferredLifeDraft(awaitingScheduleDraft());
    expect(parked?.operation).toBe("create_definition");
    expect(
      parked?.operation === "create_definition"
        ? parked.awaitingField
        : undefined,
    ).toBe("schedule");
    const malformed = coerceDeferredLifeDraft({
      ...awaitingScheduleDraft(),
      awaitingField: undefined,
    });
    expect(malformed).toBeNull();
  });

  it("recognizes explicit date-declines and vetoes cancellations", () => {
    for (const text of [
      "no deadline, it's just a general todo",
      "no due date",
      "someday",
      "just a plain todo",
    ]) {
      expect(isExplicitScheduleDecline(text)).toBe(true);
    }
    for (const text of [
      "cancel",
      "never mind, forget it",
      "it's not a plain todo, make it daily",
      "what's the weather",
    ]) {
      expect(isExplicitScheduleDecline(text)).toBe(false);
    }
  });

  it("routes a date-decline answer back through OWNER_TODOS (live F32 shape)", async () => {
    const input = context({
      draft: awaitingScheduleDraft(),
      replyEffectStatus: "non_applied",
      text: "no deadline, it's just a general todo",
    });
    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(input)).toBe(true);
    const patch = await deferredOwnerTodoRoutingEvaluator.evaluate(input);
    expect(patch).toMatchObject({
      requiresTool: true,
      addCandidateActions: ["OWNER_TODOS"],
    });
  });

  it("does not treat a decline as an answer without an awaiting-schedule draft", async () => {
    const input = context({
      draft: pendingTodoDraft(),
      replyEffectStatus: "non_applied",
      text: "no deadline, it's just a general todo",
    });
    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(input)).toBe(
      false,
    );
  });

  it("leaves ordinary chat alone while a draft awaits its schedule", async () => {
    const input = context({
      draft: awaitingScheduleDraft(),
      replyEffectStatus: "non_applied",
      text: "what's the weather like today?",
    });
    expect(await deferredOwnerTodoRoutingEvaluator.shouldRun(input)).toBe(
      false,
    );
  });
});
