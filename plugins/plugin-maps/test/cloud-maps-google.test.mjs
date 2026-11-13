// Eliza Cloud Maps device provider against a stubbed Google-backed Cloud:
// live traffic, scheduled transit and Cloud raster tiles. No request leaves the
// process; this is not evidence of a deployed Cloud, Google data or a device map.
import assert from "node:assert/strict";
import { createCloudMaps } from "../src/client/cloud-provider.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const ATTRIBUTION = "Google Maps";
const CASINO = { latitude: 43.7397, longitude: 7.4276 },
  PORT = { latitude: 43.7347, longitude: 7.4206 };
const coverage = {
  providerId: "eliza-cloud-google",
  connectionId: "conn_eliza_cloud_maps_google_eliza-cloud-google",
  revision: "google-maps-platform-live",
  attribution: ATTRIBUTION,
  regions: [
    { id: "world", name: "World", bounds: [-180, -85.0511, 180, 85.0511] },
  ],
  capabilities: {
    map: true,
    search: true,
    placeDetails: true,
    geocode: true,
    reverseGeocode: true,
    modes: ["drive", "walk", "bicycle", "transit"],
    alternatives: true,
    traffic: "live",
    transit: "scheduled",
    offline: { map: false, search: false, routing: false },
  },
  tiles: {
    urlTemplate: "/api/v1/maps/tiles/{z}/{x}/{y}",
    mapType: "roadmap",
    minZoom: 0,
    maxZoom: 22,
    tileSize: 256,
    attribution: "Map data © Google",
  },
};
const place = {
  providerId: coverage.providerId,
  id: "ChIJMYU_e2_CzRIR_JzEOkx493Q",
  name: "Port Hercule",
  coordinate: PORT,
  attribution: ATTRIBUTION,
  fetchedAt: Date.now(),
};
const base = (mode, traffic, steps) => ({
  providerId: coverage.providerId,
  id: `route_${mode}0123456789abcdef0123`,
  from: CASINO,
  to: PORT,
  mode,
  geometry: [CASINO, PORT],
  distanceMeters: 900,
  durationSeconds: 600,
  steps,
  attribution: ATTRIBUTION,
  fetchedAt: Date.now(),
  traffic,
});
const RIDE = {
  line: "1",
  vehicle: "bus",
  headsign: "Fontvieille",
  departureStop: "Casino",
  arrivalStop: "Port",
  departureTime: "2026-11-06T21:05:00Z",
  arrivalTime: "2026-11-06T21:12:00Z",
  stopCount: 3,
  color: "#e2001a",
};
const location = {
  awaitingPermission: () => false,
  start: async () => {},
  stop: async () => {},
};
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

function connect(respond, options) {
  const calls = [];
  let config, provider;
  const maps = createCloudMaps(
    () => async (path, _signal, body) => {
      calls.push([path, body]);
      if (path === "capabilities") return structuredClone(coverage);
      if (path === "places/details")
        return {
          providerId: coverage.providerId,
          attribution: ATTRIBUTION,
          place,
        };
      return respond(path, body);
    },
    (nextConfig, nextProvider) => {
      config = nextConfig;
      provider = nextProvider;
    },
    options,
  );
  return {
    maps,
    calls,
    get config() {
      return config;
    },
    get provider() {
      return provider;
    },
  };
}

// Live traffic, scheduled transit and tiles are installed as the provider's capabilities.
{
  const tileCalls = [];
  const cloud = connect(
    (path) => {
      if (path === "tiles/viewport")
        return {
          providerId: coverage.providerId,
          copyright: "Map data ©2026 Google",
        };
      throw new Error(`unexpected ${path}`);
    },
    {
      tileRequest: () => async (z, x, y) => {
        tileCalls.push([z, x, y]);
        return new Uint8Array([7]).buffer;
      },
    },
  );
  await cloud.maps.initializeCloudMaps();
  assert.deepEqual(cloud.config.capabilities, {
    map: true,
    search: true,
    placeDetails: true,
    modes: ["drive", "walk", "bicycle", "transit"],
    traffic: "live",
    transit: "scheduled",
    offline: { map: false, search: false, routing: false },
    alternatives: true,
  });
  assert.equal(cloud.maps.cloudMapsCoverage().tiles.maxZoom, 22);
  const basemap = cloud.maps.cloudMapsBasemap();
  assert.equal(basemap.kind, "cloud-raster");
  assert.equal(basemap.attribution, "Map data © Google");
  assert.deepEqual(
    [
      ...new Uint8Array(
        await basemap.tile(2, 1, 3, new AbortController().signal),
      ),
    ],
    [7],
  );
  await assert.rejects(basemap.tile(2, 4, 0, new AbortController().signal), {
    code: "unsupported",
  });
  assert.deepEqual(tileCalls, [[2, 1, 3]]);
  const view = {
    zoom: 14.6,
    north: 43.76,
    south: 43.72,
    east: 7.45,
    west: 7.4,
  };
  assert.equal(
    await basemap.copyright(view, new AbortController().signal),
    "Map data ©2026 Google",
  );
  assert.deepEqual(cloud.calls.at(-1), [
    "tiles/viewport",
    { ...view, zoom: 15 },
  ]);
  // A retired connection's basemap stops serving tiles.
  cloud.maps.retireCloudMaps();
  assert.equal(cloud.maps.cloudMapsBasemap(), undefined);
  await assert.rejects(basemap.tile(2, 1, 3, new AbortController().signal), {
    code: "unsupported",
  });
}

