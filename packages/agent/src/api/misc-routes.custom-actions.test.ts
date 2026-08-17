/**
 * Unit tests for custom-action route handlers in `handleMiscRoutes`.
 * Deterministic: validates that malformed percent-encoding in custom-action URLs
 * fails closed with 400 Bad Request per Error Policy J3.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleMiscRoutes, type MiscRouteContext } from "./misc-routes";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers";

function makeCustomActionContext(
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
): {
  ctx: MiscRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const req = { url: pathname } as http.IncomingMessage;
  const end = vi.fn();
  const res = {
    setHeader: vi.fn(),
    end,
  } as unknown as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();

  const ctx: MiscRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    state: {
      config: {} as MiscRouteContext["state"]["config"],
      runtime: {
        agentId: "00000000-0000-0000-0000-0000000000aa",
      } as AgentRuntime,
      agentState: "running",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs: vi.fn(),
      broadcastWsToClientId: vi.fn(),
      nextEventId: 1,
      eventBuffer: [],
      shareIngestQueue: [],
      startup: { phase: "running", attempt: 0 },
      broadcastStatus: vi.fn(),
      pendingRestartReasons: [],
    },
    json,
    error,
    readJsonBody: vi.fn().mockResolvedValue(body),
    AGENT_EVENT_ALLOWED_STREAMS,
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue(null),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
  };

  return { ctx, json, error, end };
}

describe("handleMiscRoutes custom actions encoding", () => {
  it("rejects malformed percent-encoding on POST /api/custom-actions/:id/test with 400", async () => {
    const { ctx, end, error } = makeCustomActionContext(
      "POST",
      "/api/custom-actions/%/test",
      { params: {} },
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Invalid custom action id: malformed URL encoding",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding on PUT /api/custom-actions/:id with 400", async () => {
    const { ctx, end, error } = makeCustomActionContext(
      "PUT",
      "/api/custom-actions/%",
      { name: "TEST_ACTION" },
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Invalid custom action id: malformed URL encoding",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding on DELETE /api/custom-actions/:id with 400", async () => {
    const { ctx, end, error } = makeCustomActionContext(
      "DELETE",
      "/api/custom-actions/%",
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Invalid custom action id: malformed URL encoding",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/custom-actions/not%2Da%2Duuid/test"],
    ["PUT", "/api/custom-actions/not%2Da%2Duuid"],
    ["DELETE", "/api/custom-actions/not%2Da%2Duuid"],
  ])("rejects a decoded non-UUID on %s %s", async (method, pathname) => {
    const { ctx, error } = makeCustomActionContext(method, pathname, {
      params: {},
    });

    expect(await handleMiscRoutes(ctx)).toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid custom action id",
      400,
    );
  });
});
