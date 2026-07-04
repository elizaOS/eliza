/**
 * Verifies subAgentFailureResponseEvaluator.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import type {
  Memory,
  MessageHandlerResult,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { subAgentFailureResponseEvaluator } from "../../src/evaluators/sub-agent-failure.js";

function makeContext(overrides: {
  text?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  messageHandler?: Partial<MessageHandlerResult>;
}): ResponseHandlerEvaluatorContext {
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: ["general"],
      reply: "",
      requiresTool: true,
      ...overrides.messageHandler?.plan,
    },
    ...overrides.messageHandler,
  };
  const message = {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: {
      text:
        overrides.text ??
        "[sub-agent: text-my-ex (claude) — error]\nACP session failed: registration request timed out.",
      source: overrides.source ?? "sub_agent",
      metadata: {
        subAgent: true,
        subAgentEvent: "error",
        subAgentLabel: "text-my-ex",
        ...overrides.metadata,
      },
    },
  } as Memory;
  return {
    runtime: {} as never,
    message,
    state: {} as never,
    messageHandler,
    availableContexts: [{ id: SIMPLE_CONTEXT_ID, description: "simple" }],
  };
}

describe("subAgentFailureResponseEvaluator", () => {
  it("relays one honest failure message on a terminal error synthetic (no silence)", () => {
    const context = makeContext({});
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — ACP session failed: registration request timed out. Want me to retry?`,
    );
    expect(result.requiresTool).toBe(false);
    expect(result.setContexts).toEqual([SIMPLE_CONTEXT_ID]);
    expect(result.clearCandidateActions).toBe(true);
    expect(result.clearParentActionHints).toBe(true);
  });

  it("also fires for state_lost_exhausted and round_trip_cap_exceeded", () => {
    for (const subAgentEvent of [
      "state_lost_exhausted",
      "round_trip_cap_exceeded",
    ]) {
      const context = makeContext({ metadata: { subAgentEvent } });
      expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
    }
  });

  it("does NOT fire for task_complete (that is the completion evaluator's job)", () => {
    const context = makeContext({
      metadata: { subAgentEvent: "task_complete" },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("does NOT fire for non sub-agent messages", () => {
    const context = makeContext({
      source: "discord",
      metadata: { subAgent: false },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("defers to the planner when it is taking a concrete follow-up action", () => {
    const context = makeContext({
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: true,
          candidateActions: ["TASKS_SEND_TO_AGENT"],
        },
      } as Partial<MessageHandlerResult>,
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it.each([
    ["candidate TASKS", { candidateActions: ["TASKS"] }],
    [
      "candidate TASKS_SPAWN_AGENT",
      { candidateActions: ["TASKS_SPAWN_AGENT"] },
    ],
    ["parent TASKS", { parentActionHints: ["TASKS"] }],
  ])("ignores stale generic task hints: %s", (_label, plan) => {
    const context = makeContext({
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: true,
          ...plan,
        },
      } as Partial<MessageHandlerResult>,
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
  });

  it("does NOT fire when the turn is already STOP", () => {
    const context = makeContext({
      messageHandler: { processMessage: "STOP" },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("uses a generic subject and omits the reason for label-less, noise-only narration", () => {
    const context = makeContext({
      text: "[internal-code-9931]",
      metadata: { subAgentLabel: undefined },
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe("Couldn't finish that task. Want me to retry?");
  });
});
