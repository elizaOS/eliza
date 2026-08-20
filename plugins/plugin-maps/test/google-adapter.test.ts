/**
 * Exercises the real GoogleMapsAdapter against a protocol-faithful fake of the
 * Google Places (New) and Routes APIs, plus the Cloud managed-gateway path
 * shape. Deterministic and network-free: the fake upstream is a real loopback
 * HTTP server and the adapter under test is never replaced or mocked.
 */

import {
  type ProviderContractObservation,
  type ProviderProtocolFixture,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MapsError } from "../src/errors.js";
import {
  GOOGLE_MAPS_ATTRIBUTION,
  GOOGLE_MAPS_PROVIDER_ID,
  GoogleMapsAdapter,
} from "../src/google.js";
import { MapsService } from "../src/service.js";

const googlePlace = {
  id: "gp-park-1",
  displayName: { text: "Golden Gate Park" },
  location: { latitude: 37.7694, longitude: -122.4862 },
  formattedAddress: "San Francisco, CA 94121, USA",
  types: ["park", "tourist_attraction"],
};

const normalizedPlace = {
  provider: GOOGLE_MAPS_PROVIDER_ID,
  providerPlaceId: "gp-park-1",
  name: "Golden Gate Park",
  coordinates: { latitude: 37.7694, longitude: -122.4862 },
  formattedAddress: "San Francisco, CA 94121, USA",
  categories: ["park", "tourist_attraction"],
};

const searchBody = { places: [googlePlace], nextPageToken: "page-2" };
const routeBody = {
  routes: [
    {
      distanceMeters: 1200,
      duration: "900s",
      polyline: { encodedPolyline: "poly-abc" },
      warnings: ["This route has tolls."],
    },
  ],
};

const SEARCH_PATH = "/v1/places:searchText";
const DETAIL_PATH = "/v1/places/gp-park-1";
const ROUTES_PATH = "/directions/v2:computeRoutes";

function directFixtures(): ProviderProtocolFixture[] {
  return [
    {
      id: "google-search",
      method: "POST",
      path: SEARCH_PATH,
      response: { status: 200, body: searchBody },
    },
    {
      id: "google-detail",
      method: "GET",
      path: DETAIL_PATH,
      response: { status: 200, body: googlePlace },
    },
    {
      id: "google-route",
      method: "POST",
      path: ROUTES_PATH,
      response: { status: 200, body: routeBody },
    },
  ];
}

function managedFixtures(): ProviderProtocolFixture[] {
  return directFixtures().map((fixture) => ({
    ...fixture,
    id: `managed-${fixture.id}`,
    path:
      fixture.path === ROUTES_PATH
        ? `/google-maps/routes${fixture.path}`
        : `/google-maps/places${fixture.path}`,
  }));
}

async function expectCode(
  operation: Promise<unknown>,
  code: MapsError["code"],
): Promise<MapsError> {
  try {
    await operation;
  } catch (error) {
    // error-policy:J1 The test assertion boundary verifies the typed failure
    // returned by the real adapter instead of allowing it to escape the case.
    expect(error).toBeInstanceOf(MapsError);
    expect((error as MapsError).code).toBe(code);
    return error as MapsError;
  }
  throw new Error(`Expected ${code}`);
}

function passed(
  scenario: ProviderContractObservation["scenario"],
  detail: string,
  extra: Partial<ProviderContractObservation> = {},
): ProviderContractObservation {
  return { scenario, status: "passed", detail, ...extra };
}

