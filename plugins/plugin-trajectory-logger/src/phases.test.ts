/**
 * Unit coverage for trajectory phase classification — phaseOf mapping,
 * should_respond decision extraction (JSON + keyword fallback), and the
 * per-phase status summaries. The classifier is a hard-coded heuristic: calls
 * matching no phase set are silently omitted, so a regression here would drop
 * visible phases from the trajectory view or mislabel an in-flight trajectory
 * as done.
 */
import { describe, expect, it } from "vitest";
import type { UILlmCall, UIToolEvent } from "./api-client.ts";
import {
  extractShouldRespondDecision,
  PHASES,
  summarizePhases,
} from "./phases.ts";

function llmCall(overrides: Partial<UILlmCall> = {}): UILlmCall {
  return {
    stepType: "reasoning",
    purpose: "",
    actionType: "respond",
    response: "",
    ...overrides,
  } as UILlmCall;
}

function toolEvent(overrides: Partial<UIToolEvent> = {}): UIToolEvent {
  return {
    type: "tool_result",
    name: "tool",
    ...overrides,
  } as UIToolEvent;
}

describe("PHASES", () => {
  it("exposes the four canonical phases in order", () => {
    expect(PHASES).toEqual(["HANDLE", "PLAN", "ACTION", "EVALUATE"]);
  });
});

describe("extractShouldRespondDecision", () => {
  it("extracts action and reasoning from a JSON response", () => {
    const decision = extractShouldRespondDecision(
      llmCall({
        response: 'prefix {"action":"respond","reasoning":"because"} suffix',
      }),
    );
    expect(decision).toEqual({ decision: "RESPOND", reasoning: "because" });
  });

  it("reads the decision key as a fallback", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: '{"decision":"ignore","rationale":"busy"}' }),
    );
    expect(decision).toEqual({ decision: "IGNORE", reasoning: "busy" });
  });

  it("reads shouldRespond as a fallback key", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: '{"shouldRespond":"reply"}' }),
    );
    expect(decision).toEqual({ decision: "REPLY" });
  });

  it("upper-cases the extracted decision", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: '{"action":"respond"}' }),
    );
    expect(decision?.decision).toBe("RESPOND");
  });

  it("extracts the decision without a reasoning key", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: '{"action":"stop"}' }),
    );
    expect(decision).toEqual({ decision: "STOP" });
  });

  it("falls back to a keyword match when JSON has no decision", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: "I will IGNORE this request" }),
    );
    expect(decision?.decision).toBe("IGNORE");
  });

  it("matches keyword fallbacks case-insensitively", () => {
    expect(
      extractShouldRespondDecision(llmCall({ response: "reply now" }))
        ?.decision,
    ).toBe("REPLY");
    expect(
      extractShouldRespondDecision(llmCall({ response: "skip it" }))?.decision,
    ).toBe("SKIP");
  });

  it("returns null for an empty response", () => {
    expect(
      extractShouldRespondDecision(llmCall({ response: "  " })),
    ).toBeNull();
  });

  it("returns null for a response with no decision and no keyword", () => {
    expect(
      extractShouldRespondDecision(llmCall({ response: "hmm, let me think" })),
    ).toBeNull();
  });

  it("falls through to keyword match on malformed JSON", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: "{broken json RESPOND" }),
    );
    expect(decision?.decision).toBe("RESPOND");
  });

  it("returns null when JSON decision is not a non-empty string", () => {
    const decision = extractShouldRespondDecision(
      llmCall({ response: '{"action":123}' }),
    );
    expect(decision).toBeNull();
  });
});

