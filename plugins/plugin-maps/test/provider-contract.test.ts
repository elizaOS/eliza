/** Exercises the real normalized HTTP adapter against the protocol-faithful fake upstream. */

import {
  type ProviderContractObservation,
  type ProviderProtocolFixture,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JsonMapsHttpAdapter } from "../src/adapter.js";
import { MapsError } from "../src/errors.js";

const place = {
  provider: "contract-maps",
  providerPlaceId: "place-1",
  name: "Contract Park",
  coordinates: { latitude: 37.77, longitude: -122.42 },
  formattedAddress: "1 Contract Way",
  categories: ["park"],
};

const fixtures: ProviderProtocolFixture[] = [
  {
    id: "maps-search",
    method: "GET",
    path: "/places/search",
    response: {
      status: 200,
      body: { places: [place], nextCursor: "cursor-page-2" },
    },
  },
  {
    id: "maps-place",
    method: "GET",
    path: "/places/place-1",
    response: { status: 200, body: place },
  },
  {
    id: "maps-route",
    method: "POST",
    path: "/routes",
    response: {
      status: 200,
      body: {
        provider: "contract-maps",
        routeId: "route-1",
        origin: place,
        destination: { ...place, providerPlaceId: "place-2", name: "Museum" },
        travelMode: "walk",
        distanceMeters: 1200,
        durationSeconds: 900,
        warnings: [],
      },
    },
  },
];

