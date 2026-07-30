/**
 * Reachability proof for the LOCAL_CONDITIONS conversational action: plugin
 * registration, owner authorization, and the action -> registry -> adapter ->
 * real loopback HTTP chain for weather and activity sources, plus the
 * deterministic curation and childcare coverage-gap consumers. Provider wire
 * contracts themselves are covered by external-oracles.integration.test.ts.
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  type ActionResult,
  type AgentRuntime,
  createMessageMemory,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { personalAssistantPlugin } from "../../plugin.js";
import {
  createLocalConditionsAction,
  LOCAL_CONDITIONS_ACTION,
} from "./action.js";
import type {
  LocalActivityOraclePayload,
  OracleSnapshot,
  WeatherOraclePayload,
} from "./contracts.js";
import type { ActivityCurationDecision, TimeWindow } from "./curation.js";
import { NwsForecastAdapter } from "./nws.js";
import {
  ExternalOracleRegistry,
  LocalActivityAdapterRegistry,
  type LocalActivitySourceObservation,
  registerExternalOracleRegistry,
  registerLocalActivityAdapterRegistry,
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
  body: object,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
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

async function startNwsServer(): Promise<string> {
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
    return json(
      response,
      forecastDocument(request.url?.endsWith("/hourly") ? "Hourly" : "Day"),
      200,
      { "Cache-Control": "max-age=120" },
    );
  });
  origin = endpoint;
  return endpoint;
}

async function startTicketmasterServer(): Promise<string> {
  return startServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback");
    const page = Number(url.searchParams.get("page"));
    const events =
      page === 0
        ? [
            ticketmasterEvent("event-1", "onsale"),
            ticketmasterEvent("event-2", "offsale"),
          ]
        : [];
    return json(response, {
      _embedded: { events },
      page: { number: page, size: 2, totalPages: 1, totalElements: 2 },
    });
  });
}

function loopbackWeatherRegistry(endpoint: string): ExternalOracleRegistry {
  const registry = new ExternalOracleRegistry();
  registry.register(
    new NwsForecastAdapter({
      endpointOverride: endpoint,
      allowInsecureLoopbackForTests: true,
      userAgent: "local-conditions-action-test (test@example.com)",
    }),
  );
  return registry;
}

function loopbackActivityRegistry(
  endpoint: string,
): LocalActivityAdapterRegistry {
  const registry = new LocalActivityAdapterRegistry();
  registry.register(
    "ticketmaster",
    new TicketmasterDiscoveryAdapter({
      apiKeyResolver: () => "local-conditions-action-secret",
      endpointOverride: `${endpoint}/discovery/v2/`,
      allowInsecureLoopbackForTests: true,
      requestIntervalMs: 0,
    }),
  );
  return registry;
}

describe("LOCAL_CONDITIONS action — registry-backed production wiring", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const action = createLocalConditionsAction({ authorize: async () => true });

  function ownerMessage(): Memory {
    return createMessageMemory({
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: randomUUID() as UUID,
      content: {
        text: "What are our options this weekend?",
        source: "client_chat",
      },
    });
  }

  async function run(
    subaction: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const result = await action.handler?.(
      runtime,
      ownerMessage(),
      undefined,
      { parameters: { action: subaction, subaction, ...params } },
      undefined,
    );
    if (!result || typeof result === "boolean") {
      throw new Error("local-conditions action returned no ActionResult");
    }
    return result;
  }

  function discoveryParams(): Record<string, unknown> {
    return {
      location: { postalCode: "90012", countryCode: "US" },
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-15T00:00:00.000Z",
      keywords: ["kids"],
      pageSize: 2,
      maxPages: 1,
    };
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("registers the umbrella and its promoted virtuals in production composition", () => {
    const names = personalAssistantPlugin.actions?.map(
      (candidate) => candidate.name,
    );
    expect(names).toContain(LOCAL_CONDITIONS_ACTION);
    expect(names).toContain("LOCAL_CONDITIONS_WEATHER_OUTLOOK");
    expect(names).toContain("LOCAL_CONDITIONS_DISCOVER_ACTIVITIES");
    expect(names).toContain("LOCAL_CONDITIONS_CHILDCARE_COVERAGE_GAPS");
  });

  it("denies unauthenticated principals", async () => {
    const denied = createLocalConditionsAction({
      authorize: async () => false,
    });
    const result = await denied.handler?.(
      runtime,
      ownerMessage(),
      undefined,
      {
        parameters: {
          action: "weather_outlook",
          subaction: "weather_outlook",
          latitude: 34.05,
          longitude: -118.24,
        },
      },
      undefined,
    );
    if (!result || typeof result === "boolean") {
      throw new Error("denied action returned no ActionResult");
    }
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
  });

  it("rejects malformed planner input with a typed oracle error", async () => {
    await expect(
      run("weather_outlook", { latitude: 240, longitude: -118.24 }),
    ).rejects.toMatchObject({ code: "ORACLE_QUERY_INVALID" });
  });

  it("reads a typed point forecast through the registered weather registry", async () => {
    registerExternalOracleRegistry(
      runtime,
      loopbackWeatherRegistry(await startNwsServer()),
    );
    const result = await run("weather_outlook", {
      latitude: 34.05,
      longitude: -118.24,
    });
    expect(result.success).toBe(true);
    const snapshot = (
      result.data as { snapshot: OracleSnapshot<WeatherOraclePayload> }
    ).snapshot;
    expect(snapshot.health).toBe("complete");
    expect(snapshot.provenance.provider).toBe("weather.gov");
    expect(snapshot.provenance.contentTrust).toBe("untrusted-source-data");
    if (snapshot.health === "unavailable") throw new Error("unreachable");
    expect(snapshot.value.periods[0]?.shortForecast).toBe("Clear");
    expect(result.text).toContain("Clear");
  });

  it("reports a weather source outage as an explicit unavailable state, never an empty forecast", async () => {
    const endpoint = await startServer((_request, response) =>
      json(response, { error: "upstream failure" }, 500),
    );
    registerExternalOracleRegistry(runtime, loopbackWeatherRegistry(endpoint));
    const result = await run("weather_outlook", {
      latitude: 34.05,
      longitude: -118.24,
    });
    expect(result.success).toBe(false);
    const snapshot = (
      result.data as { snapshot: OracleSnapshot<WeatherOraclePayload> }
    ).snapshot;
    expect(snapshot.health).toBe("unavailable");
    expect(snapshot.value).toBeNull();
    expect(result.text).toContain("unavailable");
  });

  it("discovers activities across the registered source registry with per-source health", async () => {
    registerLocalActivityAdapterRegistry(
      runtime,
      loopbackActivityRegistry(await startTicketmasterServer()),
    );
    const result = await run("discover_activities", discoveryParams());
    expect(result.success).toBe(true);
    const observations = (
      result.data as { observations: LocalActivitySourceObservation[] }
    ).observations;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.source).toBe("ticketmaster");
    const snapshot = observations[0]
      ?.snapshot as OracleSnapshot<LocalActivityOraclePayload>;
    expect(snapshot.health).not.toBe("unavailable");
    if (snapshot.health === "unavailable") throw new Error("unreachable");
    expect(snapshot.value.activities).toHaveLength(2);
    expect(
      snapshot.value.activities.every(
        (activity) => activity.childcareCoverage === "not-counted",
      ),
    ).toBe(true);
  });

  it("reports a full activity-source outage as an outage, not an empty result", async () => {
    const endpoint = await startServer((_request, response) =>
      json(response, { error: "unavailable" }, 503),
    );
    registerLocalActivityAdapterRegistry(
      runtime,
      loopbackActivityRegistry(endpoint),
    );
    const result = await run("discover_activities", discoveryParams());
    expect(result.success).toBe(false);
    expect(result.text).toContain("source outage");
  });

  it("curates discovered activities fail-closed: unverified facts become questions, never selected coverage", async () => {
    registerLocalActivityAdapterRegistry(
      runtime,
      loopbackActivityRegistry(await startTicketmasterServer()),
    );
    const result = await run("curate_discovered_activities", {
      ...discoveryParams(),
      children: [
        {
          childId: "child-a",
          ageYears: 8,
          scheduledLoad: 0,
          maxScheduledLoad: 2,
        },
      ],
      custodyHealth: "partial",
      caregiverParticipantIds: ["caregiver-a"],
      maxSuggestions: 3,
    });
    expect(result.success).toBe(true);
    const curation = (
      result.data as {
        curation: {
          decisions: ActivityCurationDecision[];
          selectedSourceEventIds: string[];
          verificationQuestions: string[];
        };
      }
    ).curation;
    expect(curation.decisions).toHaveLength(2);
    // The offsale event is structurally excluded; the onsale one has unknown
    // capacity/eligibility/travel, which must stay a verification question.
    expect(curation.selectedSourceEventIds).toEqual([]);
    const onsale = curation.decisions.find(
      (decision) => decision.sourceEventId === "event-1",
    );
    expect(onsale?.status).toBe("needs-verification");
    const offsale = curation.decisions.find(
      (decision) => decision.sourceEventId === "event-2",
    );
    expect(offsale?.status).toBe("excluded");
    expect(offsale?.reasons).toContain("source-not-bookable");
    expect(curation.verificationQuestions.length).toBeGreaterThan(0);
    expect(result.text).toContain("verification question");
  });

  it("computes childcare coverage gaps counting confirmed slots only", async () => {
    const result = await run("childcare_coverage_gaps", {
      requiredWindows: [
        {
          startAt: "2026-08-03T09:00:00.000Z",
          endAt: "2026-08-03T17:00:00.000Z",
        },
      ],
      coverageSlots: [
        {
          startAt: "2026-08-03T09:00:00.000Z",
          endAt: "2026-08-03T12:00:00.000Z",
          state: "confirmed",
        },
        {
          startAt: "2026-08-03T12:00:00.000Z",
          endAt: "2026-08-03T17:00:00.000Z",
          state: "waitlisted",
        },
      ],
    });
    expect(result.success).toBe(true);
    const gaps = (result.data as { gaps: TimeWindow[] }).gaps;
    expect(gaps).toEqual([
      {
        startAt: "2026-08-03T12:00:00.000Z",
        endAt: "2026-08-03T17:00:00.000Z",
      },
    ]);
    expect(result.text).toContain("1 uncovered window");
  });
});
