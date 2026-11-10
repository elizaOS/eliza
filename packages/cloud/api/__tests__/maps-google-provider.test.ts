/**
 * The Google Maps Platform provider: Places API (New), Geocoding API, Routes
 * API and Map Tiles API answer the provider-neutral Maps contract with a
 * server-held key. Every Google upstream is a mocked fetch.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type MapsProviderAdapter,
  MapsServiceError,
} from "@elizaos/cloud-shared/lib/services/maps/contract";
import { clearGoogleTileSessions } from "@elizaos/cloud-shared/lib/services/maps/google-provider";
import { mapsProviderFromEnv } from "@elizaos/cloud-shared/lib/services/maps/provider-registry";
import {
  createMapsRoute,
  type MapsRouteDependencies,
} from "../src/lib/maps-route";

const KEY = "AIzaSyTEST_server_key_0123456789abcd";
const ENV = { ELIZA_MAPS_PROVIDER: "google", GOOGLE_MAPS_API_KEY: KEY };
const CASINO = { latitude: 43.7397, longitude: 7.4276 };
const PORT = { latitude: 43.7347, longitude: 7.4206 };
const PLACE_ID = "ChIJMYU_e2_CzRIR_JzEOkx493Q";
const NOW = 1_760_000_000_000;

interface Call {
  url: URL;
  init: RequestInit;
  headers: Headers;
  body: unknown;
}

function recordingFetch(
  respond: (url: URL, call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url,
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(url, call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function google(
  respond: (url: URL, call: Call) => Response | Promise<Response>,
  env: Record<string, unknown> = {},
) {
  const { calls, fetchImpl } = recordingFetch(respond);
  const provider = mapsProviderFromEnv(
    { ...ENV, ...env },
    fetchImpl,
  ) as MapsProviderAdapter;
  return { calls, provider };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MapsServiceError) return error.code;
    throw error;
  }
  throw new Error("Expected a MapsServiceError");
}

/** Encodes coordinates as a precision-5 polyline (Google's encoding). */
function polyline5(points: Array<[number, number]>): string {
  const last = [0, 0];
  let out = "";
  for (const [lat, lon] of points) {
    for (const [index, value] of [
      Math.round(lat * 1e5),
      Math.round(lon * 1e5),
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

const ROUTE = (meters: number) => ({
  distanceMeters: meters,
  duration: "223s",
  polyline: {
    encodedPolyline: polyline5([
      [CASINO.latitude, CASINO.longitude],
      [43.737, 7.424],
      [PORT.latitude, PORT.longitude],
    ]),
  },
  legs: [
    {
      steps: [
        {
          distanceMeters: 120,
          startLocation: { latLng: CASINO },
          navigationInstruction: {
            maneuver: "DEPART",
            instructions: "Head south on Avenue des Beaux-Arts",
          },
        },
        {
          distanceMeters: 180,
          startLocation: { latLng: { latitude: 43.737, longitude: 7.424 } },
          navigationInstruction: {
            maneuver: "TURN_LEFT",
            instructions: "Turn left onto Boulevard Albert 1er",
          },
        },
        {
          distanceMeters: 5,
          startLocation: { latLng: PORT },
          navigationInstruction: {
            maneuver: "FERRY",
            instructions: "Take the ferry",
          },
        },
      ],
    },
  ],
});

beforeEach(() => clearGoogleTileSessions());

describe("Google Maps provider configuration", () => {
  test("is absent without a server key and refuses an invalid key", () => {
    expect(mapsProviderFromEnv({ ELIZA_MAPS_PROVIDER: "google" })).toBeNull();
    expect(() =>
      mapsProviderFromEnv({ ...ENV, GOOGLE_MAPS_API_KEY: "short" }),
    ).toThrow("GOOGLE_MAPS_API_KEY is invalid");
    expect(() =>
      mapsProviderFromEnv({ ...ENV, ELIZA_MAPS_LANGUAGE: "en US" }),
    ).toThrow("ELIZA_MAPS_LANGUAGE is invalid");
  });

  test("coverage stays inside the device contract and discloses Google", () => {
    const coverage = google(() => Response.json({})).provider.coverage();
    expect(coverage.providerId).toBe("eliza-cloud-google");
    expect(coverage.connectionId).toMatch(/^conn_[A-Za-z0-9_-]{16,}$/);
    expect(coverage.regions).toEqual([
      { id: "world", name: "World", bounds: [-180, -85.0511, 180, 85.0511] },
    ]);
    expect(coverage.capabilities).toMatchObject({
      map: true,
      modes: ["drive", "walk", "bicycle", "transit"],
      traffic: "live",
      transit: "scheduled",
      alternatives: true,
    });
    expect(coverage.sources).toEqual({
      data: "Google Maps",
      search: "Google Places API",
      routing: "Google Routes API",
    });
    expect(coverage.disclosure.recipients.map((r) => r.operator)).toEqual([
      "Eliza Cloud",
      "Google",
      "Google",
    ]);
    expect(coverage.tiles).toMatchObject({
      urlTemplate: "/api/v1/maps/tiles/{z}/{x}/{y}",
      mapType: "roadmap",
    });
    expect(JSON.stringify(coverage)).not.toContain(KEY);
    const noTiles = google(() => Response.json({}), {
      ELIZA_MAPS_TILES: "false",
    });
    expect(noTiles.provider.coverage().tiles).toBeUndefined();
  });
});

describe("Google Places and Geocoding", () => {
  test("search posts the query with the key in a header and a basic field mask", async () => {
    const { calls, provider } = google(
      () =>
        Response.json({
          places: [
            {
              id: PLACE_ID,
              displayName: {
                text: "Casino de Monte-Carlo",
                languageCode: "fr",
              },
              formattedAddress: "Place du Casino, 98000 Monaco",
              location: CASINO,
            },
            // Outside the configured coverage: dropped.
            {
              id: "ChIJD7fiBh9u5kcRYJSMaMOCCwQ",
              displayName: { text: "Paris" },
              location: { latitude: 48.8566, longitude: 2.3522 },
            },
          ],
        }),
      {
        ELIZA_MAPS_COVERAGE_JSON: JSON.stringify([
          {
            id: "monaco",
            name: "Monaco",
            bounds: [7.409, 43.724, 7.449, 43.752],
          },
        ]),
        ELIZA_MAPS_LANGUAGE: "fr-FR",
      },
    );
    const places = await provider.search({
      query: "casino",
      near: CASINO,
      limit: 5,
    });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      providerId: "eliza-cloud-google",
      id: PLACE_ID,
      name: "Casino de Monte-Carlo",
      address: "Place du Casino, 98000 Monaco",
      coordinate: CASINO,
      attribution: "Google Maps",
    });
    const [call] = calls;
    expect(call.url.toString()).toBe(
      "https://places.googleapis.com/v1/places:searchText",
    );
    expect(call.url.search).toBe("");
    expect(call.init.method).toBe("POST");
    expect(call.headers.get("x-goog-api-key")).toBe(KEY);
    expect(call.headers.get("x-goog-fieldmask")).toBe(
      "places.id,places.displayName,places.formattedAddress,places.location",
    );
    expect(call.body).toEqual({
      textQuery: "casino",
      pageSize: 5,
      languageCode: "fr-FR",
      locationBias: { circle: { center: CASINO, radius: 50_000 } },
    });
  });

  test("an empty search is no places, not an error", async () => {
    const { provider } = google(() => Response.json({}));
    expect(await provider.search({ query: "nowhere at all" })).toEqual([]);
  });

  test("details reads one place with contact fields; an unknown id is null", async () => {
    const { calls, provider } = google((url) =>
      url.pathname.endsWith(PLACE_ID)
        ? Response.json({
            id: PLACE_ID,
            displayName: { text: "Casino de Monte-Carlo" },
            formattedAddress: "Place du Casino, 98000 Monaco",
            location: CASINO,
            websiteUri: "https://www.montecarlosbm.com/",
            internationalPhoneNumber: "+377 98 06 21 21",
            regularOpeningHours: {
              weekdayDescriptions: ["Monday: 2:00 PM – 2:00 AM"],
            },
          })
        : Response.json(
            { error: { code: 404, status: "NOT_FOUND" } },
            { status: 404 },
          ),
    );
    const place = await provider.details({ id: PLACE_ID });
    expect(place).toMatchObject({
      id: PLACE_ID,
      website: "https://www.montecarlosbm.com/",
      phone: "+377 98 06 21 21",
      openingHours: "Monday: 2:00 PM – 2:00 AM",
    });
    expect(calls[0].url.toString()).toBe(
      `https://places.googleapis.com/v1/places/${PLACE_ID}`,
    );
    expect(calls[0].headers.get("x-goog-fieldmask")).toContain(
      "internationalPhoneNumber",
    );
    expect(
      await provider.details({ id: "ChIJ_unknown_place_0000" }),
    ).toBeNull();
    expect(await refusal(provider.details({ id: "node:1234" }))).toBe(
      "invalid_request",
    );
  });

  test("geocode and reverse use the Geocoding API and map its status codes", async () => {
    const statuses: string[] = [
      "OK",
      "OK",
      "ZERO_RESULTS",
      "REQUEST_DENIED",
      "INVALID_REQUEST",
    ];
    const { calls, provider } = google(() =>
      Response.json({
        status: statuses.shift(),
        results: [
          {
            place_id: PLACE_ID,
            formatted_address: "Place du Casino, 98000 Monaco",
            geometry: {
              location: { lat: CASINO.latitude, lng: CASINO.longitude },
            },
          },
        ],
      }),
    );
    const places = await provider.geocode({
      query: "Place du Casino",
      near: CASINO,
    });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      id: PLACE_ID,
      name: "Place du Casino",
      address: "Place du Casino, 98000 Monaco",
    });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(
      "https://maps.googleapis.com/maps/api/geocode/json",
    );
    expect(calls[0].url.searchParams.get("address")).toBe("Place du Casino");
    expect(calls[0].url.searchParams.get("key")).toBe(KEY);
    expect(calls[0].url.searchParams.get("bounds")).toBe(
      `${CASINO.latitude - 0.25},${CASINO.longitude - 0.25}|${CASINO.latitude + 0.25},${CASINO.longitude + 0.25}`,
    );
    const place = await provider.reverse({ coordinate: CASINO });
    expect(place?.id).toBe(PLACE_ID);
    expect(calls[1].url.searchParams.get("latlng")).toBe(
      `${CASINO.latitude},${CASINO.longitude}`,
    );
    expect(await provider.reverse({ coordinate: CASINO })).toBeNull();
    expect(await refusal(provider.geocode({ query: "x" }))).toBe(
      "provider_unavailable",
    );
    expect(await refusal(provider.geocode({ query: "x" }))).toBe(
      "provider_invalid_response",
    );
  });

  test("outages and malformed bodies are typed failures that never echo the key", async () => {
    const { provider } = google(() => new Response("busy", { status: 503 }));
    expect(await refusal(provider.search({ query: "casino" }))).toBe(
      "provider_unavailable",
    );
    const malformed = google(() =>
      Response.json({ places: [{ id: PLACE_ID }] }),
    );
    try {
      await malformed.provider.search({ query: "casino" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as MapsServiceError).code).toBe(
        "provider_invalid_response",
      );
      expect(String((error as Error).message)).not.toContain(KEY);
    }
  });
});

