import { describe, expect, it } from "vitest";
import type {
  TrajectoryDetail,
  TrajectoryListItem,
  UILlmCall,
  UIToolEvent,
} from "../src/api-client";
import { extractShouldRespondDecision, summarizePhases } from "../src/phases";

function makeTrajectory(
  overrides: Partial<TrajectoryListItem> = {},
): TrajectoryListItem {
  return { id: "t1", status: "active", llmCallCount: 0, ...overrides };
}

function makeLlmCall(overrides: Partial<UILlmCall>): UILlmCall {
  return {
    id: "c1",
    model: "gpt-x",
    response: "",
    purpose: "",
    actionType: "",
    stepType: "",
    ...overrides,
  };
}

function makeToolEvent(overrides: Partial<UIToolEvent>): UIToolEvent {
  return {
    id: overrides.id ?? "e1",
    type: "tool_call",
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<TrajectoryDetail>,
): TrajectoryDetail {
  return {
    trajectory: makeTrajectory(),
    llmCalls: [],
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
    ...overrides,
  };
}

describe("summarizePhases", () => {
  it("returns four phases for an empty trajectory, all idle", () => {
    const phases = summarizePhases(null);
    expect(phases.map((p) => p.phase)).toEqual([
      "HANDLE",
      "PLAN",
      "ACTION",
      "EVALUATE",
    ]);
    expect(phases.every((p) => p.status === "idle")).toBe(true);
  });

  it("classifies a should_respond LLM call as HANDLE and reads the decision", () => {
    const detail = makeDetail({
      llmCalls: [
        makeLlmCall({
          stepType: "should_respond",
          response: '{"action":"RESPOND","reasoning":"user asked a question"}',
        }),
      ],
    });
    const [handle] = summarizePhases(detail);
    expect(handle.phase).toBe("HANDLE");
    expect(handle.status).toBe("done");
    expect(handle.summary).toBe("respond");
    expect(handle.llmCalls).toHaveLength(1);
  });

  it("marks HANDLE as skipped when shouldRespond returns IGNORE", () => {
    const detail = makeDetail({
      llmCalls: [
        makeLlmCall({
          stepType: "should_respond",
          response: '{"action":"IGNORE"}',
        }),
      ],
    });
    const [handle] = summarizePhases(detail);
    expect(handle.status).toBe("skipped");
    expect(handle.summary).toBe("ignore");
  });

  it("classifies plan/response calls and surfaces the actionType", () => {
    const detail = makeDetail({
      llmCalls: [
        makeLlmCall({
          stepType: "should_respond",
          response: '{"action":"RESPOND"}',
        }),
        makeLlmCall({
          id: "c2",
          stepType: "response",
          actionType: "REPLY",
          response: "{}",
        }),
      ],
    });
    const phases = summarizePhases(detail);
    const plan = phases.find((p) => p.phase === "PLAN");
    expect(plan?.status).toBe("done");
    expect(plan?.summary).toBe("REPLY");
  });

  it("flags an errored tool event under ACTION with error status", () => {
    const detail = makeDetail({
      toolEvents: [
        makeToolEvent({
          actionName: "POSTGRES_QUERY",
          type: "tool_error",
          error: "connection refused",
        }),
      ],
    });
    const action = summarizePhases(detail).find((p) => p.phase === "ACTION");
    expect(action?.status).toBe("error");
    expect(action?.summary).toBe("POSTGRES_QUERY");
  });

  it("marks the latest finished phase as 'active' for in-flight trajectories with idle tail", () => {
    const detail = makeDetail({
      llmCalls: [
        makeLlmCall({
          stepType: "should_respond",
          response: '{"action":"RESPOND"}',
        }),
      ],
    });
    const phases = summarizePhases(detail, { trajectoryActive: true });
    const handle = phases.find((p) => p.phase === "HANDLE");
    const plan = phases.find((p) => p.phase === "PLAN");
    expect(handle?.status).toBe("active");
    expect(plan?.status).toBe("idle");
  });
});

describe("extractShouldRespondDecision", () => {
  it("parses JSON with action+reasoning", () => {
    const out = extractShouldRespondDecision(
      makeLlmCall({
        response: '{"action":"RESPOND","reasoning":"because"}',
      }),
    );
    expect(out).toEqual({ decision: "RESPOND", reasoning: "because" });
  });

  it("falls back to keyword detection in plain text", () => {
    const out = extractShouldRespondDecision(
      makeLlmCall({ response: "I should IGNORE this message." }),
    );
    expect(out?.decision).toBe("IGNORE");
  });

  it("returns null for empty/unrecognized responses", () => {
    expect(extractShouldRespondDecision(makeLlmCall({ response: "" }))).toBeNull();
    expect(
      extractShouldRespondDecision(makeLlmCall({ response: "lorem ipsum" })),
    ).toBeNull();
  });
});
