/**
 * Verifies sub-agent completion: incomplete finish-reason rejection (issue #8875).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import type { Memory, MessageHandlerResult, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { subAgentCompletionResponseEvaluator } from "../evaluators/sub-agent-completion.js";

// A clean, long prose body that does not trip any of the evaluator's other
// relay branches (no URL, no tool-output envelope, no failure marker, no
// positive quantitative evidence, longer than the short-clean-answer cap). It
// stands in for a weak-model completion that was cut off mid-summary.
const LONG_TRUNCATED_BODY =
  "I began working through the requested analysis and pulled together the " +
  "initial set of inputs, but the response was cut off before I could finish " +
  "writing up the complete summary of everything for you in this reply.";

const UUID_A = "00000000-0000-0000-0000-000000000001" as UUID;

function makeCompletion(text: string, finishReason?: string): Memory {
  return {
    id: UUID_A,
    entityId: UUID_A,
    agentId: UUID_A,
    roomId: UUID_A,
    content: {
      text,
      source: "sub_agent",
      metadata: {
        subAgent: true,
        subAgentEvent: "task_complete",
        ...(finishReason ? { subAgentFinishReason: finishReason } : {}),
      },
    },
  } as unknown as Memory;
}

function makeHandler(
  plan: Record<string, unknown>,
  processMessage: "RESPOND" | "STOP" | "IGNORE" = "RESPOND",
): MessageHandlerResult {
  return {
    processMessage,
    thought: "",
    plan: { contexts: [], ...plan },
  } as unknown as MessageHandlerResult;
}

// The evaluator only reads `message` + `messageHandler`; the rest of the
// ResponseHandlerEvaluatorContext is irrelevant here.
function ctx(message: Memory, messageHandler: MessageHandlerResult) {
  return { message, messageHandler } as unknown as Parameters<
    typeof subAgentCompletionResponseEvaluator.shouldRun
  >[0];
}

describe("sub-agent completion: incomplete finish-reason rejection (issue #8875)", () => {
  it("handles an output-limited completion the planner would otherwise re-spawn", async () => {
    // The planner re-issued a fresh, concrete follow-up (TASKS_CREATE) — without
    // the finish-reason signal this would suppress the relay and let it re-spawn.
    const message = makeCompletion(LONG_TRUNCATED_BODY, "length");
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    expect(
      await subAgentCompletionResponseEvaluator.shouldRun(
        ctx(message, handler),
      ),
    ).toBe(true);
  });

  it("handles a content_filter (blocked) completion", async () => {
    const message = makeCompletion(LONG_TRUNCATED_BODY, "content_filter");
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    expect(
      await subAgentCompletionResponseEvaluator.shouldRun(
        ctx(message, handler),
      ),
    ).toBe(true);
  });

  it("does NOT relay a clean completion with a concrete follow-up (regression)", async () => {
    // Same plan, but no degenerate finish reason: the planner keeps its
    // concrete follow-up and the evaluator steps aside (existing behavior).
    const message = makeCompletion(LONG_TRUNCATED_BODY);
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    expect(
      await subAgentCompletionResponseEvaluator.shouldRun(
        ctx(message, handler),
      ),
    ).toBe(false);
  });

  it("treats a non-degenerate finish reason (end_turn) as clean", async () => {
    const message = makeCompletion(LONG_TRUNCATED_BODY, "end_turn");
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    expect(
      await subAgentCompletionResponseEvaluator.shouldRun(
        ctx(message, handler),
      ),
    ).toBe(false);
  });

  it("does NOT pre-empt feeding the still-running session (TASKS_SEND_TO_AGENT)", async () => {
    // Feeding a real blocker back to the live session is the one legitimate
    // non-relay follow-up after a degenerate completion.
    const message = makeCompletion(LONG_TRUNCATED_BODY, "length");
    const handler = makeHandler({
      candidateActions: ["TASKS_SEND_TO_AGENT"],
      reply: "",
    });
    expect(
      await subAgentCompletionResponseEvaluator.shouldRun(
        ctx(message, handler),
      ),
    ).toBe(false);
  });

  it("evaluate rejects the partial and clears candidate actions", async () => {
    const message = makeCompletion(LONG_TRUNCATED_BODY, "length");
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    const patch = await subAgentCompletionResponseEvaluator.evaluate(
      ctx(message, handler),
    );
    expect(patch?.clearCandidateActions).toBe(true);
    expect(patch?.clearParentActionHints).toBe(true);
    expect(patch?.reply).toContain("output limit");
    expect(patch?.reply).toContain("No partial result was used");
    expect(patch?.reply).not.toContain("began working through");
  });

  it("returns the same explicit failure when there is no partial", async () => {
    const message = makeCompletion("", "length");
    const handler = makeHandler({
      candidateActions: ["TASKS_CREATE"],
      reply: "",
    });
    const patch = await subAgentCompletionResponseEvaluator.evaluate(
      ctx(message, handler),
    );
    expect(patch?.processMessage).not.toBe("IGNORE");
    expect(patch?.reply).toContain("No partial result was used");
    expect(patch?.clearCandidateActions).toBe(true);
  });
});
