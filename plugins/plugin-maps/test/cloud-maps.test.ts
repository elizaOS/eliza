/**
 * Eliza Cloud Maps adapter and phone navigation actions. The Cloud API is a
 * stub that answers with the `/api/v1/maps` wire contract; the adapter, the
 * guarded transport, MapsService and the actions are the real modules.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { mapsAction, mapsNavigationAction } from "../src/action.js";
import {
  ELIZA_CLOUD_MAPS_ATTRIBUTION,
  ElizaCloudMapsAdapter,
} from "../src/cloud-adapter.js";
import { MapsError } from "../src/errors.js";
import type { MapsDeviceNavigation } from "../src/navigation.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";

const CASINO = { latitude: 43.7397, longitude: 7.4276 };
const PORT = { latitude: 43.7347, longitude: 7.4206 };
const PLACE = {
  providerId: "eliza-cloud-osm",
  id: "N1234",
  name: "Casino de Monte-Carlo",
  coordinate: CASINO,
  address: "Place du Casino, Monaco",
  attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
  fetchedAt: 1_760_000_000_000,
};
const ROUTE = (distanceMeters: number) => ({
  providerId: "eliza-cloud-osm",
  id: `route_${distanceMeters}`,
  from: CASINO,
  to: PORT,
  mode: "walk",
  geometry: [CASINO, PORT],
  distanceMeters,
  durationSeconds: 300,
  steps: [{ instruction: "Walk south", coordinate: CASINO, distanceMeters }],
  attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
  fetchedAt: 1_760_000_000_000,
  traffic: "none",
});

type Request = {
  path: string;
  body: unknown;
  authorization: string | null;
  requestId: string | null;
  url: string;
};

const COVERAGE = {
  providerId: "eliza-cloud-osm",
  attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
  capabilities: { modes: ["drive", "walk", "bicycle"], reverseGeocode: true },
};

/**
 * Stub Cloud. `capabilities` answers the adapter's provider read, which is
 * kept apart from `requests` so data requests are counted as before.
 */
function cloud(
  answer: (request: Request) => Response,
  options: {
    coverage?: () => unknown;
    onDescriptionChange?: (adapter: ElizaCloudMapsAdapter) => void;
  } = {},
) {
  const requests: Request[] = [];
  const capabilityReads: string[] = [];
  const adapter = new ElizaCloudMapsAdapter({
    apiKey: "eliza_test_key",
    baseUrl: "https://api.example.test/api/v1",
    onDescriptionChange: options.onDescriptionChange,
    testTransport: {
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/maps/capabilities") {
          capabilityReads.push(init?.method ?? "GET");
          return Response.json(options.coverage?.() ?? COVERAGE);
        }
        const request = {
          path: url.pathname,
          url: url.href,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          authorization: new Headers(init?.headers).get("authorization"),
          requestId: new Headers(init?.headers).get("Idempotency-Key"),
        };
        requests.push(request);
        return answer(request);
      },
    },
  });
  return { adapter, requests, capabilityReads };
}

const unusedStore = {} as SavedPlaceStore;

function runtimeWith(service: MapsService): IAgentRuntime {
  return { getService: () => service } as unknown as IAgentRuntime;
}

function message(content: Record<string, unknown>): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    entityId: "00000000-0000-4000-8000-000000000002",
    roomId: "00000000-0000-4000-8000-000000000003",
    content,
  } as unknown as Memory;
}

