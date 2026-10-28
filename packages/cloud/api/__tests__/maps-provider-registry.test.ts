/**
 * The configurable Eliza Cloud Maps provider: operator settings choose the
 * geocoder and router backends, coverage carries sources and the location
 * disclosure, and invalid settings are refused without echoing them.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { MapsGeocoderBackend } from "@elizaos/cloud-shared/lib/services/maps/backends";
import { OSM_MAPS_ATTRIBUTION } from "@elizaos/cloud-shared/lib/services/maps/osm-provider";
import {
  mapsProviderFromEnv,
  parseRouterProfiles,
  registerMapsGeocoder,
  registerMapsProvider,
} from "@elizaos/cloud-shared/lib/services/maps/provider-registry";
import { decodePolyline6 } from "@elizaos/cloud-shared/lib/services/maps/valhalla-router";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import {
  createMapsRoute,
  type MapsRouteDependencies,
} from "../src/lib/maps-route";

const MONACO = {
  id: "monaco",
  name: "Monaco",
  bounds: [7.409, 43.724, 7.449, 43.752],
};
const CASINO = { latitude: 43.7397, longitude: 7.4276 };
const PORT = { latitude: 43.7347, longitude: 7.4206 };
const BASE = {
  ELIZA_MAPS_GEOCODER_URL: "https://geocoder.example.test",
  ELIZA_MAPS_ROUTER_URL: "https://router.example.test",
  ELIZA_MAPS_COVERAGE_JSON: JSON.stringify([MONACO]),
  ELIZA_MAPS_DATASET_REVISION: "osm-monaco-2026-09-29",
};

/** Encodes coordinates as polyline6, the inverse of the router's decoder. */
function polyline6(points: Array<[number, number]>): string {
  const last = [0, 0];
  let out = "";
  for (const [lat, lon] of points) {
    for (const [index, value] of [
      Math.round(lat * 1e6),
      Math.round(lon * 1e6),
    ].entries()) {
      let delta = value - last[index];
      last[index] = value;
      delta = delta < 0 ? ~(delta << 1) : delta << 1;
      while (delta >= 0x20) {
        out += String.fromCharCode((0x20 | (delta & 0x1f)) + 63);
        delta >>= 5;
      }
      out += String.fromCharCode(delta + 63);
    }
  }
  return out;
}

const VALHALLA_TRIP = (meters: number) => ({
  legs: [
    {
      shape: polyline6([
        [CASINO.latitude, CASINO.longitude],
        [43.737, 7.424],
        [PORT.latitude, PORT.longitude],
      ]),
      maneuvers: [
        {
          type: 2,
          instruction: "Walk south on Avenue des Beaux-Arts.",
          length: 0.12,
          begin_shape_index: 0,
        },
        {
          type: 15,
          instruction: "Turn left onto Boulevard Albert 1er.",
          length: 0.18,
          begin_shape_index: 1,
        },
        {
          type: 99,
          instruction: "Take the elevator.",
          length: 0,
          begin_shape_index: 1,
        },
        {
          type: 4,
          instruction: "You have arrived at your destination.",
          length: 0,
          begin_shape_index: 2,
        },
      ],
    },
  ],
  summary: { length: meters / 1000, time: 223.6 },
});

