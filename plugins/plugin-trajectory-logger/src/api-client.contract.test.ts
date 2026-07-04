/**
 * External API contract tests for the trajectory logger client.
 * The fixtures mirror plugin-training route responses so the real parser and phase summarizers are checked against the wire shape this widget reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
  type TrajectoryDetail,
  type TrajectoryListResult,
} from "./api-client.js";
import { extractShouldRespondDecision, summarizePhases } from "./phases.js";

const LIST_PAYLOAD = {
  trajectories: [
    {
      id: "traj-001",
      agentId: "agent-abc",
      roomId: "room-xyz",
      entityId: "entity-1",
      conversationId: "conv-1",
      source: "chat",
      status: "active",
      startTime: 1_700_000_000_000,
      endTime: null,
      durationMs: null,
      llmCallCount: 3,
      providerAccessCount: 2,
      totalPromptTokens: 120,
      totalCompletionTokens: 45,
      metadata: { roomId: "room-xyz" },
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:13:20.000Z",
    },
    {
      id: "traj-000",
      agentId: "agent-abc",
      roomId: null,
      entityId: null,
      conversationId: null,
      source: "chat",
      status: "completed",
      startTime: 1_699_000_000_000,
      endTime: 1_699_000_002_500,
      durationMs: 2_500,
      llmCallCount: 4,
      providerAccessCount: 1,
      totalPromptTokens: 300,
      totalCompletionTokens: 90,
      metadata: {},
      createdAt: "2023-11-03T08:26:40.000Z",
      updatedAt: "2023-11-03T08:26:42.500Z",
    },
  ],
  total: 2,
  offset: 0,
  limit: 10,
};

const DETAIL_PAYLOAD = {
  trajectory: { ...LIST_PAYLOAD.trajectories[1], status: "completed" },
  llmCalls: [
    {
      id: "s1-call-0",
      trajectoryId: "traj-000",
      stepId: "s1",
      model: "gpt-x",
      systemPrompt: "you are eliza",
      userPrompt: "what's the weather",
      response:
        '{"action":"RESPOND","reasoning":"a direct question was asked"}',
      temperature: 0.7,
      maxTokens: 256,
      purpose: "should_respond",
      actionType: "",
      stepType: "should_respond",
      tags: ["handle"],
      latencyMs: 90,
      promptTokens: 80,
      completionTokens: 12,
      timestamp: 1_699_000_000_100,
      createdAt: "2023-11-03T08:26:40.100Z",
    },
    {
      id: "s2-call-0",
      trajectoryId: "traj-000",
      stepId: "s2",
      model: "gpt-x",
      systemPrompt: "",
      userPrompt: "",
      response: "It is sunny and 21C in your area.",
      temperature: 0.7,
      maxTokens: 256,
      purpose: "response",
      actionType: "REPLY",
      stepType: "response",
      tags: ["plan"],
      latencyMs: 140,
      promptTokens: 220,
      completionTokens: 78,
      timestamp: 1_699_000_000_900,
      createdAt: "2023-11-03T08:26:40.900Z",
    },
  ],
  providerAccesses: [
    {
      id: "s1-provider-0",
      trajectoryId: "traj-000",
      stepId: "s1",
      providerName: "WEATHER",
      purpose: "context",
      data: { temp: 21 },
      timestamp: 1_699_000_000_050,
      createdAt: "2023-11-03T08:26:40.050Z",
    },
  ],
  toolEvents: [
    {
      id: "tool-event-0",
      trajectoryId: "traj-000",
      stepId: "s2",
      type: "tool_result",
      actionName: "REPLY",
      status: "completed",
      success: true,
      durationMs: 30,
      timestamp: 1_699_000_001_000,
    },
  ],
  evaluationEvents: [
    {
      id: "evaluation-event-0",
      trajectoryId: "traj-000",
      stepId: "s2",
      type: "evaluator",
      evaluatorName: "REFLECTION",
      decision: "continue",
      thought: "the response was relevant",
      success: true,
      durationMs: 15,
      timestamp: 1_699_000_001_200,
    },
  ],
};

function stubOkFetch(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTrajectoryList contract", () => {
  it("parses the real {trajectories,total,offset,limit} envelope into a contract-valid DTO", async () => {
    stubOkFetch(LIST_PAYLOAD);
    const result: TrajectoryListResult = await fetchTrajectoryList({
      limit: 10,
    });

    expect(result.total).toBe(2);
    expect(result.trajectories).toHaveLength(2);
    const [first] = result.trajectories;
    // The widget's TrajectoryListItem fields are present and typed.
    expect(first.id).toBe("traj-001");
    expect(first.status).toBe("active");
    expect(first.llmCallCount).toBe(3);
    // The extra UITrajectoryRecord fields are tolerated (untyped, still present).
    expect((first as unknown as { agentId: string }).agentId).toBe("agent-abc");
  });
});

describe("fetchTrajectoryDetail contract", () => {
  it("parses a real UITrajectoryDetailResult into a contract-valid TrajectoryDetail", async () => {
    stubOkFetch(DETAIL_PAYLOAD);
    const detail: TrajectoryDetail = await fetchTrajectoryDetail("traj-000");

    expect(detail.trajectory.id).toBe("traj-000");
    expect(detail.llmCalls).toHaveLength(2);
    expect(detail.providerAccesses).toHaveLength(1);
    expect(detail.toolEvents).toHaveLength(1);
    expect(detail.evaluationEvents).toHaveLength(1);

    // Field-level contract: llmCall carries stepType/purpose/actionType/response.
    const handleCall = detail.llmCalls[0];
    expect(handleCall.stepType).toBe("should_respond");
    expect(handleCall.response).toContain('"action":"RESPOND"');
    const planCall = detail.llmCalls[1];
    expect(planCall.actionType).toBe("REPLY");
    expect(planCall.stepType).toBe("response");

    // toolEvent / evaluationEvent discriminants the UI reads.
    expect(detail.toolEvents?.[0].type).toBe("tool_result");
    expect(detail.toolEvents?.[0].actionName).toBe("REPLY");
    expect(detail.evaluationEvents?.[0].evaluatorName).toBe("REFLECTION");
    expect(detail.evaluationEvents?.[0].decision).toBe("continue");
  });

  it("classifies the real detail payload through the full HANDLE/PLAN/ACTION/EVALUATE pipeline", async () => {
    stubOkFetch(DETAIL_PAYLOAD);
    const detail = await fetchTrajectoryDetail("traj-000");

    const phases = summarizePhases(detail, { trajectoryActive: false });
    const byName = Object.fromEntries(phases.map((p) => [p.phase, p]));

    // HANDLE: should_respond -> RESPOND -> done, summary "respond".
    expect(byName.HANDLE.status).toBe("done");
    expect(byName.HANDLE.summary).toBe("respond");
    // PLAN: response call -> done, actionType "REPLY".
    expect(byName.PLAN.status).toBe("done");
    expect(byName.PLAN.summary).toBe("REPLY");
    // ACTION: tool_result success -> done, name "REPLY".
    expect(byName.ACTION.status).toBe("done");
    expect(byName.ACTION.summary).toBe("REPLY");
    // EVALUATE: evaluator with decision -> done, "REFLECTION: continue".
    expect(byName.EVALUATE.status).toBe("done");
    expect(byName.EVALUATE.summary).toBe("REFLECTION: continue");

    // extractShouldRespondDecision over the real should_respond response.
    const decision = extractShouldRespondDecision(detail.llmCalls[0]);
    expect(decision).toEqual({
      decision: "RESPOND",
      reasoning: "a direct question was asked",
    });
  });
});

describe("readJson error path", () => {
  it("throws the '[trajectory-logger] <status> <statusText>: <body>' message on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "Trajectories service not available",
      })) as unknown as typeof fetch,
    );
    await expect(fetchTrajectoryList()).rejects.toThrow(
      "[trajectory-logger] 503 Service Unavailable: Trajectories service not available",
    );
  });
});
