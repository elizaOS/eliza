import type { ServerResponse } from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { tryHandleTrajectoryFallback } from "./trajectory-fallback-routes.ts";

// Minimal ServerResponse capture — records statusCode + parsed JSON body.
function mockRes(): {
  res: ServerResponse;
  get: () => { status: number; body: unknown };
} {
  const state = { status: 0, body: undefined as unknown, ended: false };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(payload?: string) {
      state.status = (this as { statusCode: number }).statusCode;
      state.body = payload ? JSON.parse(payload) : undefined;
      state.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, get: () => ({ status: state.status, body: state.body }) };
}

function runtimeWith(service: unknown): AgentRuntime {
  return {
    getService: (type: string) => (type === "trajectories" ? service : null),
  } as unknown as AgentRuntime;
}

const url = (p: string) => new URL(`http://localhost${p}`);

describe("tryHandleTrajectoryFallback", () => {
  it("ignores non-trajectory paths and non-GET methods", async () => {
    const { res } = mockRes();
    expect(
      await tryHandleTrajectoryFallback({
        pathname: "/api/health",
        method: "GET",
        url: url("/api/health"),
        runtime: runtimeWith({}),
        res,
      }),
    ).toBe(false);
    expect(
      await tryHandleTrajectoryFallback({
        pathname: "/api/trajectories",
        method: "DELETE",
        url: url("/api/trajectories"),
        runtime: runtimeWith({}),
        res,
      }),
    ).toBe(false);
  });

  it("lists trajectories from the core service (UI shape, timeout→error)", async () => {
    const service = {
      listTrajectories: async () => ({
        trajectories: [
          { id: "t1", status: "completed", llmCallCount: 3 },
          { id: "t2", status: "timeout", llmCallCount: 1 },
        ],
        total: 2,
      }),
    };
    const { res, get } = mockRes();
    const handled = await tryHandleTrajectoryFallback({
      pathname: "/api/trajectories",
      method: "GET",
      url: url("/api/trajectories?limit=10"),
      runtime: runtimeWith(service),
      res,
    });
    expect(handled).toBe(true);
    const { status, body } = get();
    expect(status).toBe(200);
    const b = body as {
      trajectories: Array<Record<string, unknown>>;
      total: number;
    };
    expect(b.total).toBe(2);
    expect(b.trajectories[0]).toMatchObject({
      id: "t1",
      status: "completed",
      llmCallCount: 3,
    });
    // timeout collapses to the viewer's tri-state "error"
    expect(b.trajectories[1]).toMatchObject({ id: "t2", status: "error" });
  });

  it("maps detail steps into phase-classified llmCalls / providerAccesses / toolEvents", async () => {
    const service = {
      getTrajectoryDetail: async (id: string) => ({
        trajectoryId: id,
        endTime: 1000,
        metrics: { finalStatus: "completed" },
        steps: [
          {
            stepId: "s0",
            llmCalls: [
              {
                callId: "c0",
                model: "m",
                response: "RESPOND",
                stepType: "should_respond",
              },
              {
                callId: "c1",
                model: "m",
                response: "plan",
                stepType: "reasoning",
              },
            ],
            providerAccesses: [
              { providerId: "p0", providerName: "facts", purpose: "ctx" },
            ],
            action: { attemptId: "a0", actionName: "REPLY", success: true },
          },
        ],
      }),
    };
    const { res, get } = mockRes();
    const handled = await tryHandleTrajectoryFallback({
      pathname: "/api/trajectories/abc",
      method: "GET",
      url: url("/api/trajectories/abc"),
      runtime: runtimeWith(service),
      res,
    });
    expect(handled).toBe(true);
    const { status, body } = get();
    expect(status).toBe(200);
    const b = body as {
      trajectory: { id: string; status: string; llmCallCount: number };
      llmCalls: Array<{ stepType: string }>;
      providerAccesses: unknown[];
      toolEvents: Array<{ actionName: string; success: boolean }>;
    };
    expect(b.trajectory).toMatchObject({
      id: "abc",
      status: "completed",
      llmCallCount: 2,
    });
    expect(b.llmCalls.map((c) => c.stepType)).toEqual([
      "should_respond",
      "reasoning",
    ]);
    expect(b.providerAccesses).toHaveLength(1);
    expect(b.toolEvents[0]).toMatchObject({
      actionName: "REPLY",
      success: true,
      type: "tool_result",
    });
  });

  it("404s an unknown detail id", async () => {
    const service = { getTrajectoryDetail: async () => null };
    const { res, get } = mockRes();
    const handled = await tryHandleTrajectoryFallback({
      pathname: "/api/trajectories/missing",
      method: "GET",
      url: url("/api/trajectories/missing"),
      runtime: runtimeWith(service),
      res,
    });
    expect(handled).toBe(true);
    expect(get().status).toBe(404);
  });

  it("returns an empty list (200, not 404) when the service is absent", async () => {
    const { res, get } = mockRes();
    const handled = await tryHandleTrajectoryFallback({
      pathname: "/api/trajectories",
      method: "GET",
      url: url("/api/trajectories"),
      runtime: runtimeWith(null),
      res,
    });
    expect(handled).toBe(true);
    expect(get().status).toBe(200);
    expect((get().body as { trajectories: unknown[] }).trajectories).toEqual(
      [],
    );
  });

  it("does not treat /stats or /config as a detail id", async () => {
    const service = {
      getStats: async () => ({ totalTrajectories: 5 }),
      getTrajectoryDetail: async () => {
        throw new Error("should not be called for /stats");
      },
    };
    const { res, get } = mockRes();
    const handled = await tryHandleTrajectoryFallback({
      pathname: "/api/trajectories/stats",
      method: "GET",
      url: url("/api/trajectories/stats"),
      runtime: runtimeWith(service),
      res,
    });
    expect(handled).toBe(true);
    expect(get().status).toBe(200);
    expect(get().body).toMatchObject({ totalTrajectories: 5 });
  });
});
