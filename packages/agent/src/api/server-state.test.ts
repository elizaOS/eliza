/** Characterizes API state construction without binding sockets or loading routes. */
import { describe, expect, it, vi } from "vitest";
import { createServerState } from "./server-state.ts";

function options(runtime?: Parameters<typeof createServerState>[0]["runtime"]) {
  return {
    config: {},
    runtime,
    plugins: [],
    deletedConversationIds: new Set<string>(),
    resolveAgentName: () => "Eliza",
    detectRuntimeModel: () => "model",
    resolveAgentAutomationMode: () => "connectors-only" as const,
    resolveTradePermissionMode: () => "user-sign-only" as const,
  };
}

describe("createServerState", () => {
  it("creates an honest first-run state without fabricating a runtime", () => {
    const state = createServerState(options());
    expect(state).toMatchObject({
      runtime: null,
      agentState: "not_started",
      startup: { phase: "idle", attempt: 0 },
      agentName: "Eliza",
      model: undefined,
    });
  });

  it("derives running state from a supplied runtime", () => {
    const runtime = {
      character: { name: "Ada" },
    } as Parameters<typeof createServerState>[0]["runtime"];
    const detectRuntimeModel = vi.fn(() => "provider/model");
    const state = createServerState({
      ...options(runtime),
      detectRuntimeModel,
    });
    expect(state.agentState).toBe("running");
    expect(state.agentName).toBe("Ada");
    expect(state.model).toBe("provider/model");
    expect(state.startedAt).toEqual(expect.any(Number));
  });

  it("preserves an explicit starting state while no runtime exists", () => {
    const state = createServerState({
      ...options(),
      initialAgentState: "starting",
    });
    expect(state.agentState).toBe("starting");
    expect(state.startup.phase).toBe("starting");
    expect(state.startedAt).toEqual(expect.any(Number));
  });
});