function passed(
  scenario: ProviderContractObservation["scenario"],
  detail: string,
  extra: Partial<ProviderContractObservation> = {},
): ProviderContractObservation {
  return { scenario, status: "passed", detail, ...extra };
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

describe("JsonMapsHttpAdapter provider contract", () => {
  let upstream: Awaited<ReturnType<typeof startFakeProvider>>;
  let adapter: JsonMapsHttpAdapter;

  beforeAll(async () => {
    upstream = await startFakeProvider({ fixtures });
    adapter = new JsonMapsHttpAdapter({
      id: "contract-maps",
      connectionId: upstream.createConnectionId(),
      baseUrl: upstream.url,
      credential: "maps_contract_secret",
      timeoutMs: 100,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("executes every outbound read and pagination scenario", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "JsonMapsHttpAdapter",
      profile: "outbound-http",
      capabilities: ["http-read", "pagination"],
      scenarios: {
        success: async () => {
          const page = await adapter.searchPlaces({ query: "park" });
          expect(page.places[0]).toEqual(place);
          return passed("success", "normalized place response inspected");
        },
        "designed-empty": async () => {
          upstream.enqueueFault("GET", "/places/search", {
            type: "schema-drift",
            body: { places: [], nextCursor: null },
          });
          const page = await adapter.searchPlaces({ query: "none" });
          expect(page).toEqual({ places: [], nextCursor: null });
          return passed(
            "designed-empty",
            "empty page remained distinct from failure",
          );
        },
        "invalid-input": async () => {
          await expectCode(
            adapter.searchPlaces({ query: " " }),
            "MAPS_INVALID_INPUT",
          );
          return passed("invalid-input", "blank query rejected before HTTP");
        },
        "pagination-cursors": async () => {
          const page = await adapter.searchPlaces({
            query: "park",
            cursor: "cursor-page-1",
          });
          expect(page.nextCursor).toBe("cursor-page-2");
          expect(upstream.requests.at(-1)?.query.cursor).toBe("cursor-page-1");
          return passed(
            "pagination-cursors",
            "opaque request and response cursors inspected",
          );
        },
        "rate-limit-retry-metadata": async () => {
          upstream.enqueueFault("GET", "/places/search", {
            type: "status",
            status: 429,
            headers: { "retry-after": "2" },
            body: { code: "rate_limited" },
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
          upstream.enqueueFault("GET", "/places/search", {
            type: "malformed-json",
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_MALFORMED_RESPONSE",
          );
          return passed("malformed-json", "invalid provider JSON rejected");
        },
        "schema-drift": async () => {
          upstream.enqueueFault("GET", "/places/search", {
            type: "schema-drift",
            body: {
              places: [
                {
                  ...place,
                  coordinates: { latitude: 200, longitude: -122.42 },
                },
              ],
              nextCursor: null,
            },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_MALFORMED_RESPONSE",
          );
          return passed(
            "schema-drift",
            "malformed provider coordinates rejected",
          );
        },
        timeout: async () => {
          upstream.enqueueFault("GET", "/places/search", {
            type: "delay",
            durationMs: 250,
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_TIMEOUT",
          );
          return passed("timeout", "bounded abort surfaced as timeout");
        },
        "connection-reset": async () => {
          const resetUpstream = await startFakeProvider({ fixtures });
          const resetAdapter = new JsonMapsHttpAdapter({
            id: "reset-maps",
            connectionId: resetUpstream.createConnectionId(),
            baseUrl: resetUpstream.url,
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
          upstream.enqueueFault("GET", "/places/search", {
            type: "status",
            status: 400,
            body: { code: "bad_request" },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_REJECTED",
          );
          return passed("provider-4xx", "provider rejection remained explicit");
        },
        "provider-5xx": async () => {
          upstream.enqueueFault("GET", "/places/search", {
            type: "status",
            status: 503,
            body: { code: "unavailable" },
          });
          await expectCode(
            adapter.searchPlaces({ query: "park" }),
            "MAPS_PROVIDER_FAILURE",
          );
          return passed("provider-5xx", "provider outage remained explicit");
        },
        "opaque-connection-id": async () =>
          passed(
            "opaque-connection-id",
            "adapter exposes only an opaque connection handle",
            {
              connectionId: adapter.connectionId,
            },
          ),
        "secret-redaction": async () => {
          await adapter.searchPlaces({ query: "park" });
          const diagnostic = redactProviderDiagnostics(upstream.requests, [
            "maps_contract_secret",
          ]);
          expect(JSON.stringify(diagnostic)).not.toContain(
            "maps_contract_secret",
          );
          return passed(
            "secret-redaction",
            "recorded requests redact bearer credentials",
            {
              diagnostic,
            },
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

  it("keeps expired and revoked authentication failures distinct", async () => {
    upstream.enqueueFault("GET", "/places/search", {
      type: "status",
      status: 401,
      body: { code: "credential_expired" },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_EXPIRED",
    );

    upstream.enqueueFault("GET", "/places/search", {
      type: "status",
      status: 403,
      body: { code: "credential_revoked" },
    });
    await expectCode(
      adapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_REVOKED",
    );
  });

  it("validates route and place detail responses through the same adapter", async () => {
    await expect(adapter.getPlace("place-1")).resolves.toEqual(place);
    const route = await adapter.planRoute({
      origin: place,
      destination: { ...place, providerPlaceId: "place-2", name: "Museum" },
      travelMode: "walk",
    });
    expect(route).toMatchObject({ routeId: "route-1", durationSeconds: 900 });
  });

  it("accepts coordinate route endpoints without weakening provider binding", async () => {
    const coordinate = {
      ...place,
      provider: "coordinates",
      providerPlaceId: "coordinates:37.77,-122.42",
    };
    const route = await adapter.planRoute({
      origin: coordinate,
      destination: { ...coordinate, name: "Coordinate destination" },
      travelMode: "drive",
    });
    expect(route).toMatchObject({
      provider: "contract-maps",
      origin: { provider: "contract-maps" },
      destination: { provider: "contract-maps" },
    });
  });

  it("rejects malformed direct adapter requests before outbound I/O", async () => {
    const transport = vi.fn(async () => Response.json({}));
    const strictAdapter = new JsonMapsHttpAdapter({
      id: "strict-maps",
      connectionId: "conn_strict_boundary_1234",
      baseUrl: "https://maps-strict.example.test",
      testTransport: { fetchImpl: transport },
    });
    for (const request of [
      { query: "park", near: { latitude: Number.NaN, longitude: 0 } },
      { query: "park", near: { latitude: 91, longitude: 0 } },
      { query: "park", cursor: "" },
      { query: "park", limit: 0 },
      { query: "park", limit: 101 },
    ]) {
      await expectCode(
        strictAdapter.searchPlaces(request as never),
        "MAPS_INVALID_INPUT",
      );
    }
    await expectCode(
      strictAdapter.planRoute({
        origin: {
          ...place,
          coordinates: { latitude: Number.NaN, longitude: 0 },
        },
        destination: place,
        travelMode: "hover" as never,
      }),
      "MAPS_INVALID_INPUT",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("classifies empty or non-JSON error bodies from status before parsing", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      new Response("<html>unavailable</html>", { status: 503 }),
      new Response(null, { status: 401 }),
    ];
    const statusAdapter = new JsonMapsHttpAdapter({
      id: "status-maps",
      connectionId: "conn_status_semantics_1234",
      baseUrl: "https://maps-status.example.test",
      testTransport: {
        fetchImpl: vi.fn(async () => {
          const response = responses.shift();
          if (!response) throw new Error("No queued status response");
          return response;
        }),
      },
    });
    const rateLimit = await expectCode(
      statusAdapter.searchPlaces({ query: "park" }),
      "MAPS_RATE_LIMITED",
    );
    expect(rateLimit.retryAfterMs).toBe(2_000);
    await expectCode(
      statusAdapter.searchPlaces({ query: "park" }),
      "MAPS_PROVIDER_FAILURE",
    );
    await expectCode(
      statusAdapter.searchPlaces({ query: "park" }),
      "MAPS_AUTH_EXPIRED",
    );
  });

  it("blocks unsafe endpoints, DNS rebinding, redirects, and oversized bodies", async () => {
    for (const baseUrl of [
      "http://169.254.169.254/",
      "https://127.0.0.1/",
      "https://user:pass@maps.example.test/",
      "https://maps.example.test/?token=secret",
      "https://maps.example.test/#fragment",
    ]) {
      expect(
        () =>
          new JsonMapsHttpAdapter({
            id: "blocked-maps",
            connectionId: "conn_blocked_endpoint_123",
            baseUrl,
          }),
      ).toThrow(MapsError);
    }

    const pinnedFetch = vi.fn(async () => new Response("{}"));
    const rebinding = new JsonMapsHttpAdapter({
      id: "rebind-maps",
      connectionId: "conn_rebinding_guard_123",
      baseUrl: "https://maps-rebind.example.test",
      testTransport: {
        lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
        pinnedFetchImpl: pinnedFetch,
      },
    });
    await expectCode(
      rebinding.searchPlaces({ query: "park" }),
      "MAPS_ENDPOINT_BLOCKED",
    );
    expect(pinnedFetch).not.toHaveBeenCalled();

    for (const location of [
      "http://169.254.169.254/latest/meta-data",
      "https://other-origin.example.test/steal",
    ]) {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const redirects = new JsonMapsHttpAdapter({
        id: "redirect-maps",
        connectionId: "conn_redirect_guard_1234",
        baseUrl: "https://maps-redirect.example.test",
        credential: "must_not_cross_origin",
        testTransport: {
          fetchImpl: vi.fn(async (input, init) => {
            requests.push({
              url: String(input),
              authorization: new Headers(init?.headers).get("authorization"),
            });
            return new Response(null, {
              status: 302,
              headers: { location },
            });
          }),
        },
      });
      await expectCode(
        redirects.searchPlaces({ query: "park" }),
        "MAPS_PROVIDER_NETWORK",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain("maps-redirect.example.test");
    }

    const oversized = new JsonMapsHttpAdapter({
      id: "bounded-maps",
      connectionId: "conn_response_bound_1234",
      baseUrl: "https://maps-bounded.example.test",
      responseByteLimit: 8,
      testTransport: {
        fetchImpl: vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"places":'));
                  controller.enqueue(new TextEncoder().encode("[]}"));
                  controller.close();
                },
              }),
              { status: 200 },
            ),
        ),
      },
    });
    await expectCode(
      oversized.searchPlaces({ query: "park" }),
      "MAPS_RESPONSE_TOO_LARGE",
    );
  });

  it("rejects non-finite, zero, and excessive timeout configuration", () => {
    for (const timeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      expect(
        () =>
          new JsonMapsHttpAdapter({
            id: "timeout-maps",
            connectionId: "conn_timeout_config_1234",
            baseUrl: "https://maps-timeout.example.test",
            timeoutMs,
          }),
      ).toThrow(MapsError);
    }
  });

  it("rejects provider-semantic spoofing and mixed-provider routes", async () => {
    const spoofed = new JsonMapsHttpAdapter({
      id: "provider-a",
      connectionId: "conn_provider_binding_123",
      baseUrl: "https://maps-provider.example.test",
      testTransport: {
        fetchImpl: vi.fn(async () =>
          Response.json({
            places: [{ ...place, provider: "provider-b" }],
            nextCursor: null,
          }),
        ),
      },
    });
    await expectCode(
      spoofed.searchPlaces({ query: "park" }),
      "MAPS_MALFORMED_RESPONSE",
    );
    await expectCode(
      spoofed.planRoute({
        origin: { ...place, provider: "provider-a" },
        destination: { ...place, provider: "provider-b" },
        travelMode: "drive",
      }),
      "MAPS_INVALID_INPUT",
    );
  });
});