describe("Google Routes", () => {
  test("drive uses live traffic; steps, maneuvers and polyline5 geometry map to the contract", async () => {
    const { calls, provider } = google(() =>
      Response.json({ routes: [{ ...ROUTE(300), staticDuration: "180s" }] }),
    );
    const [route] = await provider.routes({
      from: CASINO,
      to: PORT,
      mode: "drive",
    });
    const call = calls[0];
    expect(call.url.toString()).toBe(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
    );
    expect(call.headers.get("x-goog-api-key")).toBe(KEY);
    expect(call.headers.get("x-goog-fieldmask")).toContain(
      "routes.polyline.encodedPolyline",
    );
    expect(call.body).toMatchObject({
      origin: { location: { latLng: CASINO } },
      destination: { location: { latLng: PORT } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
    });
    expect(call.body).not.toHaveProperty("departureTime");
    expect(call.headers.get("x-goog-fieldmask")).toContain(
      "routes.staticDuration",
    );
    expect(route).toMatchObject({
      providerId: "eliza-cloud-google",
      mode: "drive",
      distanceMeters: 300,
      durationSeconds: 223,
      staticDurationSeconds: 180,
      traffic: "live",
      attribution: "Google Maps",
    });
    expect(route.id).toMatch(/^route_[0-9a-f]{24}$/);
    expect(route.geometry).toEqual([
      CASINO,
      { latitude: 43.737, longitude: 7.424 },
      PORT,
    ]);
    expect(route.steps.map((step) => step.maneuver)).toEqual([
      "depart",
      "left",
      undefined,
      "arrive",
    ]);
    expect(route.steps.at(-1)?.coordinate).toEqual(PORT);
  });

  test("walk and bicycle send no routing preference; alternatives return up to three", async () => {
    const { calls, provider } = google(() =>
      Response.json({
        routes: [ROUTE(300), ROUTE(320), ROUTE(340), ROUTE(360)],
      }),
    );
    const walk = await provider.routes({
      from: CASINO,
      to: PORT,
      mode: "walk",
      alternatives: true,
    });
    expect(walk).toHaveLength(3);
    expect(new Set(walk.map((route) => route.id)).size).toBe(3);
    expect(calls[0].body).toMatchObject({
      travelMode: "WALK",
      computeAlternativeRoutes: true,
    });
    expect(calls[0].body).not.toHaveProperty("routingPreference");
    await provider.routes({ from: CASINO, to: PORT, mode: "bicycle" });
    expect(calls[1].body).toMatchObject({ travelMode: "BICYCLE" });
  });

  test("transit rides carry line, stops and times from the timetable", async () => {
    const departAt = new Date(Date.now() + 3_600_000).toISOString();
    const { calls, provider } = google(() =>
      Response.json({
        routes: [
          {
            ...ROUTE(900),
            legs: [
              {
                steps: [
                  {
                    distanceMeters: 120,
                    travelMode: "WALK",
                    startLocation: { latLng: CASINO },
                    navigationInstruction: {
                      instructions: "Walk to Casino stop",
                    },
                  },
                  {
                    distanceMeters: 780,
                    travelMode: "TRANSIT",
                    startLocation: {
                      latLng: { latitude: 43.737, longitude: 7.424 },
                    },
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "Casino" },
                        arrivalStop: { name: "Port" },
                        departureTime: "2026-11-06T21:05:00Z",
                        arrivalTime: "2026-11-06T21:12:00Z",
                      },
                      headsign: "Fontvieille",
                      stopCount: 3,
                      transitLine: {
                        name: "Ligne 1",
                        nameShort: "1",
                        color: "#E2001A",
                        vehicle: { type: "BUS", name: { text: "Bus" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const [route] = await provider.routes({
      from: CASINO,
      to: PORT,
      mode: "transit",
      departAt,
    });
    expect(calls[0].body).toMatchObject({
      travelMode: "TRANSIT",
      departureTime: departAt,
    });
    expect(calls[0].body).not.toHaveProperty("routingPreference");
    expect(calls[0].headers.get("x-goog-fieldmask")).toContain(
      "routes.legs.steps.transitDetails",
    );
    expect(route.mode).toBe("transit");
    expect(route.traffic).toBe("none");
    expect(route.steps[1]).toMatchObject({
      instruction:
        "Take the bus 1 toward Fontvieille from Casino to Port, 3 stops.",
      transit: {
        line: "1",
        vehicle: "bus",
        headsign: "Fontvieille",
        departureStop: "Casino",
        arrivalStop: "Port",
        departureTime: "2026-11-06T21:05:00Z",
        arrivalTime: "2026-11-06T21:12:00Z",
        stopCount: 3,
        color: "#e2001a",
      },
    });
    expect(route.steps[0]).not.toHaveProperty("transit");
  });

  test("traffic and transit can be turned off; a past departure is refused for live traffic", async () => {
    const { calls, provider } = google(
      () => Response.json({ routes: [ROUTE(300)] }),
      {
        ELIZA_MAPS_TRAFFIC: "none",
        ELIZA_MAPS_TRANSIT: "false",
      },
    );
    expect(provider.coverage().capabilities).toMatchObject({
      modes: ["drive", "walk", "bicycle"],
      traffic: "none",
      transit: "none",
    });
    expect(
      await refusal(
        provider.routes({ from: CASINO, to: PORT, mode: "transit" }),
      ),
    ).toBe("unsupported_mode");
    const [route] = await provider.routes({
      from: CASINO,
      to: PORT,
      mode: "drive",
    });
    expect(calls[0].body).toMatchObject({
      routingPreference: "TRAFFIC_UNAWARE",
    });
    expect(route.traffic).toBe("none");
    expect(route).not.toHaveProperty("staticDurationSeconds");
    const live = google(() => Response.json({ routes: [ROUTE(300)] }));
    expect(
      await refusal(
        live.provider.routes({
          from: CASINO,
          to: PORT,
          mode: "drive",
          departAt: "2020-01-01T00:00:00Z",
        }),
      ),
    ).toBe("invalid_request");
    expect(live.calls).toHaveLength(0);
  });

  test("empty answers and alternatives turned off are honest", async () => {
    const { calls, provider } = google(() => Response.json({}), {
      ELIZA_MAPS_ROUTE_ALTERNATIVES: "false",
    });
    expect(
      await refusal(provider.routes({ from: CASINO, to: PORT, mode: "drive" })),
    ).toBe("no_route");
    await refusal(
      provider.routes({
        from: CASINO,
        to: PORT,
        mode: "drive",
        alternatives: true,
      }),
    );
    expect(calls[1].body).toMatchObject({ computeAlternativeRoutes: false });
    expect(calls[0].body).toMatchObject({ computeAlternativeRoutes: false });
    expect(provider.coverage().capabilities.alternatives).toBe(false);
  });
});

describe("Google Map Tiles", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function tiles(tileStatus: () => number = () => 200) {
    let sessions = 0;
    return google((url) => {
      if (url.pathname === "/v1/createSession") {
        sessions += 1;
        return Response.json({
          session: `session-${sessions}`,
          expiry: String(Math.floor(Date.now() / 1000) + 14 * 24 * 3600),
          tileWidth: 256,
          imageFormat: "png",
        });
      }
      if (url.pathname === "/tile/v1/viewport")
        return Response.json({
          copyright: "Map data ©2026 Google",
          maxZoomRects: [
            { maxZoom: 19, north: 90, south: -90, east: 180, west: -180 },
            { maxZoom: 21, north: 44, south: 43, east: 8, west: 7 },
          ],
        });
      const status = tileStatus();
      return status === 200
        ? new Response(PNG, { headers: { "content-type": "image/png" } })
        : new Response("denied", { status });
    });
  }

  test("one session is created and reused for every tile", async () => {
    const { calls, provider } = tiles();
    const first = await provider.tile?.({ z: 3, x: 4, y: 2 });
    await provider.tile?.({ z: 3, x: 5, y: 2 });
    expect(first?.contentType).toBe("image/png");
    expect(new Uint8Array(first?.body ?? new ArrayBuffer(0))).toEqual(PNG);
    const sessions = calls.filter(
      (call) => call.url.pathname === "/v1/createSession",
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].body).toEqual({
      mapType: "roadmap",
      language: "en-US",
      region: "US",
    });
    const tileCall = calls.find(
      (call) => call.url.pathname === "/v1/2dtiles/3/4/2",
    );
    expect(tileCall?.url.searchParams.get("session")).toBe("session-1");
    expect(tileCall?.url.searchParams.get("key")).toBe(KEY);
  });

  test("a refused session is renewed once", async () => {
    const statuses = [403, 200];
    const { calls, provider } = tiles(() => statuses.shift() ?? 200);
    await provider.tile?.({ z: 1, x: 0, y: 1 });
    const sessions = calls.filter(
      (call) => call.url.pathname === "/v1/createSession",
    );
    expect(sessions).toHaveLength(2);
    expect(calls.at(-1)?.url.searchParams.get("session")).toBe("session-2");
  });

  test("the tiles route serves image bytes and validates the tile address", async () => {
    const { provider } = tiles();
    const dependencies: MapsRouteDependencies = {
      authenticate: async () => ({
        id: "91000000-0000-4000-8000-000000000001",
        organization_id: "92000000-0000-4000-8000-000000000001",
      }),
      entitlement: async () => ({
        entitled: true,
        planKey: "plus_monthly",
        planEffectiveUntil: null,
      }),
      admit: async () => ({ allowed: true }),
      provider: () => provider,
    };
    let ip = 10;
    const request = (path: string, deps = dependencies) => {
      ip += 1;
      return createMapsRoute("tiles", deps).request(
        path,
        { headers: { "cf-connecting-ip": `203.0.113.${ip}` } },
        { NODE_ENV: "test" },
      );
    };
    // The generated router mounts the route at /api/v1/maps/tiles/:z/:x/:y.
    const { Hono } = await import("hono");
    const mounted = (deps = dependencies) =>
      new Hono().route(
        "/api/v1/maps/tiles/:z/:x/:y",
        createMapsRoute("tiles", deps),
      );
    const ok = await mounted().request(
      "/api/v1/maps/tiles/2/1/3",
      { headers: { "cf-connecting-ip": "203.0.113.200" } },
      { NODE_ENV: "test" },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
    const jsonTile = await mounted().request(
      "/api/v1/maps/tiles/2/1/3",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.203",
          accept: "application/json",
        },
      },
      { NODE_ENV: "test" },
    );
    expect(jsonTile.status).toBe(200);
    expect(jsonTile.headers.get("cache-control")).toBe("no-store");
    expect(jsonTile.headers.get("vary")).toBe("Accept");
    const encoded = (await jsonTile.json()) as {
      encoding: string;
      contentType: string;
      data: string;
    };
    expect(encoded.encoding).toBe("base64");
    expect(encoded.contentType).toBe("image/png");
    expect(new Uint8Array(Buffer.from(encoded.data, "base64"))).toEqual(PNG);
    const oversized = await mounted({
      ...dependencies,
      provider: () => ({
        ...provider,
        coverage: () => provider.coverage(),
        tile: async () => ({
          body: new ArrayBuffer(1024 * 1024 + 1),
          contentType: "image/png",
          attribution: "Google Maps",
        }),
      }),
    }).request(
      "/api/v1/maps/tiles/2/1/3",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.204",
          accept: "application/json",
        },
      },
      { NODE_ENV: "test" },
    );
    expect(oversized.status).toBe(502);
    const outside = await mounted().request(
      "/api/v1/maps/tiles/2/4/0",
      { headers: { "cf-connecting-ip": "203.0.113.201" } },
      { NODE_ENV: "test" },
    );
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { code: string }).code).toBe(
      "invalid_request",
    );
    // Unmounted (no params) is an invalid tile address, never a provider call.
    expect((await request("/")).status).toBe(400);
    const osmLike: MapsProviderAdapter = {
      ...provider,
      tile: undefined,
      coverage: () => ({ ...provider.coverage(), tiles: undefined }),
    };
    const unconfigured = await mounted({
      ...dependencies,
      provider: () => osmLike,
    }).request(
      "/api/v1/maps/tiles/2/1/3",
      { headers: { "cf-connecting-ip": "203.0.113.202" } },
      { NODE_ENV: "test" },
    );
    expect(unconfigured.status).toBe(503);
    expect(((await unconfigured.json()) as { code: string }).code).toBe(
      "maps_not_configured",
    );
  });

  test("the viewport copyright reuses the tile session and needs no allowance key", async () => {
    const { calls, provider } = tiles();
    const view = {
      zoom: 15,
      north: 43.75,
      south: 43.72,
      east: 7.45,
      west: 7.4,
    };
    expect(await provider.viewport?.(view)).toEqual({
      providerId: "eliza-cloud-google",
      copyright: "Map data ©2026 Google",
      maxZoom: 21,
    });
    const viewportCall = calls.find(
      (call) => call.url.pathname === "/tile/v1/viewport",
    );
    expect(viewportCall?.url.searchParams.get("session")).toBe("session-1");
    expect(viewportCall?.url.searchParams.get("zoom")).toBe("15");
    expect(viewportCall?.url.searchParams.get("north")).toBe("43.75");
    const admitted: string[] = [];
    const route = createMapsRoute("viewport", {
      authenticate: async () => ({
        id: "91000000-0000-4000-8000-000000000001",
        organization_id: "92000000-0000-4000-8000-000000000001",
      }),
      entitlement: async () => ({
        entitled: true,
        planKey: "plus_monthly",
        planEffectiveUntil: null,
      }),
      admit: async (request) => {
        admitted.push(request.operation);
        return { allowed: true };
      },
      provider: () => provider,
    });
    const post = (body: unknown, ip: string) =>
      route.request(
        "/",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify(body),
        },
        { NODE_ENV: "test" },
      );
    const ok = await post(view, "203.0.113.210");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { copyright: string }).copyright).toBe(
      "Map data ©2026 Google",
    );
    expect(admitted).toEqual(["viewport"]);
    expect(
      (await post({ ...view, north: 10, south: 20 }, "203.0.113.211")).status,
    ).toBe(400);
  });
});
