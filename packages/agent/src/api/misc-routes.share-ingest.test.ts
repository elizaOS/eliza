/**
 * GET /api/ingest/share `consume` identity.
 *
 * Stock develop treated only the exact token `1` as drain. `consume=true`
 * (and every other canonical boolean) peeked, so share-sheet items stayed
 * in the in-memory queue and the next poll duplicated them. Garbage tokens
 * also peeked. Omitted still peeks. Canonical true identities drain once.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleMiscRoutes, type MiscRouteContext } from "./misc-routes";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers";

function makeShareCtx(search = ""): {
  ctx: MiscRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const queued = [
    {
      id: "share-1",
      source: "android-share-sheet",
      title: "Design doc",
      suggestedPrompt: "Review the shared design doc",
      receivedAt: 1,
    },
  ];
  const ctx: MiscRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/ingest/share",
    url: new URL(`http://localhost/api/ingest/share${search}`),
    state: {
      config: {} as MiscRouteContext["state"]["config"],
      runtime: null,
      agentState: "running",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs: vi.fn(),
      broadcastWsToClientId: vi.fn(),
      nextEventId: 1,
      eventBuffer: [],
      shareIngestQueue: queued,
      startup: { phase: "running", attempt: 0 },
      broadcastStatus: vi.fn(),
      pendingRestartReasons: [],
    },
    json,
    error,
    readJsonBody: vi.fn(),
    AGENT_EVENT_ALLOWED_STREAMS,
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue(null),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
  };
  return { ctx, json, error };
}

describe("GET /api/ingest/share consume identity", () => {
  it("omitted consume peeks and leaves the queue", async () => {
    const { ctx, json, error } = makeShareCtx();
    await expect(handleMiscRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      items: ctx.state.shareIngestQueue,
    });
    expect(ctx.state.shareIngestQueue).toHaveLength(1);
  });

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "consume=%s drains the queue once",
    async (token) => {
      const { ctx, json, error } = makeShareCtx(`?consume=${token}`);
      await expect(handleMiscRoutes(ctx)).resolves.toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(ctx.res, {
        items: [
          {
            id: "share-1",
            source: "android-share-sheet",
            title: "Design doc",
            suggestedPrompt: "Review the shared design doc",
            receivedAt: 1,
          },
        ],
      });
      expect(ctx.state.shareIngestQueue).toHaveLength(0);
    },
  );

  it.each(["0", "false", "FALSE", "no", "off"])(
    "consume=%s peeks without draining",
    async (token) => {
      const { ctx, json, error } = makeShareCtx(`?consume=${token}`);
      await expect(handleMiscRoutes(ctx)).resolves.toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(ctx.res, {
        items: ctx.state.shareIngestQueue,
      });
      expect(ctx.state.shareIngestQueue).toHaveLength(1);
    },
  );

  it.each(["truee", "1e2", "12px", "maybe", "2"])(
    "rejects non-boolean consume=%s before touching the queue",
    async (token) => {
      const { ctx, json, error } = makeShareCtx(`?consume=${token}`);
      await expect(handleMiscRoutes(ctx)).resolves.toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        "consume must be a boolean",
        400,
      );
      expect(json).not.toHaveBeenCalled();
      expect(ctx.state.shareIngestQueue).toHaveLength(1);
    },
  );
});