describe("ElizaCloudMapsAdapter", () => {
  it("rejects unsupported query and result limits without changing the request", async () => {
    const { adapter, requests } = cloud(() =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        places: [],
      }),
    );
    await expect(
      adapter.searchPlaces({ query: "x".repeat(301) }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    await expect(
      adapter.searchPlaces({ query: "exact", limit: 21 }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    expect(requests).toHaveLength(0);
    const query = "x".repeat(300);
    await adapter.searchPlaces({ query, limit: 20 });
    expect(requests[0].body).toEqual({ query, limit: 20 });
  });
  it("searches through POST bodies with the API key and maps device places", async () => {
    const { adapter, requests } = cloud(() =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        places: [PLACE],
      }),
    );
    const page = await adapter.searchPlaces({
      query: "Casino",
      near: CASINO,
      limit: 5,
    });
    expect(requests).toEqual([
      {
        path: "/api/v1/maps/places/search",
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        url: "https://api.example.test/api/v1/maps/places/search",
        body: { query: "Casino", near: CASINO, limit: 5 },
        authorization: "Bearer eliza_test_key",
      },
    ]);
    expect(page).toEqual({
      places: [
        {
          provider: "eliza-cloud",
          providerPlaceId: "N1234",
          name: "Casino de Monte-Carlo",
          coordinates: CASINO,
          formattedAddress: "Place du Casino, Monaco",
          categories: [],
        },
      ],
      nextCursor: null,
    });
  });

  it("plans alternatives through MapsService and binds them to the requested endpoints", async () => {
    const { adapter, requests } = cloud(() =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        routes: [ROUTE(500), ROUTE(650)],
      }),
    );
    const service = new MapsService(undefined, unusedStore);
    service.registerAdapter(adapter);
    const origin = {
      provider: "coordinates",
      providerPlaceId: "coordinates:43.7397,7.4276",
      name: "Casino",
      coordinates: CASINO,
      categories: [],
    };
    const destination = {
      provider: "eliza-cloud",
      providerPlaceId: "N99",
      name: "Port Hercule",
      coordinates: PORT,
      categories: [],
    };
    const { routes, provider } = await service.planRouteAlternativesResult({
      origin,
      destination,
      travelMode: "walk",
    });
    expect(requests[0]?.body).toEqual({
      from: CASINO,
      to: PORT,
      mode: "walk",
      alternatives: true,
    });
    expect(provider.attribution).toBe(ELIZA_CLOUD_MAPS_ATTRIBUTION);
    expect(routes.map((route) => route.distanceMeters)).toEqual([500, 650]);
    expect(routes[0]).toMatchObject({
      provider: "eliza-cloud",
      origin,
      destination,
      warnings: ["No live traffic."],
    });
  });

  it("assigns a distinct request ID per explicit operation, without automatic replay", async () => {
    const { adapter, requests } = cloud(() =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        places: [PLACE],
      }),
    );
    await adapter.searchPlaces({ query: "Casino" });
    await adapter.searchPlaces({ query: "Casino" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  });
  it.each([
    [422, "unsupported_region", "MAPS_UNSUPPORTED_REGION"],
    [422, "no_route", "MAPS_NOT_FOUND"],
    [403, "subscription_required", "MAPS_NOT_ENTITLED"],
    [503, "maps_allowance_unconfigured", "MAPS_ALLOWANCE_UNCONFIGURED"],
    [503, "maps_admission_unknown", "MAPS_ADMISSION_UNKNOWN"],
    [409, "maps_request_already_admitted", "MAPS_REQUEST_ALREADY_ADMITTED"],
    [429, "allowance_exhausted", "MAPS_BUDGET_EXHAUSTED"],
    [503, "maps_not_configured", "MAPS_PROVIDER_UNAVAILABLE"],
    [503, "provider_unavailable", "MAPS_PROVIDER_FAILURE"],
  ])(
    "reports Cloud %s %s as %s, never as data",
    async (status, code, mapsCode) => {
      const { adapter } = cloud(() =>
        Response.json({ error: "refused", code }, { status }),
      );
      const error = await adapter
        .searchPlaces({ query: "Casino" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MapsError);
      expect((error as MapsError).code).toBe(mapsCode);
    },
  );

  it("refuses a response from a provider with different attribution", async () => {
    const { adapter } = cloud(() =>
      Response.json({
        providerId: "other",
        attribution: "Other data",
        places: [{ ...PLACE, attribution: "Other data" }],
      }),
    );
    await expect(
      adapter.searchPlaces({ query: "Casino" }),
    ).rejects.toMatchObject({ code: "MAPS_PROVIDER_CHANGED" });
  });
});

