/**
 * GET /api/location/approximate through handleMiscRoutes against a REAL local
 * HTTP geo-provider stub (injected via ELIZA_IP_GEO_SERVICES) — the route's
 * actual fetch/timeout/parse path runs unmocked; only the third-party endpoint
 * is swapped for a local server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMiscRoutes,
  type MiscRouteContext,
  resetIpGeoCacheForTests,
} from "./misc-routes";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers";

type GeoResponder = (res: http.ServerResponse) => void;

/** One-endpoint geo provider; each test swaps `respond` and counts hits. */
function startGeoStub(): Promise<{
  url: string;
  hits: () => number;
  setResponder: (fn: GeoResponder) => void;
  close: () => Promise<void>;
}> {
  let count = 0;
  let respond: GeoResponder = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ latitude: 40.71, longitude: -74.01 }));
  };
  const server = http.createServer((_req, res) => {
    count += 1;
    respond(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/json/`,
        hits: () => count,
        setResponder: (fn) => {
          respond = fn;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function makeLocationContext(): MiscRouteContext {
  const req = { url: "/api/location/approximate" } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  return {
    req,
    res,
    method: "GET",
    pathname: "/api/location/approximate",
    url: new URL("http://localhost/api/location/approximate"),
    state: {
      config: {} as MiscRouteContext["state"]["config"],
      runtime: null,
      agentState: "ready",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs: vi.fn(),
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
    readJsonBody: vi.fn(),
    AGENT_EVENT_ALLOWED_STREAMS,
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue(null),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
  };
}

describe("handleMiscRoutes GET /api/location/approximate", () => {
  const originalServices = process.env.ELIZA_IP_GEO_SERVICES;

  beforeEach(() => {
    resetIpGeoCacheForTests();
  });

  afterEach(() => {
    if (originalServices === undefined) {
      delete process.env.ELIZA_IP_GEO_SERVICES;
    } else {
      process.env.ELIZA_IP_GEO_SERVICES = originalServices;
    }
    resetIpGeoCacheForTests();
  });

  it("returns coarse coordinates from the provider (ipapi-style latitude/longitude keys)", async () => {
    const stub = await startGeoStub();
    process.env.ELIZA_IP_GEO_SERVICES = stub.url;
    try {
      const ctx = makeLocationContext();
      const handled = await handleMiscRoutes(ctx);

      expect(handled).toBe(true);
      expect(ctx.error).not.toHaveBeenCalled();
      expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
        lat: 40.71,
        lon: -74.01,
        accuracyMeters: 5000,
        source: "127.0.0.1",
      });
    } finally {
      await stub.close();
    }
  });

  it("falls through a failing provider to the next one (lat/lon keys)", async () => {
    const failing = await startGeoStub();
    failing.setResponder((res) => {
      res.writeHead(500);
      res.end();
    });
    const working = await startGeoStub();
    working.setResponder((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lat: 51.5, lon: -0.12 }));
    });
    process.env.ELIZA_IP_GEO_SERVICES = `${failing.url},${working.url}`;
    try {
      const ctx = makeLocationContext();
      await handleMiscRoutes(ctx);

      expect(ctx.error).not.toHaveBeenCalled();
      expect(ctx.json).toHaveBeenCalledWith(
        ctx.res,
        expect.objectContaining({ lat: 51.5, lon: -0.12 }),
      );
      expect(failing.hits()).toBe(1);
      expect(working.hits()).toBe(1);
    } finally {
      await failing.close();
      await working.close();
    }
  });

  it("responds 502 — never fabricated coordinates — when every provider fails", async () => {
    const broken = await startGeoStub();
    broken.setResponder((res) => {
      // Usable HTTP but no usable coordinates: parse-reject, not transport fail.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "rate limited" }));
    });
    process.env.ELIZA_IP_GEO_SERVICES = broken.url;
    try {
      const ctx = makeLocationContext();
      const handled = await handleMiscRoutes(ctx);

      expect(handled).toBe(true);
      expect(ctx.json).not.toHaveBeenCalled();
      expect(ctx.error).toHaveBeenCalledWith(
        ctx.res,
        "IP geolocation unavailable",
        502,
      );
    } finally {
      await broken.close();
    }
  });

  it("serves repeat requests from the cache without re-querying the provider", async () => {
    const stub = await startGeoStub();
    process.env.ELIZA_IP_GEO_SERVICES = stub.url;
    try {
      await handleMiscRoutes(makeLocationContext());
      const second = makeLocationContext();
      await handleMiscRoutes(second);

      expect(stub.hits()).toBe(1);
      expect(second.json).toHaveBeenCalledWith(
        second.res,
        expect.objectContaining({ lat: 40.71, lon: -74.01 }),
      );
    } finally {
      await stub.close();
    }
  });
});
