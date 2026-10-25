/**
 * Route contracts for Eliza Cloud Maps. The route handler, rate limiter and
 * OSM provider are the real modules; authentication, entitlement and the
 * Nominatim/GraphHopper upstreams are stubbed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { MapsOperation } from "@elizaos/cloud-shared/lib/services/maps/contract";
import { OsmMapsProvider } from "@elizaos/cloud-shared/lib/services/maps/osm-provider";
import { resetPlanRequestLimiterForTests } from "@elizaos/cloud-shared/lib/services/plan-request-limiter";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import {
  admitMapsByPlanBuckets,
  createMapsRoute,
  type MapsRouteDependencies,
} from "../src/lib/maps-route";

const USER = {
  id: "91000000-0000-4000-8000-000000000001",
  organization_id: "92000000-0000-4000-8000-000000000001",
};
const MONACO = {
  id: "monaco",
  name: "Monaco",
  bounds: [7.409, 43.724, 7.449, 43.752] as [number, number, number, number],
};
const CASINO = { latitude: 43.7397, longitude: 7.4276 };
const PORT = { latitude: 43.7347, longitude: 7.4206 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const ENV = { NODE_ENV: "test" };
const ENTITLED = {
  entitled: true,
  planKey: "plus_monthly",
  planEffectiveUntil: "2099-01-01T00:00:00.000Z",
};
let ip = 0;

type Upstream = (url: URL, init: RequestInit) => Response | Promise<Response>;

function provider(upstream: Upstream, calls: URL[] = []) {
  return new OsmMapsProvider({
    geocoderUrl: "https://nominatim.example.test",
    routerUrl: "https://graphhopper.example.test",
    revision: "osm-monaco-2026-09-29",
    regions: [MONACO],
    alternatives: true,
    now: () => 1_760_000_000_000,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      return upstream(url, init ?? {});
    }) as typeof fetch,
  });
}

function deps(
  overrides: Partial<MapsRouteDependencies> = {},
  upstream: Upstream = () => Response.json([]),
) {
  return {
    authenticate: async () => USER,
    entitlement: async () => ENTITLED,
    admit: async () => ({ allowed: true as const }),
    provider: () => provider(upstream),
    ...overrides,
  } satisfies MapsRouteDependencies;
}

function call(
  operation: MapsOperation,
  dependencies: MapsRouteDependencies,
  body?: unknown,
) {
  ip += 1;
  return createMapsRoute(operation, dependencies).request(
    "/",
    {
      method: operation === "coverage" ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `203.0.113.${ip}`,
        authorization: `Bearer eliza_maps_test_${ip}`,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    ENV,
  );
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read nested JSON response fields.
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const NOMINATIM_CASINO = {
  osm_type: "node",
  osm_id: 1234,
  lat: String(CASINO.latitude),
  lon: String(CASINO.longitude),
  name: "Casino de Monte-Carlo",
  display_name: "Casino de Monte-Carlo, Place du Casino, Monaco",
  extratags: {
    phone: "+377 98 06 21 21",
    website: "https://www.montecarlosbm.com",
    opening_hours: "Mo-Su 14:00-02:00",
  },
};

const GRAPHHOPPER_PATH = (distance: number) => ({
  distance,
  time: 120_000,
  points: {
    coordinates: [
      [CASINO.longitude, CASINO.latitude],
      [7.424, 43.737],
      [PORT.longitude, PORT.latitude],
    ],
  },
  instructions: [
    {
      text: "Continue onto Place du Casino",
      distance: distance / 2,
      interval: [0, 1],
      sign: 0,
    },
    {
      text: "Turn left onto Avenue d'Ostende",
      distance: distance / 2,
      interval: [1, 2],
      sign: -2,
    },
    { text: "Arrive at destination", distance: 0, interval: [2, 2], sign: 4 },
  ],
});

describe("Eliza Cloud Maps routes", () => {
  test("route identity binds geometry even when summary statistics match", async () => {
    let changed = false;
    const maps = provider(() => {
      const path = GRAPHHOPPER_PATH(500);
      if (changed) path.points.coordinates[1] = [7.425, 43.738];
      return Response.json({ paths: [path] });
    });
    const request = { from: CASINO, to: PORT, mode: "walk" as const };
    const [first] = await maps.routes(request);
    const [replay] = await maps.routes(request);
    expect(replay.id).toBe(first.id);
    changed = true;
    const [second] = await maps.routes(request);
    expect(second.id).not.toBe(first.id);
  });

  test("malformed route collections and unexpected reverse errors remain failures", async () => {
    for (const body of [{}, { paths: null }, { paths: "invalid" }]) {
      const response = await call(
        "routes",
        deps({}, () => Response.json(body)),
        {
          from: CASINO,
          to: PORT,
          mode: "walk",
        },
      );
      expect(response.status).toBe(502);
      expect((await json(response)).code).toBe("provider_invalid_response");
    }
    const response = await call(
      "reverse",
      deps({}, () => Response.json({ error: "Database unavailable" })),
      { coordinate: CASINO },
    );
    expect(response.status).toBe(502);
    expect((await json(response)).code).toBe("provider_invalid_response");
  });
  test("refuses an unauthenticated caller before any provider work", async () => {
    let providerRead = false;
    const res = await call(
      "coverage",
      deps({
        authenticate: async () => {
          throw AuthenticationError("Authentication required");
        },
        provider: () => {
          providerRead = true;
          return null;
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(providerRead).toBe(false);
  });

  test("reports an unprovisioned service honestly", async () => {
    const res = await call("geocode", deps({ provider: () => null }), {
      query: "Casino",
    });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("maps_not_configured");
  });

  test("requires an active subscription and never calls the provider without one", async () => {
    const calls: URL[] = [];
    const res = await call(
      "search",
      deps({
        entitlement: async () => ({ ...ENTITLED, entitled: false }),
        provider: () => provider(() => Response.json([]), calls),
      }),
      { query: "Casino" },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("subscription_required");
    expect(calls).toHaveLength(0);
  });

  test("an entitlement outage refuses the request", async () => {
    const res = await call(
      "search",
      deps({
        entitlement: async () => {
          throw new Error("database unavailable");
        },
      }),
      { query: "Casino" },
    );
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("entitlement_unavailable");
  });

  test("the admission hook receives the account and operation and can refuse", async () => {
    const seen: unknown[] = [];
    const res = await call(
      "routes",
      deps({
        admit: async (request) => {
          seen.push(request);
          return { allowed: false, retryAfterSeconds: 42 };
        },
      }),
      { from: CASINO, to: PORT, mode: "walk" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect((await json(res)).retryAfterSeconds).toBe(42);
    expect(seen).toEqual([
      {
        organizationId: USER.organization_id,
        userId: USER.id,
        operation: "routes",
        planKey: ENTITLED.planKey,
        planEffectiveUntil: ENTITLED.planEffectiveUntil,
      },
    ]);
  });

  test("the plan buckets limit Maps per plan, apart from inference buckets", async () => {
    const previous = process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS;
    resetPlanRequestLimiterForTests();
    process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS = JSON.stringify({
      selected: false,
      plans: {
        default: {
          burst: { capacity: 1, refillPerSecond: 0.001 },
          sustained: { capacity: 10, refillPerSecond: 0.001 },
        },
        plus_monthly: {
          burst: { capacity: 2, refillPerSecond: 0.001 },
          sustained: { capacity: 10, refillPerSecond: 0.001 },
        },
      },
    });
    try {
      const dependencies = deps({ admit: admitMapsByPlanBuckets });
      expect((await call("coverage", dependencies)).status).toBe(200);
      expect((await call("coverage", dependencies)).status).toBe(200);
      const refused = await call("coverage", dependencies);
      expect(refused.status).toBe(429);
      const body = await json(refused);
      expect(body.code).toBe("rate_limited");
      expect(body.retryAfterSeconds).toBe(
        Number(refused.headers.get("retry-after")),
      );
      // An expired plan window falls back to the default plan's own buckets.
      const lapsed = deps({
        admit: admitMapsByPlanBuckets,
        entitlement: async () => ({
          ...ENTITLED,
          planEffectiveUntil: "2000-01-01T00:00:00.000Z",
        }),
      });
      expect((await call("coverage", lapsed)).status).toBe(200);
      expect((await call("coverage", lapsed)).status).toBe(429);
    } finally {
      if (previous === undefined)
        delete process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS;
      else process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS = previous;
      resetPlanRequestLimiterForTests();
    }
  });

  test("coverage lists regions, modes and attribution", async () => {
    const res = await call("coverage", deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.providerId).toBe("eliza-cloud-osm");
    expect(body.attribution).toContain("OpenStreetMap");
    expect(body.regions).toEqual([MONACO]);
    expect(body.capabilities.modes).toEqual(["drive", "walk", "bicycle"]);
    expect(body.capabilities.transit).toBe("none");
  });

  test("place search returns attributed places and drops results outside coverage", async () => {
    const calls: URL[] = [];
    const res = await call(
      "search",
      deps({
        provider: () =>
          provider(
            () =>
              Response.json([
                NOMINATIM_CASINO,
                {
                  ...NOMINATIM_CASINO,
                  osm_id: 99,
                  lat: String(PARIS.latitude),
                  lon: String(PARIS.longitude),
                },
                { ...NOMINATIM_CASINO, osm_type: undefined, osm_id: undefined },
              ]),
            calls,
          ),
      }),
      { query: "Casino", near: CASINO, limit: 5 },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.attribution).toContain("OpenStreetMap");
    expect(body.places).toEqual([
      {
        providerId: "eliza-cloud-osm",
        id: "N1234",
        name: "Casino de Monte-Carlo",
        coordinate: CASINO,
        address: "Casino de Monte-Carlo, Place du Casino, Monaco",
        attribution: body.attribution,
        fetchedAt: 1_760_000_000_000,
      },
    ]);
    expect(calls[0]?.pathname).toBe("/search");
    expect(calls[0]?.searchParams.get("limit")).toBe("5");
    expect(calls[0]?.searchParams.has("layer")).toBe(false);
  });

  test("geocode restricts Nominatim to addresses", async () => {
    const calls: URL[] = [];
    await call(
      "geocode",
      deps({ provider: () => provider(() => Response.json([]), calls) }),
      {
        query: "Place du Casino",
      },
    );
    expect(calls[0]?.searchParams.get("layer")).toBe("address");
    expect(calls[0]?.searchParams.get("addressdetails")).toBe("1");
  });

  test("an unnamed address is named by its house number and street", async () => {
    const res = await call(
      "geocode",
      deps({
        provider: () =>
          provider(() =>
            Response.json([
              {
                ...NOMINATIM_CASINO,
                osm_type: "way",
                osm_id: 555,
                name: "",
                display_name: "12, Place du Casino, Monte-Carlo, Monaco",
                address: { house_number: "12", road: "Place du Casino" },
              },
            ]),
          ),
      }),
      { query: "12 Place du Casino" },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).places).toMatchObject([
      {
        id: "W555",
        name: "12 Place du Casino",
        address: "12, Place du Casino, Monte-Carlo, Monaco",
      },
    ]);
  });

  for (const fixture of [
    {
      display_name: "A12, High Street, Monaco",
      address: { house_number: "A12", road: "High Street" },
      expected: "A12 High Street",
    },
    {
      display_name: "12345678901, High Street, Monaco",
      address: { house_number: "12345678901", road: "High Street" },
      expected: "12345678901 High Street",
    },
    {
      display_name: "12th Street, Monaco",
      address: { road: "12th Street" },
      expected: "12th Street",
    },
    {
      display_name: "12, Monaco",
      address: { house_number: "12" },
      expected: "12",
    },
    {
      display_name: "12, High Street, Monaco",
      address: { house_number: {}, road: "High Street" },
      expected: "12",
    },
  ]) {
    test(`address labels use explicit components for ${fixture.display_name}`, async () => {
      const res = await call(
        "geocode",
        deps({
          provider: () =>
            provider(() =>
              Response.json([
                {
                  ...NOMINATIM_CASINO,
                  name: "",
                  display_name: fixture.display_name,
                  address: fixture.address,
                },
              ]),
            ),
        }),
        { query: fixture.display_name },
      );
      expect(res.status).toBe(200);
      expect((await json(res)).places).toMatchObject([
        { name: fixture.expected, address: fixture.display_name },
      ]);
    });
  }

  test("details and reverse include verified source extras or an honest null", async () => {
    const details = await json(
      await call(
        "details",
        deps({
          provider: () => provider(() => Response.json([NOMINATIM_CASINO])),
        }),
        {
          id: "N1234",
        },
      ),
    );
    expect(details.place).toMatchObject({
      id: "N1234",
      phone: "+377 98 06 21 21",
      website: "https://www.montecarlosbm.com",
      openingHours: "Mo-Su 14:00-02:00",
    });
    const empty = await json(
      await call(
        "reverse",
        deps({
          provider: () =>
            provider(() => Response.json({ error: "Unable to geocode" })),
        }),
        { coordinate: CASINO },
      ),
    );
    expect(empty.place).toBeNull();
    expect(empty.attribution).toContain("OpenStreetMap");
  });

  test("malformed route values return a typed provider failure, never zero coordinates or a server crash", async () => {
    for (const path of [
      null,
      { ...GRAPHHOPPER_PATH(600), distance: " " },
      { ...GRAPHHOPPER_PATH(600), instructions: [null] },
      {
        ...GRAPHHOPPER_PATH(600),
        points: {
          coordinates: [
            ["", " "],
            [7.4206, 43.7347],
          ],
        },
      },
    ]) {
      const res = await call(
        "routes",
        deps({
          provider: () => provider(() => Response.json({ paths: [path] })),
        }),
        { from: CASINO, to: PORT, mode: "drive" },
      );
      expect(res.status).toBe(502);
      expect((await json(res)).code).toBe("provider_invalid_response");
    }
  });

  test("routes map GraphHopper paths to device routes with alternatives", async () => {
    let routerBody: Record<string, unknown> | undefined;
    const res = await call(
      "routes",
      deps({
        provider: () =>
          provider((url, init) => {
            expect(url.pathname).toBe("/route");
            routerBody = JSON.parse(String(init.body));
            return Response.json({
              paths: [GRAPHHOPPER_PATH(600), GRAPHHOPPER_PATH(700)],
            });
          }),
      }),
      { from: CASINO, to: PORT, mode: "drive", alternatives: true },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(routerBody).toMatchObject({
      profile: "car",
      algorithm: "alternative_route",
      points_encoded: false,
    });
    expect(body.routes).toHaveLength(2);
    const [route] = body.routes;
    expect(route).toMatchObject({
      providerId: "eliza-cloud-osm",
      from: CASINO,
      to: PORT,
      mode: "drive",
      distanceMeters: 600,
      durationSeconds: 120,
      traffic: "none",
      attribution: body.attribution,
    });
    expect(route.id).toMatch(/^route_[0-9a-f]{24}$/);
    expect(
      route.steps.map((step: { maneuver?: string }) => step.maneuver),
    ).toEqual(["depart", "left", "arrive"]);
    expect(route.geometry[1]).toEqual({ latitude: 43.737, longitude: 7.424 });
  });

  test("unsupported regions and modes are refused without a provider call", async () => {
    const calls: URL[] = [];
    const dependencies = deps({
      provider: () => provider(() => Response.json({}), calls),
    });
    const outside = await call("routes", dependencies, {
      from: CASINO,
      to: PARIS,
      mode: "walk",
    });
    expect(outside.status).toBe(422);
    expect((await json(outside)).code).toBe("unsupported_region");
    const reverse = await call("reverse", dependencies, { coordinate: PARIS });
    expect((await json(reverse)).code).toBe("unsupported_region");
    const transit = await call("routes", dependencies, {
      from: CASINO,
      to: PORT,
      mode: "transit",
    });
    expect(transit.status).toBe(422);
    expect((await json(transit)).code).toBe("unsupported_mode");
    expect(calls).toHaveLength(0);
  });

  test("a provider outage is a 503 with Retry-After and logs no location", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const res = await call(
        "routes",
        deps({
          provider: () => provider(() => new Response("down", { status: 502 })),
        }),
        { from: CASINO, to: PORT, mode: "walk" },
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
      expect((await json(res)).code).toBe("provider_unavailable");
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("provider_unavailable");
      expect(logged).not.toContain(String(CASINO.latitude));
      expect(logged).not.toContain(String(PORT.longitude));
    } finally {
      warn.mockRestore();
    }
  });

  test("unroutable endpoints and malformed upstream bodies are typed failures", async () => {
    const noRoute = await call(
      "routes",
      deps({
        provider: () =>
          provider(() =>
            Response.json({ message: "Cannot find point" }, { status: 400 }),
          ),
      }),
      { from: CASINO, to: PORT, mode: "bicycle" },
    );
    expect((await json(noRoute)).code).toBe("no_route");
    const malformed = await call(
      "search",
      deps({
        provider: () => provider(() => new Response("<html>", { status: 200 })),
      }),
      { query: "Casino" },
    );
    expect(malformed.status).toBe(502);
    expect((await json(malformed)).code).toBe("provider_invalid_response");
  });

  test("rejects invalid bodies", async () => {
    expect((await call("search", deps(), "{")).status).toBe(400);
    expect((await call("search", deps(), { query: "" })).status).toBe(400);
    expect((await call("details", deps(), { id: "../etc" })).status).toBe(400);
    expect(
      (
        await call("routes", deps(), {
          from: CASINO,
          to: { latitude: 91, longitude: 0 },
          mode: "walk",
        })
      ).status,
    ).toBe(400);
  });
});