describe("Cloud provider binding", () => {
  const VALHALLA =
    "© OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: Valhalla.";

  it("binds Cloud's advertised attribution and refreshes the service description", async () => {
    const service = new MapsService(undefined, unusedStore);
    const { adapter, capabilityReads } = cloud(
      () =>
        Response.json({
          providerId: "eliza-cloud-osm",
          attribution: VALHALLA,
          places: [{ ...PLACE, attribution: VALHALLA }],
        }),
      {
        coverage: () => ({ ...COVERAGE, attribution: VALHALLA }),
        onDescriptionChange: (changed) =>
          service.refreshAdapterDescription(changed),
      },
    );
    service.registerAdapter(adapter);
    const [before] = service.describeProviders(["eliza-cloud"]);
    const { page, provider } = await service.searchPlacesResult({
      query: "Casino",
    });
    expect(page.places).toHaveLength(1);
    expect(provider.attribution).toBe(VALHALLA);
    expect(provider.generation).toBeGreaterThan(before?.generation ?? 0);
    await service.searchPlacesResult({ query: "Casino" });
    expect(capabilityReads).toEqual(["GET"]);
    await expect(
      service.searchPlacesResult(
        { query: "Casino" },
        undefined,
        before?.generation,
      ),
    ).rejects.toMatchObject({ code: "MAPS_PROVIDER_CHANGED" });
  });

  it("refuses a provider change during a session, then reads capabilities again", async () => {
    let attribution = ELIZA_CLOUD_MAPS_ATTRIBUTION;
    const { adapter, capabilityReads } = cloud(
      () =>
        Response.json({
          providerId: "eliza-cloud-osm",
          attribution: VALHALLA,
          places: [{ ...PLACE, attribution: VALHALLA }],
        }),
      { coverage: () => ({ ...COVERAGE, attribution }) },
    );
    await expect(
      adapter.searchPlaces({ query: "Casino" }),
    ).rejects.toMatchObject({ code: "MAPS_PROVIDER_CHANGED" });
    attribution = VALHALLA;
    const page = await adapter.searchPlaces({ query: "Casino" });
    expect(page.places).toHaveLength(1);
    expect(adapter.attribution).toBe(VALHALLA);
    expect(capabilityReads).toHaveLength(2);
  });

  it("does not cache a failed capabilities read", async () => {
    let configured = false;
    const { adapter, requests } = cloud(
      () =>
        Response.json({
          providerId: "eliza-cloud-osm",
          attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
          places: [PLACE],
        }),
      {
        coverage: () =>
          configured
            ? COVERAGE
            : { error: "not configured", code: "maps_not_configured" },
      },
    );
    await expect(
      adapter.searchPlaces({ query: "Casino" }),
    ).rejects.toMatchObject({ code: "MAPS_MALFORMED_RESPONSE" });
    expect(requests).toHaveLength(0);
    configured = true;
    expect(
      (await adapter.searchPlaces({ query: "Casino" })).places,
    ).toHaveLength(1);
  });

  it("refuses a travel mode Cloud does not serve before an admitted request", async () => {
    const { adapter, requests } = cloud(() => Response.json({}), {
      coverage: () => ({
        ...COVERAGE,
        capabilities: { modes: ["walk"], reverseGeocode: true },
      }),
    });
    await expect(
      adapter.planRoute({
        origin: {
          provider: "coordinates",
          providerPlaceId: "coordinates:origin",
          name: "Casino",
          coordinates: CASINO,
          categories: [],
        },
        destination: {
          provider: "eliza-cloud",
          providerPlaceId: "N99",
          name: "Port",
          coordinates: PORT,
          categories: [],
        },
        travelMode: "drive",
      }),
    ).rejects.toMatchObject({ code: "MAPS_UNSUPPORTED_REGION" });
    expect(requests).toHaveLength(0);
  });

  it("accepts the opaque place ids of Cloud's configured geocoder", async () => {
    const { adapter, requests } = cloud((request) =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        place: { ...PLACE, id: (request.body as { id: string }).id },
      }),
    );
    expect((await adapter.getPlace("acme:place.42"))?.providerPlaceId).toBe(
      "acme:place.42",
    );
    expect(await adapter.getPlace("../etc")).toBeNull();
    expect(requests.map((request) => request.body)).toEqual([
      { id: "acme:place.42" },
    ]);
  });

  it("reverse geocodes coordinates in the POST body, for the agent's place action", async () => {
    let place: unknown = PLACE;
    const { adapter, requests } = cloud(() =>
      Response.json({
        providerId: "eliza-cloud-osm",
        attribution: ELIZA_CLOUD_MAPS_ATTRIBUTION,
        place,
      }),
    );
    const service = new MapsService(undefined, unusedStore);
    service.registerAdapter(adapter);
    const found = await mapsAction.handler(
      runtimeWith(service),
      message({}),
      undefined,
      { parameters: { action: "place", ...CASINO } },
    );
    expect(found).toMatchObject({
      success: true,
      data: {
        status: "found",
        place: { providerPlaceId: "N1234", name: "Casino de Monte-Carlo" },
      },
    });
    expect(requests[0]).toMatchObject({
      path: "/api/v1/maps/reverse",
      url: "https://api.example.test/api/v1/maps/reverse",
      body: { coordinate: CASINO },
    });
    place = null;
    const empty = await mapsAction.handler(
      runtimeWith(service),
      message({}),
      undefined,
      { parameters: { action: "place", ...CASINO } },
    );
    expect(empty).toMatchObject({ success: true, data: { status: "empty" } });
    await expect(
      adapter.reverseGeocode({ latitude: 91, longitude: 0 }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
  });
});