describe("GoogleMapsAdapter provider contract (api-key mode)", () => {
  let upstream: Awaited<ReturnType<typeof startFakeProvider>>;
  let adapter: GoogleMapsAdapter;

  const makeAdapter = (
    overrides: Partial<ConstructorParameters<typeof GoogleMapsAdapter>[0]> = {},
  ) =>
    new GoogleMapsAdapter({
      connectionId: upstream.createConnectionId(),
      credential: { mode: "api-key", apiKey: "google_test_api_key_secret" },
      placesEndpoint: upstream.url,
      routesEndpoint: upstream.url,
      timeoutMs: 2_000,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
      ...overrides,
    });

  beforeAll(async () => {
    upstream = await startFakeProvider({ fixtures: directFixtures() });
    adapter = makeAdapter();
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("executes every outbound read and pagination scenario", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "GoogleMapsAdapter",
      profile: "outbound-http",
      capabilities: ["http-read", "pagination"],
      scenarios: {
        success: async () => {
          const page = await adapter.searchPlaces({ query: "park" });
          expect(page.places[0]).toEqual(normalizedPlace);
          expect(page.nextCursor).toBe("page-2");
          return passed("success", "normalized Google place inspected");
        },
        "designed-empty": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "schema-drift",
            body: {},
          });
          const page = await adapter.searchPlaces({ query: "nowhere" });
          expect(page).toEqual({ places: [], nextCursor: null });
          return passed(
            "designed-empty",
            "empty proto3 search response stayed distinct from failure",
          );
        },
        "invalid-input": async () => {
          await expectCode(
            adapter.searchPlaces({ query: " " }),
            "MAPS_INVALID_INPUT",
          );
          await expectCode(adapter.getPlace(""), "MAPS_INVALID_INPUT");
          return passed("invalid-input", "blank inputs rejected before HTTP");
        },
        "pagination-cursors": async () => {
          const page = await adapter.searchPlaces({
            query: "park",
            cursor: "page-1",
            limit: 50,
          });
          expect(page.nextCursor).toBe("page-2");
          const sent = JSON.parse(upstream.requests.at(-1)?.body ?? "{}") as {
            pageToken?: string;
            pageSize?: number;
          };
          // The recorder redacts token-suffixed keys; presence proves the
          // cursor was forwarded in the request body.
          expect(sent.pageToken).toBeDefined();
          expect(sent.pageSize).toBe(20);
          return passed(
            "pagination-cursors",
            "pageToken forwarded and pageSize clamped to the Google maximum",
          );
        },
        "rate-limit-retry-metadata": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "status",
            status: 429,
            headers: { "retry-after": "2" },
            body: { error: { status: "RESOURCE_EXHAUSTED" } },
          });
          const error = await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_RATE_LIMITED",
          );
          expect(error.retryAfterMs).toBe(2_000);
          return passed(
            "rate-limit-retry-metadata",
            "Retry-After preserved as 2000ms",
          );
        },
        "malformed-json": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "malformed-json",
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_MALFORMED_RESPONSE",
          );
          return passed("malformed-json", "invalid Google JSON rejected");
        },
        "schema-drift": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "schema-drift",
            body: {
              places: [
                {
                  ...googlePlace,
                  location: { latitude: 200, longitude: -122.4862 },
                },
              ],
            },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_MALFORMED_RESPONSE",
          );
          return passed("schema-drift", "out-of-range coordinates rejected");
        },
        timeout: async () => {
          const timeoutAdapter = new GoogleMapsAdapter({
            connectionId: "conn_google_timeout_1234",
            credential: { mode: "api-key", apiKey: "k" },
            timeoutMs: 100,
            testTransport: {
              fetchImpl: vi.fn(
                async (_input, init) =>
                  await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                      "abort",
                      () => reject(init.signal?.reason),
                      { once: true },
                    );
                  }),
              ),
            },
          });
          await expectCode(
            timeoutAdapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_TIMEOUT",
          );
          return passed("timeout", "bounded abort surfaced as timeout");
        },
        "connection-reset": async () => {
          const resetUpstream = await startFakeProvider({
            fixtures: directFixtures(),
          });
          const resetAdapter = new GoogleMapsAdapter({
            connectionId: resetUpstream.createConnectionId(),
            credential: { mode: "api-key", apiKey: "k" },
            placesEndpoint: resetUpstream.url,
            routesEndpoint: resetUpstream.url,
            testTransport: { fetchImpl: globalThis.fetch },
            allowPrivateNetworkForTests: true,
          });
          await resetUpstream.resetConnections();
          await expectCode(
            resetAdapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_NETWORK",
          );
          return passed(
            "connection-reset",
            "closed upstream surfaced as network failure",
          );
        },
        "provider-4xx": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "status",
            status: 400,
            body: { error: { status: "INVALID_ARGUMENT" } },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_REJECTED",
          );
          return passed("provider-4xx", "Google rejection remained explicit");
        },
        "provider-5xx": async () => {
          upstream.enqueueFault("POST", SEARCH_PATH, {
            type: "status",
            status: 503,
            body: { error: { status: "UNAVAILABLE" } },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_FAILURE",
          );
          return passed("provider-5xx", "Google outage remained explicit");
        },
        "opaque-connection-id": async () =>
          passed(
            "opaque-connection-id",
            "adapter exposes only an opaque connection handle",
            { connectionId: adapter.connectionId },
          ),
        "secret-redaction": async () => {
          await adapter.searchPlaces({ query: "park" });
          const diagnostic = redactProviderDiagnostics(upstream.requests, [
            "google_test_api_key_secret",
          ]);
          expect(JSON.stringify(diagnostic)).not.toContain(
            "google_test_api_key_secret",
          );
          return passed(
            "secret-redaction",
            "recorded requests redact the provider API key",
            { diagnostic },
          );
        },
        "read-policy": async () => {
          const page = await adapter.searchPlaces({ query: "park", limit: 1 });
          expect(page.places).toHaveLength(1);
          return passed(
            "read-policy",
            "read completed without mutation receipt",
          );
        },
      },
    });
    expect(report.observations).toHaveLength(14);
  });

  it("normalizes place details, routes, and missing places", async () => {
    const detail = makeAdapter();
    await expect(detail.getPlace("gp-park-1")).resolves.toEqual(
      normalizedPlace,
    );
    upstream.enqueueFault("GET", DETAIL_PATH, {
      type: "status",
      status: 404,
      body: { error: { status: "NOT_FOUND" } },
    });
    const missing = makeAdapter({ placeCacheTtlMs: 0 });
    await expect(missing.getPlace("gp-park-1")).resolves.toBeNull();

    const route = await adapter.planRoute({
      origin: normalizedPlace,
      destination: {
        ...normalizedPlace,
        providerPlaceId: "gp-museum-2",
        name: "de Young Museum",
      },
      travelMode: "walk",
    });
    expect(route).toMatchObject({
      provider: GOOGLE_MAPS_PROVIDER_ID,
      travelMode: "walk",
      distanceMeters: 1200,
      durationSeconds: 900,
      encodedPolyline: "poly-abc",
      warnings: ["This route has tolls."],
      origin: { providerPlaceId: "gp-park-1" },
      destination: { providerPlaceId: "gp-museum-2" },
    });
    const sent = JSON.parse(upstream.requests.at(-1)?.body ?? "{}") as {
      origin?: { placeId?: string };
      travelMode?: string;
    };
    expect(sent.origin?.placeId).toBe("gp-park-1");
    expect(sent.travelMode).toBe("WALK");
  });

  it("sends coordinate endpoints as latLng waypoints and echoes their identity", async () => {
    const coordinate = {
      provider: "coordinates",
      providerPlaceId: "coordinates:37.77,-122.42",
      name: "Dropped pin",
      coordinates: { latitude: 37.77, longitude: -122.42 },
      categories: [],
    };
    const route = await adapter.planRoute({
      origin: coordinate,
      destination: normalizedPlace,
      travelMode: "drive",
    });
    expect(route.origin).toEqual(coordinate);
    const sent = JSON.parse(upstream.requests.at(-1)?.body ?? "{}") as {
      origin?: { location?: { latLng?: { latitude?: number } } };
    };
    expect(sent.origin?.location?.latLng?.latitude).toBe(37.77);
  });

  it("reports an explicit not-found when Google returns no route", async () => {
    upstream.enqueueFault("POST", ROUTES_PATH, {
      type: "schema-drift",
      body: {},
    });
    await expectCode(
      adapter.planRoute({
        origin: normalizedPlace,
        destination: normalizedPlace,
        travelMode: "transit",
      }),
      "MAPS_NOT_FOUND",
    );
  });

  it("keeps expired and revoked Google authentication failures distinct", async () => {
    upstream.enqueueFault("POST", SEARCH_PATH, {
      type: "status",
      status: 401,
      body: { error: { status: "UNAUTHENTICATED" } },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_EXPIRED",
    );
    upstream.enqueueFault("POST", SEARCH_PATH, {
      type: "status",
      status: 403,
      body: { error: { status: "PERMISSION_DENIED" } },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_REVOKED",
    );
  });

  it("caches place details within policy bounds and coalesces concurrent reads", async () => {
    const cachingAdapter = makeAdapter();
    const before = upstream.requests.length;
    const [first, second] = await Promise.all([
      cachingAdapter.getPlace("gp-park-1"),
      cachingAdapter.getPlace("gp-park-1"),
    ]);
    expect(first).toEqual(normalizedPlace);
    expect(second).toEqual(normalizedPlace);
    expect(upstream.requests.length).toBe(before + 1);
    await expect(cachingAdapter.getPlace("gp-park-1")).resolves.toEqual(
      normalizedPlace,
    );
    expect(upstream.requests.length).toBe(before + 1);
    const usage = cachingAdapter.usage();
    expect(usage.byOperation["places:get"]).toBe(1);
    expect(usage.cacheHits).toBe(1);
    expect(usage.coalescedReads).toBe(1);

    const uncached = makeAdapter({ placeCacheTtlMs: 0 });
    await uncached.getPlace("gp-park-1");
    await uncached.getPlace("gp-park-1");
    expect(uncached.usage().byOperation["places:get"]).toBe(2);
  });

  it("isolates cached place details from caller mutation", async () => {
    const cachingAdapter = makeAdapter();
    const first = await cachingAdapter.getPlace("gp-park-1");
    expect(first).toEqual(normalizedPlace);
    if (first === null) throw new Error("Expected a cached place");
    first.name = "poisoned";
    first.coordinates.latitude = 0;
    first.categories.push("poisoned-category");
    const second = await cachingAdapter.getPlace("gp-park-1");
    expect(second).toEqual(normalizedPlace);
    expect(second).not.toBe(first);

    const coalescing = makeAdapter();
    const [left, right] = await Promise.all([
      coalescing.getPlace("gp-park-1"),
      coalescing.getPlace("gp-park-1"),
    ]);
    if (left === null || right === null)
      throw new Error("Expected coalesced places");
    left.categories.splice(0, left.categories.length);
    left.coordinates.longitude = 0;
    expect(right).toEqual(normalizedPlace);
    await expect(coalescing.getPlace("gp-park-1")).resolves.toEqual(
      normalizedPlace,
    );
  });

  it("rejects route durations that would escape the RoutePlan contract", async () => {
    for (const duration of [
      `${"9".repeat(320)}s`,
      "9e999s",
      "-5s",
      "5",
      "s",
    ]) {
      upstream.enqueueFault("POST", ROUTES_PATH, {
        type: "schema-drift",
        body: { routes: [{ distanceMeters: 10, duration }] },
      });
      await expectCode(
        adapter.planRoute({
          origin: normalizedPlace,
          destination: normalizedPlace,
          travelMode: "drive",
        }),
        "MAPS_MALFORMED_RESPONSE",
      );
    }
    for (const [duration, expected] of [
      ["0s", 0],
      ["0.4s", 0],
      ["899.500s", 900],
      ["315576000000s", 315_576_000_000],
    ] as const) {
      upstream.enqueueFault("POST", ROUTES_PATH, {
        type: "schema-drift",
        body: { routes: [{ duration }] },
      });
      const plan = await adapter.planRoute({
        origin: normalizedPlace,
        destination: normalizedPlace,
        travelMode: "drive",
      });
      expect(plan.durationSeconds).toBe(expected);
      expect(plan.distanceMeters).toBe(0);
      expect(Number.isSafeInteger(plan.durationSeconds)).toBe(true);
    }
  });

  it("exposes the mandatory Google attribution at the adapter contract", () => {
    expect(adapter.attribution).toBe(GOOGLE_MAPS_ATTRIBUTION);
  });

  it("fails explicitly when the request budget is exhausted", async () => {
    const budgeted = makeAdapter({ maxRequests: 2 });
    await budgeted.searchPlaces({ query: "park" });
    await budgeted.searchPlaces({ query: "park" });
    const before = upstream.requests.length;
    const error = await expectCode(
      budgeted.searchPlaces({ query: "park" }),
      "MAPS_BUDGET_EXHAUSTED",
    );
    expect(upstream.requests.length).toBe(before);
    expect(error.context).toMatchObject({ maxRequests: 2, requests: 2 });
    expect(budgeted.usage()).toMatchObject({
      requests: 2,
      remainingBudget: 0,
      byOperation: { "places:searchText": 2 },
    });
  });

  it("authenticates with the API key header and never a bearer token", async () => {
    await adapter.searchPlaces({ query: "park" });
    const recorded = upstream.requests.at(-1);
    expect(recorded?.headers["x-goog-api-key"]).toBeDefined();
    expect(recorded?.headers.authorization).toBeUndefined();
    expect(recorded?.headers["x-goog-fieldmask"]).toContain(
      "places.displayName",
    );
  });

  it("interoperates with MapsService normalization and provider binding", async () => {
    const service = new MapsService(undefined, {
      save: () => Promise.reject(new Error("not under test")),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
    });
    service.registerAdapter(adapter, true);
    const page = await service.searchPlaces({ query: "park" });
    expect(page.places[0]).toEqual(normalizedPlace);
    const place = await service.getPlace("gp-park-1");
    expect(place?.providerPlaceId).toBe("gp-park-1");
    expect(
      service.describeProviders([GOOGLE_MAPS_PROVIDER_ID])[0]?.attribution,
    ).toBe(GOOGLE_MAPS_ATTRIBUTION);
  });
});

