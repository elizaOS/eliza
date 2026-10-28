/**
 * `extractShouldRespondDecision()` must read the respond/ignore verdict the
 * HANDLE step actually reached, whether the model states it before or after
 * its reasoning, as a key/value or XML field, or as JSON.
 */
import { describe, expect, it } from "vitest";
import type { TrajectoryDetail, UILlmCall } from "../src/api-client";
import { extractShouldRespondDecision, summarizePhases } from "../src/phases";

function call(response: string): UILlmCall {
  return {
    id: "call-1",
    model: "test-model",
    response,
    purpose: "should_respond",
    actionType: "",
    stepType: "should_respond",
  };
}

describe("extractShouldRespondDecision", () => {
  it("reads a verdict stated before its explanation", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "IGNORE - the user is talking to someone else, no need to respond.",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("RESPOND. They asked me directly; I should not ignore them."),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("reads a verdict stated after its reasoning", () => {
    expect(
      extractShouldRespondDecision(call("Should I respond? No, IGNORE.")),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("Respond to this? The user asked me by name, so RESPOND."),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("prefers an explicit key/value verdict field over reasoning keywords", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "reasoning: I could respond, but this is not addressed to me.\naction: IGNORE\nnote: would reply if mentioned",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("IGNORE would be rude here.\ndecision = RESPOND"),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("prefers an explicit XML verdict field over reasoning keywords", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "<response><reasoning>Nobody asked me to respond; skip.</reasoning><action>IGNORE</action></response> I might reply later.",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
  });

  it("reads the JSON action and reasoning", () => {
    expect(
      extractShouldRespondDecision(
        call(
          '```json\n{"reasoning": "They said ignore me", "action": "respond"}\n```',
        ),
      ),
    ).toEqual({ decision: "RESPOND", reasoning: "They said ignore me" });
    expect(extractShouldRespondDecision(call('{"decision": "stop"}'))).toEqual({
      decision: "STOP",
    });
  });

  it("returns null when no verdict is present", () => {
    expect(extractShouldRespondDecision(call("   "))).toBeNull();
    expect(
      extractShouldRespondDecision(call("I am not sure what to do here.")),
    ).toBeNull();
  });
});

function detail(overrides: Partial<TrajectoryDetail>): TrajectoryDetail {
  return {
    llmCalls: [],
    providerAccesses: [],
    ...overrides,
  } as unknown as TrajectoryDetail;
}

function phaseStatus(
  overrides: Partial<TrajectoryDetail>,
  phase: "ACTION" | "EVALUATE",
): string | undefined {
  return summarizePhases(detail(overrides)).find((p) => p.phase === phase)
    ?.status;
}

describe("summarizePhases failure reporting", () => {
  it("reports a tool call that failed as an error, not as running work", () => {
    expect(
      phaseStatus(
        {
          toolEvents: [
            {
              id: "tool-1",
              type: "tool_call",
              actionName: "SEND_EMAIL",
              status: "failed",
            },
          ],
        },
        "ACTION",
      ),
    ).toBe("error");
  });

  it("reports a tool result that failed as an error, not as a completed action", () => {
    expect(
      phaseStatus(
        {
          toolEvents: [
            {
              id: "tool-2",
              type: "tool_result",
              toolName: "SEARCH_WEB",
              status: "failed",
            },
          ],
        },
        "ACTION",
      ),
    ).toBe("error");
  });

  it("reports an evaluator that failed as an error, not as a completed evaluation", () => {
    expect(
      phaseStatus(
        {
          evaluationEvents: [
            { id: "eval-1", evaluatorName: "reflection", status: "failed" },
          ],
        },
        "EVALUATE",
      ),
    ).toBe("error");
  });
});