describe("phone navigation actions", () => {
  function device(): MapsDeviceNavigation & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      select: async (place) => {
        calls.push(["select", place.name]);
        return { state: "selected", placeName: place.name };
      },
      start: async ({ destination, travelMode }) => {
        calls.push(["start", destination.name, travelMode]);
        return {
          state: "awaiting-confirmation",
          placeName: destination.name,
          travelMode,
        };
      },
      reroute: async () => {
        calls.push(["reroute"]);
        return { state: "navigating", placeName: "Port Hercule" };
      },
      stop: async () => {
        calls.push(["stop"]);
        return { state: "stopped" };
      },
    };
  }

  it("does not report stopped when the phone returns an unknown state", async () => {
    const service = new MapsService(undefined, unusedStore);
    const phone = device();
    phone.stop = async () =>
      ({ state: "unexpected" }) as unknown as Awaited<
        ReturnType<MapsDeviceNavigation["stop"]>
      >;
    service.registerDeviceNavigation(phone);
    const result = await mapsNavigationAction.handler(
      runtimeWith(service),
      message({}),
      undefined,
      { parameters: { action: "stop" } },
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: "MAPS_MALFORMED_RESPONSE" },
    });
  });

  it("refuses navigation honestly when no phone owns it", async () => {
    const service = new MapsService(undefined, unusedStore);
    const result = await mapsNavigationAction.handler(
      runtimeWith(service),
      message({}),
      undefined,
      { parameters: { action: "stop" } },
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: "MAPS_DEVICE_UNAVAILABLE" },
    });
  });

  it("hands start, reroute, stop and select to the phone and reports its state", async () => {
    const service = new MapsService(undefined, unusedStore);
    const phone = device();
    service.registerDeviceNavigation(phone);
    const runtime = runtimeWith(service);
    const destination = {
      latitude: PORT.latitude,
      longitude: PORT.longitude,
      name: "Port Hercule",
    };
    const started = await mapsNavigationAction.handler(
      runtime,
      message({}),
      undefined,
      {
        parameters: { action: "start", travelMode: "walk", ...destination },
      },
    );
    expect(started).toMatchObject({
      success: false,
      userFacingText:
        "Confirm on the phone to start navigation to Port Hercule.",
    });
    await mapsNavigationAction.handler(runtime, message({}), undefined, {
      parameters: { action: "reroute" },
    });
    const stopped = await mapsNavigationAction.handler(
      runtime,
      message({}),
      undefined,
      {
        parameters: { action: "stop" },
      },
    );
    expect(stopped).toMatchObject({
      success: true,
      userFacingText: "Navigation stopped.",
    });
    const selected = await mapsAction.handler(runtime, message({}), undefined, {
      parameters: { action: "select", ...destination },
    });
    expect(selected).toMatchObject({
      success: true,
      userFacingText: "Selected Port Hercule on the map.",
    });
    expect(phone.calls).toEqual([
      ["start", "Port Hercule", "walk"],
      ["reroute"],
      ["stop"],
      ["select", "Port Hercule"],
    ]);
  });
});
