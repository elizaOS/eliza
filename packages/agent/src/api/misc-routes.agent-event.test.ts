/**
 * Checks that handleMiscRoutes accepts POST /api/agent/event notification-stream
 * events — buffering the envelope and broadcasting it over WS — using a fully
 * mocked route context (vi.fn spies for json/error/readJsonBody and broadcast).
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleMiscRoutes, type MiscRouteContext } from "./misc-routes";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers";

function makeAgentEventContext(
  body: Record<string, unknown>,
): MiscRouteContext {
  const req = { url: "/api/agent/event" } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const broadcastWs = vi.fn();

  return {
    req,
    res,
    method: "POST",
    pathname: "/api/agent/event",
    url: new URL("http://localhost/api/agent/event"),
    state: {
      config: {} as MiscRouteContext["state"]["config"],
      runtime: {
        agentId: "00000000-0000-0000-0000-0000000000aa",
      } as AgentRuntime,
      agentState: "ready",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs,
      broadcastWsToClientId: vi.fn(),
      nextEventId: 1,
      eventBuffer: [],
      shareIngestQueue: [],
      startup: {},
      broadcastStatus: vi.fn(),
      pendingRestartReasons: [],
    },
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn().mockResolvedValue(body),
    AGENT_EVENT_ALLOWED_STREAMS,
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue(null),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
  };
}

describe("handleMiscRoutes agent events", () => {
  it("accepts notification stream events for the live notification rail", async () => {
    const payload = {
      notification: {
        id: "n-1",
        title: "Job complete",
        category: "workflow",
        priority: "normal",
        createdAt: 1,
        readAt: null,
      },
      unreadCount: 1,
    };
    const ctx = makeAgentEventContext({
      stream: "notification",
      data: payload,
    });

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.error).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, { ok: true });
    expect(ctx.state.eventBuffer).toHaveLength(1);
    expect(ctx.state.eventBuffer[0]).toMatchObject({
      type: "agent_event",
      version: 1,
      eventId: "evt-1",
      stream: "notification",
      payload,
    });
    expect(ctx.state.broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_event",
        stream: "notification",
        payload,
      }),
    );
  });
});
