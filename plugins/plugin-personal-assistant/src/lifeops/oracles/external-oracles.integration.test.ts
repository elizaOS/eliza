/**
 * Real loopback HTTP contract tests for weather, route, and activity oracles,
 * plus deterministic household curation and coverage semantics.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { TravelTimeService } from "../../travel-time/service.js";
import type {
  LocalActivity,
  OracleAdapter,
  OracleQuery,
  RouteCell,
} from "./contracts.js";
import {
  type ActivityCurationCandidate,
  type ActivityCurationContext,
  computeChildcareCoverageGaps,
  curateLocalActivities,
} from "./curation.js";
import { createDefaultOraclePack } from "./defaults.js";
import {
  GOOGLE_ROUTES_FIELD_MASK,
  GoogleRoutesMatrixAdapter,
} from "./google-routes.js";
import { requestBoundedJson } from "./http.js";
import { NwsForecastAdapter } from "./nws.js";
import {
  ExternalOracleRegistry,
  LocalActivityAdapterRegistry,
} from "./registry.js";
import { TicketmasterDiscoveryAdapter } from "./ticketmaster.js";

type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("NWS point forecast adapter", () => {
  it("discovers fixed-origin forecast products with identifying headers", async () => {
    const requests: Array<{ path: string; userAgent: string | undefined }> = [];
    let origin = "";
    const endpoint = await startServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        userAgent: headerValue(request.headers["user-agent"]),
      });
      if (request.url?.startsWith("/points/")) {
        return json(response, {
          properties: {
            forecast: `${origin}/gridpoints/TST/1,2/forecast`,
            forecastHourly: `${origin}/gridpoints/TST/1,2/forecast/hourly`,
            timeZone: "America/Los_Angeles",
            forecastOffice: `${origin}/offices/TST`,
          },
        });
      }
      return json(
        response,
        forecastDocument(request.url?.endsWith("/hourly") ? "Hourly" : "Day"),
        200,
        { "Cache-Control": "max-age=120" },
      );
    });
    origin = endpoint;

    const adapter = new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "oracle-test (test@example.com)",
    });
    const snapshot = await adapter.forecast(
      {
        kind: "weather",
        latitude: 34.0522,
        longitude: -118.2437,
        includeHourly: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(snapshot.health).toBe("complete");
    expect(snapshot.value.coverage).toBe("US_ONLY");
    expect(snapshot.value.periods[0]?.name).toBe("Day");
    expect(snapshot.value.hourlyPeriods?.[0]?.name).toBe("Hourly");
    expect(snapshot.freshness.freshUntil).toBe("2026-07-26T12:02:00.000Z");
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.userAgent?.includes("@"))).toBe(
      true,
    );
  });

  it("rejects off-origin discovery continuations and redirects", async () => {
    let origin = "";
    let mode: "pivot" | "redirect" = "pivot";
    const endpoint = await startServer((request, response) => {
      if (request.url?.startsWith("/points/")) {
        return json(response, {
          properties: {
            forecast:
              mode === "pivot"
                ? "http://127.0.0.1:9/gridpoints/TST/1,2/forecast"
                : `${origin}/gridpoints/TST/1,2/forecast`,
            forecastHourly: `${origin}/gridpoints/TST/1,2/forecast/hourly`,
            timeZone: "America/Los_Angeles",
            forecastOffice: `${origin}/offices/TST`,
          },
        });
      }
      response.writeHead(302, { Location: "http://127.0.0.1:9/private" });
      response.end();
    });
    origin = endpoint;
    const adapter = new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "oracle-test (test@example.com)",
    });

    await expect(
      adapter.forecast({
        kind: "weather",
        latitude: 34,
        longitude: -118,
        includeHourly: false,
      }),
    ).rejects.toMatchObject({ code: "ORACLE_CONTINUATION_REJECTED" });

    mode = "redirect";
    await expect(
      adapter.forecast({
        kind: "weather",
        latitude: 34,
        longitude: -118,
        includeHourly: false,
      }),
    ).rejects.toMatchObject({ code: "ORACLE_HTTP_REDIRECT" });
  });

  it("surfaces timeout and invalid JSON instead of empty forecasts", async () => {
    let origin = "";
    let mode: "timeout" | "invalid-json" = "timeout";
    const endpoint = await startServer(async (request, response) => {
      if (request.url?.startsWith("/points/")) {
        if (mode === "timeout") {
          await delay(50);
        }
        return json(response, {
          properties: {
            forecast: `${origin}/gridpoints/TST/1,2/forecast`,
            forecastHourly: `${origin}/gridpoints/TST/1,2/forecast/hourly`,
            timeZone: "America/Los_Angeles",
            forecastOffice: `${origin}/offices/TST`,
          },
        });
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{not-json");
    });
    origin = endpoint;
    const adapter = new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "oracle-test (test@example.com)",
      timeoutMs: 20,
    });
    const query = {
      kind: "weather" as const,
      latitude: 34,
      longitude: -118,
      includeHourly: false,
    };

    await expect(adapter.forecast(query)).rejects.toMatchObject({
      code: "ORACLE_HTTP_TIMEOUT",
    });
    mode = "invalid-json";
    const invalidJsonAdapter = new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "oracle-test (test@example.com)",
      timeoutMs: 500,
    });
    await expect(invalidJsonAdapter.forecast(query)).rejects.toMatchObject({
      code: "ORACLE_HTTP_INVALID_JSON",
    });
  });

  it("keeps the period product as explicit partial when hourly fails", async () => {
    let origin = "";
    const endpoint = await startServer((request, response) => {
      if (request.url?.startsWith("/points/")) {
        return json(response, {
          properties: {
            forecast: `${origin}/gridpoints/TST/1,2/forecast`,
            forecastHourly: `${origin}/gridpoints/TST/1,2/forecast/hourly`,
            timeZone: "America/Los_Angeles",
            forecastOffice: `${origin}/offices/TST`,
          },
        });
      }
      if (request.url?.endsWith("/hourly")) {
        return json(response, { error: "outage" }, 503);
      }
      return json(response, forecastDocument("Day"));
    });
    origin = endpoint;

    const snapshot = await new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "oracle-test (test@example.com)",
    }).forecast({
      kind: "weather",
      latitude: 34,
      longitude: -118,
      includeHourly: true,
    });

    expect(snapshot.health).toBe("partial");
    expect(snapshot.value.periods).toHaveLength(1);
    expect(snapshot.value.hourlyPeriods).toBeNull();
    expect(snapshot.issues.map((issue) => issue.code)).toContain(
      "NWS_HOURLY_UNAVAILABLE",
    );
  });
});

describe("bounded HTTP oracle transport", () => {
  it("times out and closes a real response that stalls after its headers", async () => {
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const endpoint = await startServer((_request, response) => {
      response.once("close", () => resolveClosed?.());
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      response.flushHeaders();
      response.write('{"partial":');
    });

    await expect(
      requestBoundedJson({
        url: new URL(endpoint),
        safeResource: "loopback/stalled-body",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "ORACLE_HTTP_TIMEOUT" });

    await Promise.race([
      closed,
      delay(500).then(() => {
        throw new Error("Timed-out oracle response remained connected.");
      }),
    ]);
  });
});

describe("Google Routes v2 matrix adapter", () => {
  it("reorders cells by indices and preserves per-cell provider errors", async () => {
    const secret = "routes-secret-contract-value";
    const endpoint = await startServer(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(headerValue(request.headers["x-goog-api-key"])).toBe(secret);
      expect(headerValue(request.headers["x-goog-fieldmask"])).toBe(
        GOOGLE_ROUTES_FIELD_MASK,
      );
      expect(request.url).not.toContain(secret);
      const requestBody = JSON.parse(await readBody(request));
      expect(requestBody.origins).toHaveLength(2);
      return json(response, [
        routeElement(1, 1, "400.5s", 4_000),
        routeElement(0, 0, "100s", 1_000),
        {
          originIndex: 0,
          destinationIndex: 1,
          status: {},
          condition: "ROUTE_NOT_FOUND",
        },
        {
          originIndex: 1,
          destinationIndex: 0,
          status: { code: 5, message: "not found" },
          condition: "ROUTE_NOT_FOUND",
        },
      ]);
    });
    const adapter = new GoogleRoutesMatrixAdapter({
      apiKeyResolver: () => secret,
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
    });
    const snapshot = await adapter.compute({
      kind: "route-matrix",
      origins: [
        { kind: "coordinates", latitude: 34, longitude: -118 },
        { kind: "place", placeId: "ChIJ-valid_2" },
      ],
      destinations: [
        { kind: "address", address: "100 Main St" },
        { kind: "coordinates", latitude: 35, longitude: -117 },
      ],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    });

    expect(snapshot.health).toBe("partial");
    expect(
      snapshot.value.cells.map((cell) => [
        cell.originIndex,
        cell.destinationIndex,
      ]),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(snapshot.value.cells[0]).toMatchObject({
      status: "known",
      durationSeconds: 100,
    });
    expect(snapshot.value.cells[1]).toMatchObject({
      status: "unknown",
      reason: "route-not-found",
      providerCode: 0,
    });
    expect(snapshot.value.cells[2]).toMatchObject({
      status: "unknown",
      reason: "provider-error",
      providerCode: 5,
    });
    expect(snapshot.value.cells[3]).toMatchObject({
      status: "known",
      durationSeconds: 400.5,
    });
  });

  it("enforces normal, transit, optimal, and textual waypoint limits", async () => {
    const adapter = new GoogleRoutesMatrixAdapter({
      apiKeyResolver: () => "unused",
      endpointOverride: "http://127.0.0.1:1",
      allowInsecureLoopbackForTests: true,
    });
    const points = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        kind: "coordinates" as const,
        latitude: index / 100,
        longitude: index / 100,
      }));

    await expect(
      adapter.compute({
        kind: "route-matrix",
        origins: points(26),
        destinations: points(25),
        travelMode: "DRIVE",
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_ROUTES_ELEMENT_LIMIT" });
    await expect(
      adapter.compute({
        kind: "route-matrix",
        origins: points(11),
        destinations: points(10),
        travelMode: "TRANSIT",
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_ROUTES_ELEMENT_LIMIT" });
    await expect(
      adapter.compute({
        kind: "route-matrix",
        origins: points(11),
        destinations: points(10),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_ROUTES_ELEMENT_LIMIT" });
    await expect(
      adapter.compute({
        kind: "route-matrix",
        origins: Array.from({ length: 49 }, (_, index) => ({
          kind: "address" as const,
          address: `${index} Main St`,
        })),
        destinations: Array.from({ length: 2 }, (_, index) => ({
          kind: "place" as const,
          placeId: `place_${index}`,
        })),
        travelMode: "DRIVE",
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_ROUTES_TEXT_WAYPOINT_LIMIT" });
  });

  it("never includes the API key in the URL or surfaced error chain", async () => {
    const secret = "routes-super-secret-value";
    let observedUrl = "";
    const endpoint = await startServer((request, response) => {
      observedUrl = request.url ?? "";
      return json(response, { error: "provider failed" }, 503);
    });
    const adapter = new GoogleRoutesMatrixAdapter({
      apiKeyResolver: () => secret,
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
    });

    let caught: unknown;
    try {
      await adapter.compute({
        kind: "route-matrix",
        origins: [{ kind: "address", address: "Origin" }],
        destinations: [{ kind: "address", address: "Destination" }],
        travelMode: "DRIVE",
      });
    } catch (error) {
      // error-policy:J1 The test boundary captures the public error artifact
      // solely to prove that the credential does not appear anywhere in it.
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElizaError);
    expect(observedUrl).not.toContain(secret);
    expect(renderError(caught)).not.toContain(secret);
  });

  it("keeps the calendar travel-buffer surface on the v2 HTTP contract", async () => {
    const endpoint = await startServer((_request, response) =>
      json(response, [routeElement(0, 0, "601s", 8_000)]),
    );
    const routes = new GoogleRoutesMatrixAdapter({
      apiKeyResolver: () => "route-key",
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
    });
    const service = new TravelTimeService(
      { getSetting: () => "route-key" },
      {
        calendar: {
          async getCalendarFeed() {
            throw new ElizaError("Calendar lookup is not used by this path.", {
              code: "TEST_PATH_NOT_USED",
            });
          },
        },
        routesAdapter: routes,
      },
    );

    await expect(
      service.computeBufferForEvent(
        { location: "100 Destination Ave" },
        "200 Origin Blvd",
      ),
    ).resolves.toEqual({
      bufferMinutes: 11,
      method: "maps-api",
      originAddress: "200 Origin Blvd",
      destinationAddress: "100 Destination Ave",
    });
  });
});

describe("Ticketmaster local-activity adapter", () => {
  it("pages, deduplicates, preserves status, and keeps authority unknown", async () => {
    const secret = "ticketmaster-secret-contract-value";
    const requestedPages: number[] = [];
    const endpoint = await startServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://loopback");
      expect(url.searchParams.get("apikey")).toBe(secret);
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const events =
        page === 0
          ? [
              ticketmasterEvent("event-1", "onsale"),
              ticketmasterEvent("event-2", "offsale"),
            ]
          : [
              ticketmasterEvent("event-1", "onsale"),
              ticketmasterEvent("event-3", "canceled"),
            ];
      return json(response, {
        _embedded: { events },
        page: {
          number: page,
          size: 2,
          totalPages: 2,
          totalElements: 4,
        },
      });
    });
    const adapter = new TicketmasterDiscoveryAdapter({
      apiKeyResolver: () => secret,
      endpointOverride: `${endpoint}/discovery/v2/`,
      allowInsecureLoopbackForTests: true,
      requestIntervalMs: 0,
    });
    const snapshot = await adapter.discover({
      kind: "local-activity",
      location: {
        kind: "postal-code",
        postalCode: "90012",
        countryCode: "US",
      },
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-15T00:00:00.000Z",
      keywords: ["summer camp"],
      pageSize: 2,
      maxPages: 2,
    });

    expect(requestedPages).toEqual([0, 1]);
    expect(snapshot.health).toBe("partial");
    expect(snapshot.value.activities).toHaveLength(3);
    expect(
      snapshot.value.activities.map((activity) => activity.sourceStatus),
    ).toEqual(["onsale", "offsale", "canceled"]);
    expect(snapshot.value.activities[0]).toMatchObject({
      startAt: "2026-08-05T17:00:00.000Z",
      endAt: "2026-08-05T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      venue: {
        name: "Community Venue",
        address: "100 Main St, Los Angeles, CA, 90012",
        latitude: 34.05,
        longitude: -118.24,
      },
      registrationUrl: "https://www.ticketmaster.com/event/event-1",
      provenance: {
        provider: "Ticketmaster Discovery API v2",
        contentTrust: "untrusted-source-data",
      },
    });
    for (const activity of snapshot.value.activities) {
      expect(activity.eligibility.state).toBe("unknown");
      expect(activity.capacity.state).toBe("unknown");
      expect(activity.purchase.state).toBe("unknown");
      expect(activity.childcareCoverage).toBe("not-counted");
    }
    expect(snapshot.issues.map((issue) => issue.code)).toContain(
      "TICKETMASTER_DUPLICATE_EVENT",
    );
  });

  it("redacts the query credential from surfaced provider failures", async () => {
    const secret = "ticketmaster-super-secret-value";
    const endpoint = await startServer((_request, response) =>
      json(response, { error: "unavailable" }, 503),
    );
    const adapter = new TicketmasterDiscoveryAdapter({
      apiKeyResolver: () => secret,
      endpointOverride: `${endpoint}/discovery/v2/`,
      allowInsecureLoopbackForTests: true,
      requestIntervalMs: 0,
    });
    let caught: unknown;
    try {
      await adapter.discover({
        kind: "local-activity",
        location: {
          kind: "postal-code",
          postalCode: "90012",
          countryCode: "US",
        },
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: "2026-08-15T00:00:00.000Z",
        keywords: [],
      });
    } catch (error) {
      // error-policy:J1 The test boundary captures the public error artifact
      // solely to prove that the query credential is fully redacted.
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElizaError);
    expect(renderError(caught)).not.toContain(secret);
  });

  it("fans out future activity sources without hiding an unavailable peer", async () => {
    const endpoint = await startServer((_request, response) =>
      json(response, {
        page: { number: 0, size: 20, totalPages: 0, totalElements: 0 },
      }),
    );
    const registry = new LocalActivityAdapterRegistry();
    registry.register(
      "ticketmaster",
      new TicketmasterDiscoveryAdapter({
        apiKeyResolver: () => "registry-key",
        endpointOverride: `${endpoint}/discovery/v2/`,
        allowInsecureLoopbackForTests: true,
        requestIntervalMs: 0,
      }),
    );
    registry.register("future-sis", {
      provider: "Future SIS contract",
      async discover() {
        throw new ElizaError("SIS unavailable", {
          code: "SIS_UNAVAILABLE",
        });
      },
    });
    const observations = await registry.discoverAll({
      kind: "local-activity",
      location: {
        kind: "postal-code",
        postalCode: "90012",
        countryCode: "US",
      },
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-15T00:00:00.000Z",
      keywords: [],
    });

    expect(observations.map((observation) => observation.source)).toEqual([
      "ticketmaster",
      "future-sis",
    ]);
    expect(observations[0]?.snapshot).toMatchObject({
      health: "complete",
      value: { activities: [] },
    });
    expect(observations[1]?.snapshot).toMatchObject({
      health: "unavailable",
      value: null,
      issues: [{ code: "SIS_UNAVAILABLE" }],
    });
  });
});

describe("activity curation and scenario semantics", () => {
  it("checks eligibility, access, conflicts, travel, custody, load, and headcount", () => {
    const selected = activity("selected", {
      eligibility: { state: "known", value: "eligible" },
      accessibility: { state: "known", value: "supported" },
      capacity: { state: "known", value: "available" },
    });
    const protectedActivity = activity("protected", {
      startAt: "2026-08-01T20:30:00.000Z",
      endAt: "2026-08-01T21:30:00.000Z",
      eligibility: { state: "known", value: "eligible" },
      accessibility: { state: "known", value: "supported" },
      capacity: { state: "known", value: "available" },
    });
    const unknown = activity("unknown");
    const candidates = [
      candidate(selected),
      candidate(protectedActivity),
      candidate(unknown),
    ];
    const result = curateLocalActivities(candidates, curationContext());

    expect(result.selectedSourceEventIds).toEqual(["selected"]);
    expect(
      result.decisions.find(
        (decision) => decision.sourceEventId === "protected",
      ),
    ).toMatchObject({
      status: "excluded",
      reasons: ["protected-unstructured-time"],
      childcareCoverage: "not-counted",
    });
    const unknownDecision = result.decisions.find(
      (decision) => decision.sourceEventId === "unknown",
    );
    expect(unknownDecision?.status).toBe("needs-verification");
    expect(unknownDecision?.verificationQuestions).toEqual(
      expect.arrayContaining([
        "Verify capacity for source event unknown.",
        "Verify provider eligibility for source event unknown.",
      ]),
    );
  });

  it("G31 never counts a waitlist as childcare coverage", () => {
    const gaps = computeChildcareCoverageGaps(
      [
        {
          startAt: "2026-08-03T16:00:00.000Z",
          endAt: "2026-08-03T22:00:00.000Z",
        },
      ],
      [
        {
          state: "confirmed",
          startAt: "2026-08-03T16:00:00.000Z",
          endAt: "2026-08-03T18:00:00.000Z",
        },
        {
          state: "waitlisted",
          startAt: "2026-08-03T18:00:00.000Z",
          endAt: "2026-08-03T22:00:00.000Z",
        },
      ],
    );
    expect(gaps).toEqual([
      {
        startAt: "2026-08-03T18:00:00.000Z",
        endAt: "2026-08-03T22:00:00.000Z",
      },
    ]);
  });

  it("G32 treats protected unstructured time as capacity, not an optimization gap", () => {
    const candidateInsideProtectedTime = candidate(
      activity("family-capacity", {
        startAt: "2026-08-01T20:30:00.000Z",
        endAt: "2026-08-01T21:30:00.000Z",
        eligibility: { state: "known", value: "eligible" },
        accessibility: { state: "known", value: "supported" },
        capacity: { state: "known", value: "available" },
      }),
    );
    const result = curateLocalActivities(
      [candidateInsideProtectedTime],
      curationContext(),
    );
    expect(result.selectedSourceEventIds).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      status: "excluded",
      reasons: ["protected-unstructured-time"],
    });
  });
});

describe("oracle registry failure semantics", () => {
  it("assembles the production source pack through runtime secret resolution", () => {
    const pack = createDefaultOraclePack({
      getSetting: (key) =>
        key === "GOOGLE_MAPS_API_KEY" || key === "TICKETMASTER_API_KEY"
          ? "runtime-secret"
          : undefined,
    });
    expect(pack.external.get("weather")?.provider).toBe("weather.gov");
    expect(pack.external.get("route-matrix")?.provider).toBe(
      "Google Routes API v2",
    );
    expect(pack.external.get("local-activity")?.provider).toBe(
      "Ticketmaster Discovery API v2",
    );
    expect(pack.localActivities.list()).toEqual(["ticketmaster"]);
  });

  it("represents provider failure as unavailable with no payload", async () => {
    const failing: OracleAdapter = {
      kind: "weather",
      provider: "contract-source",
      async observe(_query: OracleQuery) {
        throw new ElizaError("source failed", {
          code: "CONTRACT_SOURCE_FAILED",
        });
      },
    };
    const registry = new ExternalOracleRegistry();
    registry.register(failing);
    const snapshot = await registry.observe({
      kind: "weather",
      latitude: 34,
      longitude: -118,
      includeHourly: false,
    });
    expect(snapshot.health).toBe("unavailable");
    expect(snapshot.value).toBeNull();
    expect(snapshot.issues).toEqual([
      {
        code: "CONTRACT_SOURCE_FAILED",
        message: "The external source is unavailable.",
        scope: "weather",
      },
    ]);
  });
});

async function startServer(handler: HttpHandler): Promise<string> {
  const server = createServer((request, response) => {
    // error-policy:J1 The loopback transport boundary converts a rejected test
    // handler into an observable HTTP failure for the real client path.
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "handler failure",
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback test server did not expose a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function json(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function forecastDocument(name: string): object {
  return {
    properties: {
      updateTime: "2026-07-26T11:55:00.000Z",
      periods: [
        {
          number: 1,
          name,
          startTime: "2026-07-26T12:00:00.000Z",
          endTime: "2026-07-26T13:00:00.000Z",
          isDaytime: true,
          temperature: 72,
          temperatureUnit: "F",
          probabilityOfPrecipitation: { value: 20 },
          windSpeed: "5 mph",
          windDirection: "W",
          shortForecast: "Clear",
          detailedForecast: "Clear during the observation window.",
        },
      ],
    },
  };
}

function routeElement(
  originIndex: number,
  destinationIndex: number,
  duration: string,
  distanceMeters: number,
): object {
  return {
    originIndex,
    destinationIndex,
    status: {},
    condition: "ROUTE_EXISTS",
    duration,
    distanceMeters,
  };
}

function ticketmasterEvent(
  id: string,
  status: "onsale" | "offsale" | "canceled",
): object {
  return {
    id,
    name: `Source event ${id}`,
    url: `https://www.ticketmaster.com/event/${id}`,
    dates: {
      start: { dateTime: "2026-08-05T17:00:00.000Z" },
      end: { dateTime: "2026-08-05T19:00:00.000Z" },
      timezone: "America/Los_Angeles",
      status: { code: status },
    },
    _embedded: {
      venues: [
        {
          name: "Community Venue",
          address: { line1: "100 Main St" },
          city: { name: "Los Angeles" },
          state: { stateCode: "CA" },
          postalCode: "90012",
          location: { latitude: "34.05", longitude: "-118.24" },
        },
      ],
    },
  };
}

function activity(
  id: string,
  overrides: Partial<LocalActivity> = {},
): LocalActivity {
  return {
    source: "contract",
    sourceEventId: id,
    title: `Activity ${id}`,
    startAt: "2026-08-01T17:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    timeZone: "America/Los_Angeles",
    venue: {
      name: "Venue",
      address: "100 Main St",
      latitude: 34,
      longitude: -118,
    },
    registrationUrl: `https://example.test/${id}`,
    sourceStatus: "onsale",
    eligibility: { state: "unknown" },
    accessibility: { state: "unknown" },
    capacity: { state: "unknown" },
    purchase: { state: "unknown" },
    childcareCoverage: "not-counted",
    provenance: {
      provider: "contract",
      resource: id,
      retrievedAt: "2026-07-26T12:00:00.000Z",
      coverage: "contract fixture",
      contentTrust: "untrusted-source-data",
    },
    ...overrides,
  };
}

function candidate(
  source: LocalActivity,
  overrides: Partial<ActivityCurationCandidate> = {},
): ActivityCurationCandidate {
  return {
    activity: source,
    intendedChildIds: ["child-1"],
    caregiverParticipantIds: ["caregiver-1"],
    eligibleAgeRange: { minimum: 6, maximum: 12 },
    requiredCaregiverHeadcount: 1,
    ...overrides,
  };
}

function knownRoute(): RouteCell {
  return {
    status: "known",
    originIndex: 0,
    destinationIndex: 0,
    durationSeconds: 600,
    distanceMeters: 5_000,
    condition: "ROUTE_EXISTS",
  };
}

function curationContext(): ActivityCurationContext {
  return {
    children: [
      {
        childId: "child-1",
        ageYears: 8,
        accessibilityNeeds: ["step-free"],
        scheduledLoad: 1,
        maxScheduledLoad: 3,
      },
    ],
    custodyWindows: [
      {
        childId: "child-1",
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: "2026-08-02T00:00:00.000Z",
      },
    ],
    custodyHealth: "complete",
    busyWindows: [],
    protectedUnstructuredWindows: [
      {
        windowId: "family-saturday",
        childIds: ["child-1"],
        startAt: "2026-08-01T20:00:00.000Z",
        endAt: "2026-08-01T23:00:00.000Z",
      },
    ],
    travelFacts: ["selected", "protected", "unknown", "family-capacity"].map(
      (sourceEventId) => ({
        sourceEventId,
        outbound: knownRoute(),
        inbound: knownRoute(),
      }),
    ),
    availableCaregiverHeadcount: 1,
    maxSuggestions: 1,
  };
}

function renderError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause =
    "cause" in error && error.cause !== undefined ? String(error.cause) : "";
  return `${error.name}:${error.message}:${cause}:${JSON.stringify(error)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