function recordingFetch(respond: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Eliza Cloud Maps provider configuration", () => {
  test("an unconfigured or explicitly disabled environment has no provider", () => {
    expect(mapsProviderFromEnv({})).toBeNull();
    expect(
      mapsProviderFromEnv({ ...BASE, ELIZA_MAPS_DATASET_REVISION: " " }),
    ).toBeNull();
    expect(
      mapsProviderFromEnv({ ...BASE, ELIZA_MAPS_PROVIDER: "none" }),
    ).toBeNull();
  });

  test("the default composition keeps the reviewed identity and adds sources and disclosure", () => {
    const coverage = mapsProviderFromEnv(BASE)?.coverage();
    expect(coverage?.providerId).toBe("eliza-cloud-osm");
    expect(coverage?.connectionId).toBe("conn_eliza_cloud_maps_osm");
    expect(coverage?.attribution).toBe(OSM_MAPS_ATTRIBUTION);
    expect(coverage?.sources).toEqual({
      data: "OpenStreetMap",
      search: "Nominatim",
      routing: "GraphHopper",
    });
    expect(coverage?.disclosure).toEqual({
      recipients: [
        { role: "gateway", name: "Eliza Cloud Maps", operator: "Eliza Cloud" },
        { role: "search", name: "Nominatim", operator: "Eliza Cloud" },
        { role: "routing", name: "GraphHopper", operator: "Eliza Cloud" },
      ],
      cloudRecords: "operation-and-result-code",
    });
    expect(coverage?.capabilities.modes).toEqual(["drive", "walk", "bicycle"]);
  });

  test("operator settings choose identity, operator, attribution and served modes", () => {
    const coverage = mapsProviderFromEnv({
      ...BASE,
      ELIZA_MAPS_ROUTER_PROFILES: '{"walk":"foot","bicycle":"bike"}',
      ELIZA_MAPS_PROVIDER_ID: "acme-maps",
      ELIZA_MAPS_OPERATOR: "Acme Hosting",
      ELIZA_MAPS_ATTRIBUTION:
        "© OpenStreetMap contributors (ODbL). Search and routing: Acme.",
      ELIZA_MAPS_ROUTE_ALTERNATIVES: "false",
    })?.coverage();
    expect(coverage?.providerId).toBe("acme-maps");
    expect(coverage?.connectionId).toMatch(/^conn_[A-Za-z0-9_-]{16,}$/);
    expect(coverage?.attribution).toContain("Acme");
    expect(
      coverage?.disclosure.recipients.map((recipient) => recipient.operator),
    ).toEqual(["Eliza Cloud", "Acme Hosting", "Acme Hosting"]);
    expect(coverage?.capabilities.modes).toEqual(["walk", "bicycle"]);
    expect(coverage?.capabilities.alternatives).toBe(false);
  });

  test("invalid settings throw without echoing their values", () => {
    for (const env of [
      { ...BASE, ELIZA_MAPS_ROUTER: "osrm" },
      { ...BASE, ELIZA_MAPS_GEOCODER: "photon" },
      { ...BASE, ELIZA_MAPS_PROVIDER: "secret-provider" },
      { ...BASE, ELIZA_MAPS_ROUTER_PROFILES: '{"transit":"pt"}' },
      { ...BASE, ELIZA_MAPS_ROUTER_URL: "http://router.example.test" },
      {
        ...BASE,
        ELIZA_MAPS_GEOCODER_URL: "https://user:pw@geocoder.example.test",
      },
      { ...BASE, ELIZA_MAPS_PROVIDER_ID: "Not Valid!" },
    ]) {
      let message = "";
      try {
        mapsProviderFromEnv(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/ELIZA_MAPS_/);
      expect(message).not.toContain("pw@");
      expect(message).not.toContain("secret-provider");
    }
    expect(() => parseRouterProfiles("[]")).toThrow();
    expect(() => parseRouterProfiles("{}")).toThrow();
  });

  test("a registered geocoder serves search through the same coverage rules", async () => {
    const outside = { latitude: 48.8566, longitude: 2.3522 };
    const geocoder: MapsGeocoderBackend = {
      kind: "fixture-geocoder",
      serviceName: "Fixture Search",
      search: async () => [
        { id: "fx:1", name: "Casino", coordinate: CASINO },
        { id: "fx:2", name: "Elsewhere", coordinate: outside },
      ],
      reverse: async () => null,
      details: async (id) =>
        id === "fx:1"
          ? { id, name: "Casino", coordinate: CASINO }
          : id === "fx:2"
            ? { id, name: "Elsewhere", coordinate: outside }
            : null,
    };
    const remove = registerMapsGeocoder("fixture-geocoder", () => geocoder);
    try {
      const provider = mapsProviderFromEnv({
        ...BASE,
        ELIZA_MAPS_GEOCODER: "fixture-geocoder",
      });
      expect(provider?.coverage().sources.search).toBe("Fixture Search");
      expect(provider?.coverage().attribution).toBe(
        "© OpenStreetMap contributors (ODbL). Search: Fixture Search. Routing: GraphHopper.",
      );
      const places = await provider?.search({ query: "Casino" });
      expect(places?.map((place) => place.id)).toEqual(["fx:1"]);
      expect((await provider?.details({ id: "fx:1" }))?.name).toBe("Casino");
      expect(await provider?.details({ id: "fx:9" })).toBeNull();
      // Details, like search, serve only places inside the configured coverage.
      await expect(provider?.details({ id: "fx:2" })).rejects.toMatchObject({
        code: "unsupported_region",
      });
    } finally {
      remove();
    }
    expect(() =>
      mapsProviderFromEnv({ ...BASE, ELIZA_MAPS_GEOCODER: "fixture-geocoder" }),
    ).toThrow();
  });

  test("a registered provider kind replaces the OSM composition", () => {
    const remove = registerMapsProvider("fixture-provider", () => null);
    try {
      expect(
        mapsProviderFromEnv({
          ...BASE,
          ELIZA_MAPS_PROVIDER: "fixture-provider",
        }),
      ).toBeNull();
      expect(() =>
        registerMapsProvider("fixture-provider", () => null),
      ).toThrow();
    } finally {
      remove();
    }
  });
});

