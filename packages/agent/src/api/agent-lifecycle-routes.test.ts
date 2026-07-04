/**
 * Covers handleAgentLifecycleRoutes: POST /api/agent/start moves the shared agent
 * state to running and reports uptime/startedAt, and POST /api/agent/pause moves
 * running → paused. Deterministic: mutates a plain in-memory state object with
 * mocked json/error responders, no runtime or live model.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentLifecycleRouteState,
  handleAgentLifecycleRoutes,
} from "./agent-lifecycle-routes";

function makeState(): AgentLifecycleRouteState {
  return {
    runtime: null,
    agentState: "stopped",
    agentName: "Eliza",
    model: undefined,
    startedAt: undefined,
  };
}

function makeCtx(
  method: string,
  pathname: string,
  state: AgentLifecycleRouteState = makeState(),
) {
  const json = vi.fn();
  const error = vi.fn();
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody: vi.fn(),
    },
    state,
    json,
    error,
  };
}

describe("handleAgentLifecycleRoutes", () => {
  it("starts the agent in running state", async () => {
    const { ctx, state, json } = makeCtx("POST", "/api/agent/start");

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("running");
    expect(state.startedAt).toEqual(expect.any(Number));
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        status: expect.objectContaining({
          state: "running",
          agentName: "Eliza",
          uptime: 0,
          startedAt: state.startedAt,
        }),
      }),
    );
  });

  it("keeps pause as the explicit paused transition", async () => {
    const state = {
      ...makeState(),
      agentState: "running" as const,
      startedAt: Date.now() - 1_000,
    };
    const { ctx, json } = makeCtx("POST", "/api/agent/pause", state);

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("paused");
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        status: expect.objectContaining({
          state: "paused",
          agentName: "Eliza",
        }),
      }),
    );
  });
});
