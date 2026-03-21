import { describe, expect, test, vi } from "vitest";
import type { AgentAdminRouteContext } from "../../src/api/agent-admin-routes";
import { handleAgentAdminRoutes } from "../../src/api/agent-admin-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<AgentAdminRouteContext>,
): AgentAdminRouteContext & {
  getStatus: () => number;
  getJson: () => unknown;
} {
  const { res, getStatus, getJson } = createMockHttpResponse();
  const req = createMockIncomingMessage({ method, url: pathname });
  const ctx = {
    req,
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
    state: {
      runtime: null,
      config: {},
      agentState: "running" as const,
      agentName: "TestAgent",
      model: "gpt-4",
      startedAt: Date.now(),
      chatRoomId: null,
      chatUserId: null,
      chatConnectionReady: null,
      chatConnectionPromise: null,
      pendingRestartReasons: [],
    },
    onRestart: undefined,
    onRuntimeSwapped: undefined,
    resolveStateDir: () => "/tmp/eliza-state",
    resolvePath: (value: string) => value,
    getHomeDir: () => "/home/test",
    isSafeResetStateDir: () => true,
    stateDirExists: () => false,
    removeStateDir: vi.fn(),
    logWarn: vi.fn(),
    getStatus,
    getJson,
    ...overrides,
  } as AgentAdminRouteContext & {
    getStatus: () => number;
    getJson: () => unknown;
  };
  return ctx;
}

describe("agent-admin-routes", () => {
  describe("POST /api/agent/restart", () => {
    test("returns 501 when no onRestart handler is registered", async () => {
      const ctx = buildCtx("POST", "/api/agent/restart");
      const handled = await handleAgentAdminRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(501);
      expect(args[1]).toContain("not supported");
    });

    test("returns 409 when agent is already restarting", async () => {
      const ctx = buildCtx("POST", "/api/agent/restart", {
        onRestart: vi.fn(async () => null),
        state: {
          runtime: null,
          config: {},
          agentState: "restarting",
          agentName: "TestAgent",
          model: "gpt-4",
          startedAt: Date.now(),
          chatRoomId: null,
          chatUserId: null,
          chatConnectionReady: null,
          chatConnectionPromise: null,
          pendingRestartReasons: [],
        },
      });
      const handled = await handleAgentAdminRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(409);
      expect(args[1]).toContain("already in progress");
    });

    test("returns success when onRestart returns a new runtime", async () => {
      const mockRuntime: Pick<
        import("@elizaos/core").AgentRuntime,
        "character" | "getSetting" | "modelProvider"
      > = {
        character: { name: "NewAgent" },
        getSetting: () => undefined,
        modelProvider: "openai",
      };
      const onRestart = vi.fn(async () => mockRuntime);
      const onRuntimeSwapped = vi.fn();
      const ctx = buildCtx("POST", "/api/agent/restart", {
        onRestart,
        onRuntimeSwapped,
      });
      const handled = await handleAgentAdminRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.ok).toBe(true);
      expect(payload.pendingRestart).toBe(false);
      expect(ctx.state.agentState).toBe("running");
      expect(onRuntimeSwapped).toHaveBeenCalled();
    });

    test("returns 500 when onRestart returns null", async () => {
      const ctx = buildCtx("POST", "/api/agent/restart", {
        onRestart: vi.fn(async () => null),
      });
      const handled = await handleAgentAdminRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(500);
      expect(args[1]).toContain("failed to re-initialize");
      expect(ctx.state.agentState).toBe("running");
    });

    test("returns 500 when onRestart throws", async () => {
      const ctx = buildCtx("POST", "/api/agent/restart", {
        onRestart: vi.fn(async () => {
          throw new Error("boom");
        }),
      });
      const handled = await handleAgentAdminRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(500);
      expect(args[1]).toContain("boom");
      expect(ctx.state.agentState).toBe("running");
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleAgentAdminRoutes(ctx)).toBe(false);
    });

    test("GET to restart endpoint returns false (wrong method)", async () => {
      const ctx = buildCtx("GET", "/api/agent/restart");
      expect(await handleAgentAdminRoutes(ctx)).toBe(false);
    });
  });
});
