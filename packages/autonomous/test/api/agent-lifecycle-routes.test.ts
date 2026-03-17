import { describe, expect, test, vi } from "vitest";
import type {
  AgentLifecycleRouteContext,
  AgentLifecycleRouteState,
} from "../../src/api/agent-lifecycle-routes";
import { handleAgentLifecycleRoutes } from "../../src/api/agent-lifecycle-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildState(
  overrides?: Partial<AgentLifecycleRouteState>,
): AgentLifecycleRouteState {
  return {
    runtime: null,
    agentState: "not_started",
    agentName: "test-agent",
    model: undefined,
    startedAt: undefined,
    ...overrides,
  };
}

function buildCtx(
  method: string,
  pathname: string,
  state: AgentLifecycleRouteState,
  overrides?: Partial<AgentLifecycleRouteContext>,
): AgentLifecycleRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method, url: pathname }),
    res,
    method,
    pathname,
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    readJsonBody: vi.fn(async () => ({})),
    state,
    ...overrides,
  } as AgentLifecycleRouteContext;
}

describe("agent-lifecycle-routes", () => {
  describe("POST /api/agent/start", () => {
    test("transitions to paused and sets startedAt", async () => {
      const state = buildState({ agentState: "not_started" });
      const ctx = buildCtx("POST", "/api/agent/start", state);
      const handled = await handleAgentLifecycleRoutes(ctx);
      expect(handled).toBe(true);
      expect(state.agentState).toBe("paused");
      expect(state.startedAt).toBeDefined();
      expect(ctx.json).toHaveBeenCalled();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.ok).toBe(true);
      expect(payload.status.state).toBe("paused");
    });
  });

  describe("POST /api/agent/stop", () => {
    test("transitions to stopped and clears model/startedAt", async () => {
      const state = buildState({
        agentState: "running",
        startedAt: Date.now(),
        model: "gpt-4",
      });
      const ctx = buildCtx("POST", "/api/agent/stop", state);
      await handleAgentLifecycleRoutes(ctx);
      expect(state.agentState).toBe("stopped");
      expect(state.startedAt).toBeUndefined();
      expect(state.model).toBeUndefined();
    });
  });

  describe("POST /api/agent/pause", () => {
    test("transitions to paused and preserves startedAt", async () => {
      const started = Date.now() - 5000;
      const state = buildState({
        agentState: "running",
        startedAt: started,
        model: "gpt-4",
      });
      const ctx = buildCtx("POST", "/api/agent/pause", state);
      await handleAgentLifecycleRoutes(ctx);
      expect(state.agentState).toBe("paused");
      expect(state.startedAt).toBe(started);
    });
  });

  describe("POST /api/agent/resume", () => {
    test("transitions to running", async () => {
      const state = buildState({ agentState: "paused" });
      const ctx = buildCtx("POST", "/api/agent/resume", state);
      await handleAgentLifecycleRoutes(ctx);
      expect(state.agentState).toBe("running");
    });
  });

  describe("GET /api/agent/autonomy", () => {
    test("returns enabled false when no runtime", async () => {
      const state = buildState();
      const ctx = buildCtx("GET", "/api/agent/autonomy", state);
      await handleAgentLifecycleRoutes(ctx);
      expect(ctx.json).toHaveBeenCalled();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.enabled).toBe(false);
    });

    test("returns enabled true when runtime has autonomy", async () => {
      const state = buildState({
        runtime: {
          enableAutonomy: true,
        } as Pick<import("@elizaos/core").AgentRuntime, "enableAutonomy">,
      });
      const ctx = buildCtx("GET", "/api/agent/autonomy", state);
      await handleAgentLifecycleRoutes(ctx);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.enabled).toBe(true);
    });
  });

  describe("POST /api/agent/autonomy", () => {
    test("sets autonomy on runtime", async () => {
      const runtime = {
        enableAutonomy: false,
      } as Pick<import("@elizaos/core").AgentRuntime, "enableAutonomy">;
      const state = buildState({ runtime });
      const ctx = buildCtx("POST", "/api/agent/autonomy", state, {
        readJsonBody: vi.fn(async () => ({ enabled: true })),
      });
      await handleAgentLifecycleRoutes(ctx);
      expect(runtime.enableAutonomy).toBe(true);
    });

    test("rejects non-boolean enabled", async () => {
      const state = buildState({
        runtime: {} as Pick<
          import("@elizaos/core").AgentRuntime,
          "enableAutonomy"
        >,
      });
      const ctx = buildCtx("POST", "/api/agent/autonomy", state, {
        readJsonBody: vi.fn(async () => ({ enabled: "yes" })),
      });
      await handleAgentLifecycleRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
    });

    test("rejects when no runtime", async () => {
      const state = buildState();
      const ctx = buildCtx("POST", "/api/agent/autonomy", state, {
        readJsonBody: vi.fn(async () => ({ enabled: true })),
      });
      await handleAgentLifecycleRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const state = buildState();
      const ctx = buildCtx("GET", "/api/other", state);
      expect(await handleAgentLifecycleRoutes(ctx)).toBe(false);
    });
  });
});
