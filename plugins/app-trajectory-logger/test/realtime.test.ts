/**
 * Integration test: simulates the realtime trajectory progression and asserts
 * that `summarizePhases` produces the right phase status sequence as the
 * runtime fires LLM calls / tool events one at a time.
 *
 * This is the static analogue of "open the app, talk to the agent, watch
 * phases flip" — without needing a dev server. It feeds the classifier the
 * same sequence of detail responses the polling hook would receive and
 * checks each snapshot.
 */

import { describe, expect, it } from "vitest";
import type {
  TrajectoryDetail,
  TrajectoryListItem,
  UIEvaluationEvent,
  UILlmCall,
  UIToolEvent,
} from "../src/api-client";
import { summarizePhases } from "../src/phases";

function emptyDetail(active = true): TrajectoryDetail {
  const now = Date.now();
  const trajectory: TrajectoryListItem = {
    id: "t-001",
    agentId: "a-001",
    roomId: null,
    entityId: null,
    conversationId: null,
    source: "chat",
    status: active ? "active" : "completed",
    startTime: now,
    endTime: active ? null : now + 1,
    durationMs: active ? null : 1,
    llmCallCount: 0,
    providerAccessCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  return {
    trajectory,
    llmCalls: [],
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
  };
}

function call(overrides: Partial<UILlmCall>): UILlmCall {
  return {
    id: overrides.id ?? `c-${Math.random()}`,
    trajectoryId: "t-001",
    stepId: "s-001",
    model: "test-model",
    systemPrompt: "",
    userPrompt: "",
    response: "",
    temperature: 0,
    maxTokens: 0,
    purpose: "",
    actionType: "",
    stepType: "",
    tags: [],
    latencyMs: 0,
    timestamp: Date.now(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function tool(overrides: Partial<UIToolEvent>): UIToolEvent {
  return {
    id: overrides.id ?? `e-${Math.random()}`,
    type: "tool_call",
    ...overrides,
  };
}

function evaluator(overrides: Partial<UIEvaluationEvent>): UIEvaluationEvent {
  return {
    id: overrides.id ?? `ev-${Math.random()}`,
    type: "evaluation",
    ...overrides,
  };
}

function statusOf(
  phases: ReturnType<typeof summarizePhases>,
  name: string,
): string {
  return phases.find((p) => p.phase === name)?.status ?? "missing";
}

describe("realtime trajectory progression", () => {
  it("walks HANDLE → PLAN → ACTION → EVALUATE as the agent emits each step", () => {
    // Snapshot 0: empty active trajectory. All idle.
    const t0 = emptyDetail(true);
    const p0 = summarizePhases(t0, { trajectoryActive: true });
    expect(statusOf(p0, "HANDLE")).toBe("idle");
    expect(statusOf(p0, "PLAN")).toBe("idle");
    expect(statusOf(p0, "ACTION")).toBe("idle");
    expect(statusOf(p0, "EVALUATE")).toBe("idle");

    // Snapshot 1: should_respond fired with RESPOND. HANDLE flips to active
    // (it's the most-recently-finished phase with no tail data yet).
    const t1: TrajectoryDetail = {
      ...t0,
      llmCalls: [
        call({
          id: "c-1",
          stepType: "should_respond",
          response: '{"action":"RESPOND"}',
        }),
      ],
    };
    const p1 = summarizePhases(t1, { trajectoryActive: true });
    expect(statusOf(p1, "HANDLE")).toBe("active");
    expect(statusOf(p1, "PLAN")).toBe("idle");

    // Snapshot 2: response (PLAN) fires with REPLY. HANDLE done, PLAN active.
    const t2: TrajectoryDetail = {
      ...t1,
      llmCalls: [
        ...t1.llmCalls,
        call({
          id: "c-2",
          stepType: "response",
          actionType: "REPLY",
          response: "{}",
        }),
      ],
    };
    const p2 = summarizePhases(t2, { trajectoryActive: true });
    expect(statusOf(p2, "HANDLE")).toBe("done");
    expect(statusOf(p2, "PLAN")).toBe("active");
    expect(p2.find((p) => p.phase === "PLAN")?.summary).toBe("REPLY");

    // Snapshot 3: action runs and returns success. PLAN done, ACTION active.
    const t3: TrajectoryDetail = {
      ...t2,
      toolEvents: [
        tool({
          id: "e-1",
          actionName: "REPLY",
          type: "tool_result",
          success: true,
        }),
      ],
    };
    const p3 = summarizePhases(t3, { trajectoryActive: true });
    expect(statusOf(p3, "HANDLE")).toBe("done");
    expect(statusOf(p3, "PLAN")).toBe("done");
    expect(statusOf(p3, "ACTION")).toBe("active");
    expect(p3.find((p) => p.phase === "ACTION")?.summary).toBe("REPLY ✓");

    // Snapshot 4: evaluator returns CONTINUE. EVALUATE flips to done.
    const t4: TrajectoryDetail = {
      ...t3,
      evaluationEvents: [
        evaluator({
          id: "ev-1",
          evaluatorName: "REFLECTION",
          decision: "continue",
          success: true,
        }),
      ],
    };
    const p4 = summarizePhases(t4, { trajectoryActive: true });
    expect(statusOf(p4, "ACTION")).toBe("done");
    expect(statusOf(p4, "EVALUATE")).toBe("done");
    expect(p4.find((p) => p.phase === "EVALUATE")?.summary).toBe(
      "REFLECTION: continue",
    );
  });

  it("flips HANDLE to skipped on IGNORE, leaving the rest idle", () => {
    const detail: TrajectoryDetail = {
      ...emptyDetail(false),
      llmCalls: [
        call({
          id: "c-x",
          stepType: "should_respond",
          response: '{"action":"IGNORE","reasoning":"not relevant"}',
        }),
      ],
    };
    const phases = summarizePhases(detail, { trajectoryActive: false });
    expect(statusOf(phases, "HANDLE")).toBe("skipped");
    expect(statusOf(phases, "PLAN")).toBe("idle");
    expect(statusOf(phases, "ACTION")).toBe("idle");
    expect(statusOf(phases, "EVALUATE")).toBe("idle");
  });

  it("surfaces an action error under ACTION", () => {
    const detail: TrajectoryDetail = {
      ...emptyDetail(false),
      llmCalls: [
        call({
          id: "c-1",
          stepType: "should_respond",
          response: '{"action":"RESPOND"}',
        }),
        call({
          id: "c-2",
          stepType: "response",
          actionType: "POSTGRES_QUERY",
          response: "{}",
        }),
      ],
      toolEvents: [
        tool({
          id: "e-1",
          actionName: "POSTGRES_QUERY",
          type: "tool_error",
          error: "ECONNREFUSED",
        }),
      ],
    };
    const phases = summarizePhases(detail, { trajectoryActive: false });
    expect(statusOf(phases, "ACTION")).toBe("error");
    expect(phases.find((p) => p.phase === "ACTION")?.summary).toBe(
      "POSTGRES_QUERY ✗",
    );
  });
});
