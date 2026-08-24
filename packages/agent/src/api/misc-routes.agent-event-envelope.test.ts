/**
 * Covers the agent-event ingestion envelope contract in `handleMiscRoutes`:
 * the per-agent gateway variant's normalization into a system-stream
 * envelope, runtime-identity admission before buffering, the 1500-envelope
 * replay-buffer cap, broadcast copy isolation, and event-id sequencing.
 * Deterministic unit harness: the HTTP transport boundary (json/error/
 * readJsonBody) is a spy seam and the route module under test is real.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleMiscRoutes, type MiscRouteContext } from "./misc-routes";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers";

const RUNTIME_AGENT_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const FOREIGN_AGENT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function makeAgentEventContext(pathname: string): {
  ctx: MiscRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
} {
  const req = { url: pathname } as http.IncomingMessage;
  const res = {
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  const broadcastWs = vi.fn();

  return {
    ctx: {
      req,
      res,
      method: "POST",
      pathname,
      url: new URL(`http://localhost${pathname}`),
      state: {
        config: {} as MiscRouteContext["state"]["config"],
        runtime: { agentId: RUNTIME_AGENT_ID } as AgentRuntime,
        agentState: "running",
        agentName: "Eliza",
        shellEnabled: true,
        broadcastWs,
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
      readJsonBody,
      AGENT_EVENT_ALLOWED_STREAMS,
      resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
      resolveTerminalRunClientId: vi.fn().mockReturnValue(null),
      isSharedTerminalClientId: vi.fn().mockReturnValue(false),
      activeTerminalRunCount: 0,
      setActiveTerminalRunCount: vi.fn(),
    },
    json,
    error,
    readJsonBody,
    broadcastWs,
  };
}

describe("handleMiscRoutes agent event envelope", () => {
  it("normalizes a per-agent gateway event into a system-stream envelope", async () => {
    const gatewayPayload = { kind: "ping" };
    const { ctx, json, error, readJsonBody } = makeAgentEventContext(
      `/api/agents/${RUNTIME_AGENT_ID}/event`,
    );
    readJsonBody.mockResolvedValue({
      type: "ping",
      userId: "user-9",
      payload: gatewayPayload,
    });

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
    expect(ctx.state.eventBuffer).toHaveLength(1);
    expect(ctx.state.eventBuffer[0]).toMatchObject({
      type: "agent_event",
      version: 1,
      eventId: "evt-1",
      stream: "system",
      agentId: RUNTIME_AGENT_ID,
      payload: {
        gatewayType: "ping",
        userId: "user-9",
        payload: gatewayPayload,
      },
    });
    expect(readJsonBody).toHaveBeenCalledOnce();
  });

  it("rejects a valid but foreign agent id with 404 before buffering or broadcasting", async () => {
    const { ctx, json, error, broadcastWs, readJsonBody } =
      makeAgentEventContext(`/api/agents/${FOREIGN_AGENT_ID}/event`);
    readJsonBody.mockResolvedValue({ type: "ping", payload: {} });

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      { error: "Agent not found" },
      404,
    );
    expect(ctx.state.eventBuffer).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("caps the replay buffer at 1500 envelopes by dropping the oldest", async () => {
    const { ctx, json, error, readJsonBody } =
      makeAgentEventContext("/api/agent/event");
    for (let i = 0; i < 1500; i++) {
      ctx.state.eventBuffer.push({
        type: "agent_event",
        version: 1,
        eventId: `seed-${i}`,
        ts: i,
        stream: "chat",
        payload: { i },
      });
    }
    ctx.state.nextEventId = 1500;
    readJsonBody.mockResolvedValue({ stream: "chat", data: { n: 1 } });

    const handled = await handleMiscRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(ctx.state.eventBuffer).toHaveLength(1500);
    expect(ctx.state.eventBuffer[0]?.eventId).toBe("seed-1");
    expect(ctx.state.eventBuffer[1499]).toMatchObject({
      eventId: "evt-1500",
      stream: "chat",
      payload: { n: 1 },
    });
    expect(ctx.state.nextEventId).toBe(1501);
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("broadcasts a copy that never aliases the buffered envelope", async () => {
    const { ctx, broadcastWs, readJsonBody } =
      makeAgentEventContext("/api/agent/event");
    readJsonBody.mockResolvedValue({
      stream: "notification",
      data: { hello: "world" },
    });

    await handleMiscRoutes(ctx);

    expect(broadcastWs).toHaveBeenCalledOnce();
    const buffered = ctx.state.eventBuffer[0];
    const broadcastPayload = broadcastWs.mock.calls[0]?.[0];
    expect(buffered).toBeDefined();
    expect(broadcastPayload).toEqual(buffered);
    expect(broadcastPayload).not.toBe(buffered);
  });

  it("passes roomId through, defaults missing data to an empty payload, and increments event ids", async () => {
    const { ctx, error, readJsonBody } =
      makeAgentEventContext("/api/agent/event");
    readJsonBody.mockResolvedValueOnce({ stream: "chat", roomId: "room-7" });
    readJsonBody.mockResolvedValueOnce({ stream: "chat" });

    expect(await handleMiscRoutes(ctx)).toBe(true);
    expect(await handleMiscRoutes(ctx)).toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(ctx.state.eventBuffer).toHaveLength(2);
    expect(ctx.state.eventBuffer[0]).toMatchObject({
      eventId: "evt-1",
      roomId: "room-7",
      payload: {},
    });
    expect(ctx.state.eventBuffer[1]).toMatchObject({
      eventId: "evt-2",
      roomId: undefined,
      payload: {},
    });
    expect(ctx.state.nextEventId).toBe(3);
  });
});
