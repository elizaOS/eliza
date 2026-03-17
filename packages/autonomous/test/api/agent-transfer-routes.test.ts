import { describe, expect, test, vi } from "vitest";
import type { AgentTransferRouteContext } from "../../src/api/agent-transfer-routes";
import { handleAgentTransferRoutes } from "../../src/api/agent-transfer-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<AgentTransferRouteContext>,
): AgentTransferRouteContext & {
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
    readJsonBody: vi.fn(async () => null),
    state: {
      runtime: null,
    },
    exportAgent: vi.fn(async () => Buffer.from("exported")),
    estimateExportSize: vi.fn(async () => ({ estimatedBytes: 1024 })),
    importAgent: vi.fn(async () => ({ ok: true })),
    isAgentExportError: () => false,
    ...overrides,
    getStatus,
    getJson,
  } as AgentTransferRouteContext & {
    getStatus: () => number;
    getJson: () => unknown;
  };
  return ctx;
}

describe("agent-transfer-routes", () => {
  describe("POST /api/agent/export", () => {
    test("returns 503 when no runtime", async () => {
      const ctx = buildCtx("POST", "/api/agent/export");
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(503);
      expect(args[1]).toContain("not running");
    });

    test("returns 400 when password is missing", async () => {
      const mockRuntime: Pick<
        import("@elizaos/core").AgentRuntime,
        "character"
      > = { character: { name: "Agent" } };
      const ctx = buildCtx("POST", "/api/agent/export", {
        state: { runtime: mockRuntime },
        readJsonBody: vi.fn(async () => ({})),
      });
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(400);
    });

    test("exports successfully with valid password", async () => {
      const mockRuntime: Pick<
        import("@elizaos/core").AgentRuntime,
        "character"
      > = { character: { name: "Agent" } };
      const ctx = buildCtx("POST", "/api/agent/export", {
        state: { runtime: mockRuntime },
        readJsonBody: vi.fn(async () => ({
          password: "secret1234",
          includeLogs: false,
        })),
      });
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.exportAgent).toHaveBeenCalledOnce();
      expect(ctx.error).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/agent/export/estimate", () => {
    test("returns 503 when no runtime", async () => {
      const ctx = buildCtx("GET", "/api/agent/export/estimate");
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(503);
    });

    test("returns estimate when runtime is available", async () => {
      const mockRuntime: Pick<
        import("@elizaos/core").AgentRuntime,
        "character"
      > = { character: { name: "Agent" } };
      const ctx = buildCtx("GET", "/api/agent/export/estimate", {
        state: { runtime: mockRuntime },
      });
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      expect(ctx.estimateExportSize).toHaveBeenCalledWith(mockRuntime);
    });
  });

  describe("POST /api/agent/import", () => {
    test("returns 503 when no runtime", async () => {
      const ctx = buildCtx("POST", "/api/agent/import");
      const handled = await handleAgentTransferRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(503);
      expect(args[1]).toContain("not running");
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleAgentTransferRoutes(ctx)).toBe(false);
    });

    test("wrong method for export returns false", async () => {
      const ctx = buildCtx("GET", "/api/agent/export");
      expect(await handleAgentTransferRoutes(ctx)).toBe(false);
    });
  });
});