// Without a host tile fetcher there is no map plane, even when Cloud serves tiles.
{
  const cloud = connect(() => {
    throw new Error("unexpected");
  });
  await cloud.maps.initializeCloudMaps();
  assert.equal(cloud.config.capabilities.map, false);
  assert.equal(cloud.maps.cloudMapsBasemap(), undefined);
}

// A drive route carries live traffic; walk and transit routes are free flow, and rides keep their timetable.
{
  const cloud = connect((path, body) => {
    if (path !== "routes") throw new Error(`unexpected ${path}`);
    if (body.mode === "drive")
      return {
        routes: [
          {
            ...base("drive", "live", [
              {
                instruction: "Head south",
                coordinate: CASINO,
                distanceMeters: 900,
                maneuver: "depart",
              },
            ]),
            staticDurationSeconds: 480,
          },
        ],
      };
    return {
      routes: [
        base(body.mode, "none", [
          {
            instruction: "Walk to Casino",
            coordinate: CASINO,
            distanceMeters: 120,
          },
          {
            instruction:
              "Take the bus 1 toward Fontvieille from Casino to Port, 3 stops.",
            coordinate: CASINO,
            distanceMeters: 780,
            transit: RIDE,
          },
        ]),
      ],
    };
  });
  await cloud.maps.initializeCloudMaps();
  const controller = new MapsController(
    cloud.config,
    cloud.provider,
    new SavedPlaces("test.maps.google", memory()),
    location,
  );
  controller.setOrigin(CASINO);
  await controller.select(place);
  controller.setMode("drive");
  await controller.planRoute();
  let state = controller.snapshot();
  assert.equal(state.route.phase, "ready");
  assert.equal(state.route.value.traffic, "live");
  assert.equal(state.route.value.staticDurationSeconds, 480);
  controller.setMode("transit");
  await controller.planRoute();
  state = controller.snapshot();
  assert.equal(state.route.phase, "ready");
  assert.equal(state.route.value.traffic, "none");
  assert.deepEqual(state.route.value.steps[1].transit, RIDE);
  assert.equal(state.route.value.steps[0].transit, undefined);
}

// A malformed ride or a traffic claim the provider does not make is refused.
for (const broken of [
  base("transit", "none", [
    {
      instruction: "Ride",
      coordinate: CASINO,
      distanceMeters: 1,
      transit: { ...RIDE, line: "" },
    },
  ]),
  base("transit", "none", [
    {
      instruction: "Ride",
      coordinate: CASINO,
      distanceMeters: 1,
      transit: { ...RIDE, color: "red" },
    },
  ]),
  base("transit", "approximated", [
    { instruction: "Ride", coordinate: CASINO, distanceMeters: 1 },
  ]),
]) {
  const cloud = connect(() => ({ routes: [broken] }));
  await cloud.maps.initializeCloudMaps();
  const controller = new MapsController(
    cloud.config,
    cloud.provider,
    new SavedPlaces("test.maps.google.broken", memory()),
    location,
  );
  controller.setOrigin(CASINO);
  await controller.select(place);
  controller.setMode("transit");
  await controller.planRoute();
  assert.equal(controller.snapshot().route.phase, "error");
  assert.equal(controller.snapshot().route.error.code, "invalid-response");
}

// Coverage that offers transit without timetables, or unknown traffic, leaves Maps unconfigured.
for (const capabilities of [
  { ...coverage.capabilities, transit: "none" },
  { ...coverage.capabilities, traffic: "predicted" },
]) {
  let configured = 0;
  const maps = createCloudMaps(
    () => async () => ({ ...structuredClone(coverage), capabilities }),
    () => configured++,
  );
  await maps.initializeCloudMaps();
  assert.equal(configured, 0);
  assert.equal(maps.cloudMapsDiagnostics().error, "invalid-response");
}

// A tile refusal pauses later tile and data calls for the same Cloud account.
{
  const originalNow = Date.now;
  let clock = originalNow(), calls = 0, provider;
  Date.now = () => clock;
  const refusal = Object.assign(new Error("rate limited"), {
    status: 429, data: { code: "rate_limited", retryAfterSeconds: 42 },
  });
  const maps = createCloudMaps(
    () => async route => {
      if (route === "capabilities") return coverage;
      calls++;
      return { places: [place] };
    },
    (_config, value) => { provider = value; },
    { tileRequest: () => async () => { calls++; if (calls === 1) throw refusal; return new ArrayBuffer(1); } },
  );
  try {
    await maps.initializeCloudMaps();
    const signal = new AbortController().signal;
    let map = maps.cloudMapsBasemap();
    await assert.rejects(map.tile(2, 1, 1, signal), error => error.code === "rate-limited");
    await assert.rejects(map.tile(2, 1, 2, signal), error => error.code === "rate-limited");
    await assert.rejects(provider.search("Port", signal), error => error.code === "rate-limited");
    assert.equal(calls, 1);
    await maps.initializeCloudMaps();
    await assert.rejects(provider.search("Port", signal), error => error.code === "rate-limited");
    assert.equal(calls, 1, "Reopening Maps must retain the server pause");
    clock += 42_001;
    map = maps.cloudMapsBasemap();
    await map.tile(2, 1, 2, signal);
    assert.equal(calls, 2);
    maps.retireCloudMaps();
    await maps.initializeCloudMaps();
    await provider.search("Port", signal);
    assert.equal(calls, 3);
  } finally { Date.now = originalNow; }
}