describe("summarizePhases", () => {
  it("reports all idle when there is no detail", () => {
    const phases = summarizePhases(null);
    expect(phases.map((p) => p.status)).toEqual([
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
    expect(phases.map((p) => p.phase)).toEqual([
      "HANDLE",
      "PLAN",
      "ACTION",
      "EVALUATE",
    ]);
  });

  it("classifies handle/plan/evaluate llm calls into their phases", () => {
    const phases = summarizePhases({
      llmCalls: [
        llmCall({
          stepType: "should_respond",
          response: '{"action":"respond"}',
        }),
        llmCall({ stepType: "reasoning" }),
        llmCall({ stepType: "evaluation" }),
      ],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[0].status).toBe("done");
    expect(phases[1].status).toBe("done");
    expect(phases[3].status).toBe("done");
  });

  it("marks the handle phase skipped for an IGNORE decision", () => {
    const phases = summarizePhases({
      llmCalls: [
        llmCall({
          stepType: "should_respond",
          response: '{"action":"ignore"}',
        }),
      ],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[0].status).toBe("skipped");
    expect(phases[0].summary).toBe("ignore");
  });

  it("uses the purpose field when stepType is absent", () => {
    const phases = summarizePhases({
      llmCalls: [
        llmCall({
          stepType: "",
          purpose: "should_respond",
          response: '{"action":"stop"}',
        }),
      ],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[0].status).toBe("skipped");
  });

  it("reports done for a should_respond call with no parseable decision", () => {
    const phases = summarizePhases({
      llmCalls: [llmCall({ stepType: "should_respond", response: "???" })],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[0].status).toBe("done");
    expect(phases[0].summary).toBeNull();
  });

  it("counts provider accesses into the handle summary", () => {
    const phases = summarizePhases({
      llmCalls: [llmCall({ stepType: "compose_state" })],
      providerAccesses: [{ name: "p1" }, { name: "p2" }],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[0].status).toBe("done");
    expect(phases[0].summary).toBe("2 ctx");
  });

  it("uses the last plan call's actionType as the plan summary", () => {
    const phases = summarizePhases({
      llmCalls: [llmCall({ stepType: "response", actionType: "send_message" })],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    expect(phases[1].summary).toBe("send_message");
  });

  it("classifies a tool error as an error action", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [toolEvent({ type: "tool_error", name: "web" })],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("error");
    expect(phases[2].summary).toBe("web");
  });

  it("classifies a tool failure flag as an error action", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [
        toolEvent({ type: "tool_result", name: "db", success: false }),
      ],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("error");
  });

  it("classifies a completed tool as done", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [
        toolEvent({ type: "tool_result", name: "db", success: true }),
      ],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("done");
  });

  it("classifies a tool_result with skipped status as done (type precedence)", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [
        toolEvent({ type: "tool_result", name: "db", status: "skipped" }),
      ],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("done");
  });

  it("classifies a pending tool call as skipped when status says so", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [
        toolEvent({ type: "tool_call", name: "db", status: "skipped" }),
      ],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("skipped");
  });

  it("classifies an in-flight tool call as active", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [toolEvent({ type: "tool_call", name: "db" })],
      evaluationEvents: [],
    });
    expect(phases[2].status).toBe("active");
  });

  it("classifies an evaluation event with a decision as done", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [{ evaluatorName: "faithfulness", decision: "pass" }],
    });
    expect(phases[3].status).toBe("done");
    expect(phases[3].summary).toBe("faithfulness: pass");
  });

  it("classifies a failed evaluation as error", () => {
    const phases = summarizePhases({
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [{ evaluatorName: "faithfulness", success: false }],
    });
    expect(phases[3].status).toBe("error");
  });

  it("promotes the latest done phase to active for an in-flight trajectory", () => {
    const phases = summarizePhases(
      {
        llmCalls: [llmCall({ stepType: "reasoning", actionType: "plan" })],
        providerAccesses: [],
        toolEvents: [],
        evaluationEvents: [],
      },
      { trajectoryActive: true },
    );
    // PLAN is done and everything after it is idle -> promoted to active.
    expect(phases[1].status).toBe("active");
    expect(phases[0].status).toBe("idle");
  });

  it("does not promote the last phase", () => {
    const phases = summarizePhases(
      {
        llmCalls: [llmCall({ stepType: "evaluation" })],
        providerAccesses: [],
        toolEvents: [],
        evaluationEvents: [],
      },
      { trajectoryActive: true },
    );
    expect(phases[3].status).toBe("done");
  });

  it("does not promote when a later phase is non-idle", () => {
    // PLAN is done, ACTION is active (in-flight tool call) -> EVALUATE idle.
    // Because a non-idle phase follows PLAN, PLAN must not be promoted.
    const phases = summarizePhases(
      {
        llmCalls: [llmCall({ stepType: "reasoning" })],
        providerAccesses: [],
        toolEvents: [toolEvent({ type: "tool_call", name: "db" })],
        evaluationEvents: [],
      },
      { trajectoryActive: true },
    );
    expect(phases[1].status).toBe("done");
    expect(phases[2].status).toBe("active");
  });
});
