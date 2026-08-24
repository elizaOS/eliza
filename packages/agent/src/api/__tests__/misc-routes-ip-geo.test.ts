/**
 * Unit tests for misc control API routes: IP geolocation resolution and share-sheet ingestion queue.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMiscRoutes,
  type MiscRouteContext,
  resetIpGeoCacheForTests,
} from "../misc-routes.ts";

function createMockContext(overrides: Partial<MiscRouteContext>): {
  ctx: MiscRouteContext;
  jsonCalls: Array<{ data: unknown; status?: number }>;
  errorCalls: Array<{ message: string; status?: number }>;
} {
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
  const errorCalls: Array<{ message: string; status?: number }> = [];

  const ctx: MiscRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/location/approximate",
    url: new URL("http://localhost/api/location/approximate"),
    state: {
      config: {},
      runtime: null,
      agentState: "running",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs: vi.fn(),
      broadcastWsToClientId: vi.fn(),
      nextEventId: 1,
      eventBuffer: [],
      shareIngestQueue: [],
      startup: { phase: "ready", attempt: 1 },
      broadcastStatus: vi.fn(),
      pendingRestartReasons: [],
    },
    json: (_res, data, status) => {
      jsonCalls.push({ data, status });
    },
    error: (_res, message, status) => {
      errorCalls.push({ message, status });
    },
    readJsonBody: vi.fn(),
    AGENT_EVENT_ALLOWED_STREAMS: new Set(["system", "chat"]),
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue("client-1"),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
    ...overrides,
  };

  return { ctx, jsonCalls, errorCalls };
}

describe("misc-routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetIpGeoCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetIpGeoCacheForTests();
    vi.restoreAllMocks();
  });

  describe("GET /api/location/approximate", () => {
    it("resolves coordinates from IP geo provider and caches result", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ latitude: 37.7749, longitude: -122.4194 }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const { ctx, jsonCalls } = createMockContext({
        method: "GET",
        pathname: "/api/location/approximate",
      });

      const handled = await handleMiscRoutes(ctx);
      expect(handled).toBe(true);
      expect(jsonCalls).toHaveLength(1);
      expect(jsonCalls[0]?.data).toEqual({
        lat: 37.7749,
        lon: -122.4194,
        accuracyMeters: 5000,
        source: "ipapi.co",
      });

      // Second call within TTL returns cached result without refetching
      const { ctx: ctx2, jsonCalls: jsonCalls2 } = createMockContext({
        method: "GET",
        pathname: "/api/location/approximate",
      });
      await handleMiscRoutes(ctx2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(jsonCalls2[0]?.data).toEqual(jsonCalls[0]?.data);
    });

    it("returns 502 when all IP geo providers fail", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const { ctx, errorCalls } = createMockContext({
        method: "GET",
        pathname: "/api/location/approximate",
      });

      const handled = await handleMiscRoutes(ctx);
      expect(handled).toBe(true);
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]?.status).toBe(502);
    });
  });

  describe("share ingest queue", () => {
    it("queues incoming share payloads on POST /api/ingest/share", async () => {
      const { ctx, jsonCalls } = createMockContext({
        method: "POST",
        pathname: "/api/ingest/share",
        readJsonBody: vi.fn().mockResolvedValue({
          title: "Interesting Article",
          url: "https://example.com/article",
        }),
      });

      const handled = await handleMiscRoutes(ctx);
      expect(handled).toBe(true);
      expect(jsonCalls).toHaveLength(1);
      expect(ctx.state.shareIngestQueue).toHaveLength(1);
      expect(ctx.state.shareIngestQueue[0]?.title).toBe("Interesting Article");
      expect(ctx.state.shareIngestQueue[0]?.suggestedPrompt).toBe(
        'What do you think about "Interesting Article"?',
      );
    });

    it("consumes items and empties queue when consume=true", async () => {
      const initialItem = {
        id: "123",
        source: "share-sheet",
        title: "Doc",
        url: "https://example.com",
        suggestedPrompt: "Analyze this",
        receivedAt: 1000,
      };

      const { ctx, jsonCalls } = createMockContext({
        method: "GET",
        pathname: "/api/ingest/share",
        url: new URL("http://localhost/api/ingest/share?consume=true"),
      });
      ctx.state.shareIngestQueue.push(initialItem);

      const handled = await handleMiscRoutes(ctx);
      expect(handled).toBe(true);
      expect(jsonCalls[0]?.data).toEqual({ items: [initialItem] });
      expect(ctx.state.shareIngestQueue).toHaveLength(0);
    });

    it("rejects non-boolean consume parameter with 400", async () => {
      const { ctx, errorCalls } = createMockContext({
        method: "GET",
        pathname: "/api/ingest/share",
        url: new URL("http://localhost/api/ingest/share?consume=invalid-bool"),
      });

      const handled = await handleMiscRoutes(ctx);
      expect(handled).toBe(true);
      expect(errorCalls[0]?.status).toBe(400);
    });
  });
});
