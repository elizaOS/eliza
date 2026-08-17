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
} {
  const req = { url: pathname } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
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

  return { ctx, json, error };
}

describe("handleMiscRoutes custom actions encoding", () => {
  it("rejects malformed percent-encoding on POST /api/custom-actions/:id/test with 400", async () => {
    const { ctx, error } = makeCustomActionContext(
      "POST",
      "/api/custom-actions/%/test",
      { params: {} },
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid action id encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on PUT /api/custom-actions/:id with 400", async () => {
    const { ctx, error } = makeCustomActionContext(
      "PUT",
      "/api/custom-actions/%",
      { name: "TEST_ACTION" },
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid action id encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on DELETE /api/custom-actions/:id with 400", async () => {
    const { ctx, error } = makeCustomActionContext(
      "DELETE",
      "/api/custom-actions/%",
    );

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid action id encoding",
      400,
    );
  });
});