describe("Valhalla router", () => {
  test("decodes polyline6 shapes and refuses truncated ones", () => {
    const encoded = polyline6([
      [43.7397, 7.4276],
      [-33.86882, 151.20929],
    ]);
    expect(decodePolyline6(encoded)).toEqual([
      { latitude: 43.7397, longitude: 7.4276 },
      { latitude: -33.86882, longitude: 151.20929 },
    ]);
    expect(() => decodePolyline6(encoded.slice(0, -1))).toThrow();
  });

  test("routes map Valhalla trips with alternatives to device routes", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({
        trip: VALHALLA_TRIP(307),
        alternates: [{ trip: VALHALLA_TRIP(340) }],
      }),
    );
    const provider = mapsProviderFromEnv(
      { ...BASE, ELIZA_MAPS_ROUTER: "valhalla" },
      fetchImpl,
    );
    expect(provider?.coverage().sources.routing).toBe("Valhalla");
    const routes = await provider?.routes({
      from: CASINO,
      to: PORT,
      mode: "walk",
      alternatives: true,
    });
    expect(routes?.map((route) => route.distanceMeters)).toEqual([307, 340]);
    const [route] = routes ?? [];
    expect(route?.providerId).toBe("eliza-cloud-osm");
    expect(route?.durationSeconds).toBeCloseTo(223.6);
    expect(route?.geometry[0]).toEqual(CASINO);
    expect(route?.steps.map((step) => step.maneuver)).toEqual([
      "depart",
      "left",
      undefined,
      "arrive",
    ]);
    expect(route?.steps[1]?.distanceMeters).toBeCloseTo(180);
    expect(route?.traffic).toBe("none");
    expect(routes?.[0]?.id).not.toBe(routes?.[1]?.id);
    // Coordinates travel only in the POST body.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/route");
    expect(calls[0]?.url.search).toBe("");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.costing).toBe("pedestrian");
    expect(body.alternates).toBe(2);
    expect(body.locations[0]).toEqual({
      lat: CASINO.latitude,
      lon: CASINO.longitude,
    });
  });

  test("unroutable points, malformed trips and outages are typed", async () => {
    const respond = (response: () => Response) =>
      mapsProviderFromEnv(
        { ...BASE, ELIZA_MAPS_ROUTER: "valhalla" },
        recordingFetch(response).fetchImpl,
      );
    const request = { from: CASINO, to: PORT, mode: "drive" as const };
    await expect(
      respond(() =>
        Response.json(
          { error_code: 171, error: "No suitable edges near location" },
          { status: 400 },
        ),
      )?.routes(request),
    ).rejects.toMatchObject({ code: "no_route" });
    for (const body of [
      {},
      { trip: { legs: [], summary: { length: 1, time: 1 } } },
    ]) {
      await expect(
        respond(() => Response.json(body))?.routes(request),
      ).rejects.toMatchObject({
        code: "provider_invalid_response",
      });
    }
    await expect(
      respond(() => new Response("busy", { status: 503 }))?.routes(request),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      retryAfterSeconds: 30,
    });
    await expect(
      respond(() => Response.json({}))?.routes({ ...request, mode: "transit" }),
    ).rejects.toMatchObject({ code: "unsupported_mode" });
  });
});

describe("Maps route with a configured backend", () => {
  const deps = (
    provider: MapsRouteDependencies["provider"],
  ): MapsRouteDependencies => ({
    authenticate: async () => ({
      id: "91000000-0000-4000-8000-000000000001",
      organization_id: "92000000-0000-4000-8000-000000000001",
    }),
    entitlement: async () => ({
      entitled: true,
      planKey: "plus",
      planEffectiveUntil: null,
    }),
    admit: async () => ({ allowed: true }),
    provider,
  });
  const call = (
    operation: "coverage" | "details" | "routes",
    d: MapsRouteDependencies,
    body?: unknown,
  ) =>
    createMapsRoute(operation, d).request("/", {
      method: operation === "coverage" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("capabilities carry the disclosure; details ids are the geocoder's own", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json([]));
    const configured = () => mapsProviderFromEnv(BASE, fetchImpl);
    const coverage = (await (
      await call("coverage", deps(configured))
    ).json()) as {
      disclosure: { cloudRecords: string };
    };
    expect(coverage.disclosure.cloudRecords).toBe("operation-and-result-code");
    // An opaque id that Nominatim did not issue is refused before any upstream call.
    const refused = await call("details", deps(configured), { id: "fx:1" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "invalid_request",
    );
    expect(calls).toHaveLength(0);
    expect(
      (await call("details", deps(configured), { id: "N42" })).status,
    ).toBe(200);
    expect(calls[0]?.url.searchParams.get("osm_ids")).toBe("N42");
  });

  test("an invalid configuration is reported as not configured and logs no values", async () => {
    const error = spyOn(logger, "error");
    try {
      const response = await call(
        "routes",
        deps(() =>
          mapsProviderFromEnv({
            ...BASE,
            ELIZA_MAPS_ROUTER_PROFILES: "{secret",
          }),
        ),
        { from: CASINO, to: PORT, mode: "walk" },
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe(
        "maps_not_configured",
      );
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).not.toContain("{secret");
      expect(logged).not.toContain(String(CASINO.latitude));
    } finally {
      error.mockRestore();
    }
  });

  test("an unauthenticated caller never reaches provider construction", async () => {
    let built = false;
    const response = await createMapsRoute("coverage", {
      ...deps(() => {
        built = true;
        return null;
      }),
      authenticate: async () => {
        throw AuthenticationError("Authentication required");
      },
    }).request("/");
    expect(response.status).toBe(401);
    expect(built).toBe(false);
  });
});