describe("GoogleMapsAdapter provider contract (managed mode)", () => {
  let gateway: Awaited<ReturnType<typeof startFakeProvider>>;
  let adapter: GoogleMapsAdapter;
  let connectionId: string;

  beforeAll(async () => {
    gateway = await startFakeProvider({ fixtures: managedFixtures() });
    connectionId = gateway.createConnectionId();
    adapter = new GoogleMapsAdapter({
      connectionId,
      credential: {
        mode: "managed",
        sessionToken: "managed_session_token_secret",
        gatewayUrl: gateway.url,
      },
      timeoutMs: 2_000,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("routes every call through the gateway prefixes with managed auth only", async () => {
    const page = await adapter.searchPlaces({ query: "park" });
    expect(page.places[0]).toEqual(normalizedPlace);
    await expect(adapter.getPlace("gp-park-1")).resolves.toEqual(
      normalizedPlace,
    );
    await adapter.planRoute({
      origin: normalizedPlace,
      destination: normalizedPlace,
      travelMode: "drive",
    });
    const paths = gateway.requests.map((request) => request.path);
    expect(paths).toEqual([
      "/google-maps/places/v1/places:searchText",
      "/google-maps/places/v1/places/gp-park-1",
      "/google-maps/routes/directions/v2:computeRoutes",
    ]);
    for (const request of gateway.requests) {
      expect(request.headers.authorization).toBeDefined();
      expect(request.headers["x-goog-api-key"]).toBeUndefined();
      expect(request.headers["x-maps-connection-id"]).toBe(connectionId);
    }
    const diagnostic = redactProviderDiagnostics(gateway.requests, [
      "managed_session_token_secret",
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain(
      "managed_session_token_secret",
    );
  });

  it("maps gateway credential revocation onto the typed revoked failure", async () => {
    gateway.enqueueFault("POST", "/google-maps/places/v1/places:searchText", {
      type: "status",
      status: 403,
      body: { code: "credential_revoked" },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_REVOKED",
    );
    gateway.enqueueFault("POST", "/google-maps/places/v1/places:searchText", {
      type: "status",
      status: 401,
      body: { code: "credential_expired" },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_EXPIRED",
    );
  });

  it("refuses endpoint overrides and incomplete credentials per mode", () => {
    const managed = {
      mode: "managed" as const,
      sessionToken: "token-1234",
      gatewayUrl: "https://gateway.example.test",
    };
    expect(
      () =>
        new GoogleMapsAdapter({
          connectionId: "conn_managed_override_123",
          credential: managed,
          placesEndpoint: "https://attacker.example.test",
        }),
    ).toThrow(MapsError);
    expect(
      () =>
        new GoogleMapsAdapter({
          connectionId: "conn_managed_override_123",
          credential: { ...managed, sessionToken: " " },
        }),
    ).toThrow(MapsError);
    expect(
      () =>
        new GoogleMapsAdapter({
          connectionId: "conn_key_missing_12345",
          credential: { mode: "api-key", apiKey: " " },
        }),
    ).toThrow(MapsError);
    expect(
      () =>
        new GoogleMapsAdapter({
          connectionId: "short",
          credential: { mode: "api-key", apiKey: "k" },
        }),
    ).toThrow(MapsError);
    for (const gatewayUrl of [
      "http://169.254.169.254/",
      "https://127.0.0.1/",
      "https://user:pass@gateway.example.test/",
      "https://gateway.example.test/base-path",
    ]) {
      expect(
        () =>
          new GoogleMapsAdapter({
            connectionId: "conn_blocked_gateway_123",
            credential: { ...managed, gatewayUrl },
          }),
      ).toThrow(MapsError);
    }
  });
});
