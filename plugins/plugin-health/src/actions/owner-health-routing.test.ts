/**
 * Verifies deterministic Stage-1 routing for owner telemetry reads and keeps
 * clinical advice requests on the normal safety path.
 */
import type {
  IAgentRuntime,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  isOwnerHealthReadRequest,
  ownerHealthRoutingEvaluator,
} from "./owner-health-routing.js";

function context(text: string, actionName = "OWNER_HEALTH") {
  return {
    runtime: {
      actions: [{ name: actionName }],
    } as unknown as IAgentRuntime,
    message: { content: { text } },
    state: {},
    availableContexts: [{ id: "simple" }, { id: "health" }],
    messageHandler: {
      processMessage: "RESPOND",
      plan: {
        contexts: ["simple"],
        reply: "Generic wellness advice.",
      },
    },
  } as unknown as ResponseHandlerEvaluatorContext;
}

describe("owner health routing", () => {
  it("recognizes an overnight recovery telemetry read", () => {
    expect(
      isOwnerHealthReadRequest(
        "Good morning — how did my body recover overnight?",
      ),
    ).toBe(true);
    expect(isOwnerHealthReadRequest("Show me my workout status today.")).toBe(
      true,
    );
  });

  it("forces the health context and OWNER_HEALTH candidate", async () => {
    const input = context("Good morning — how did my body recover overnight?");

    expect(await ownerHealthRoutingEvaluator.shouldRun(input)).toBe(true);
    expect(await ownerHealthRoutingEvaluator.evaluate(input)).toEqual(
      expect.objectContaining({
        requiresTool: true,
        setContexts: ["health"],
        addCandidateActions: ["OWNER_HEALTH"],
        addParentActionHints: ["OWNER_HEALTH"],
        clearReply: true,
      }),
    );
  });

  it("does not route clinical advice or a runtime without OWNER_HEALTH", async () => {
    expect(
      isOwnerHealthReadRequest(
        "How should I treat my knee pain after yesterday's workout?",
      ),
    ).toBe(false);
    expect(isOwnerHealthReadRequest("I did a workout today.")).toBe(false);
    expect(isOwnerHealthReadRequest("Tell me how to improve my sleep.")).toBe(
      false,
    );
    expect(isOwnerHealthReadRequest("Tell me about sleep recovery tips.")).toBe(
      false,
    );
    expect(
      await ownerHealthRoutingEvaluator.shouldRun(
        context("How did my body recover overnight?", "REPLY"),
      ),
    ).toBe(false);
  });
});
