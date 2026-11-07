import assert from "node:assert/strict";
import test from "node:test";
import { isManeuver, place } from "../src/client/contracts.ts";
import {
  createRegionalMaps,
  insideRegion,
} from "../src/client/regional-provider.ts";
import { routeProgress } from "../src/client/route-distance.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};
const location = () => ({
  awaitingPermission: () => false,
  start: async () => {},
  stop: async () => {},
});
const config = {
  status: "configured",
  providerId: "test",
  connectionId: "conn_test_navigation_123",
  revision: "one",
  capabilities: {
    map: true,
    search: true,
    placeDetails: false,
    modes: ["walk"],
    traffic: "none",
    transit: "none",
    offline: { map: false, search: false, routing: false },
  },
};
const candidate = (name, latitude = 1, longitude = 2, extra = {}) => ({
  providerId: "test",
  id: name,
  name,
  coordinate: { latitude, longitude },
  attribution: "Test data",
  fetchedAt: Date.now(),
  ...extra,
});
// A straight 200 m walk north along a meridian, with one turn after 100 m.
const north = (meters) => ({ latitude: meters / 111195, longitude: 0 });
const routeFor = (from, to, steps) => ({
  providerId: "test",
  id: `route-${from.latitude}-${to.latitude}`,
  from,
  to,
  mode: "walk",
  geometry: [from, north(100), to],
  distanceMeters: 200,
  durationSeconds: 200,
  steps,
  attribution: "Test data",
  fetchedAt: Date.now(),
  traffic: "none",
});
const steps = [
  {
    instruction: "Head north",
    coordinate: north(0),
    distanceMeters: 100,
    maneuver: "depart",
  },
  {
    instruction: "Turn left onto Test Street",
    coordinate: north(100),
    distanceMeters: 100,
    maneuver: "left",
  },
  {
    instruction: "Arrive at destination",
    coordinate: north(200),
    distanceMeters: 0,
    maneuver: "arrive",
  },
];

function controllerWith(provider, saved = new SavedPlaces("test", storage())) {
  const controller = new MapsController(
    config,
    { providerId: "test", connectionId: config.connectionId, ...provider },
    saved,
    location(),
  );
  controller.setMode("walk");
  return controller;
}

test("maneuver vocabulary is closed", () => {
  assert.equal(isManeuver("left"), true);
  assert.equal(isManeuver("arrive"), true);
  assert.equal(isManeuver("teleport"), false);
  assert.equal(isManeuver(undefined), false);
});

test("route progress reports the next and following maneuver and the remaining share", () => {
  const route = {
    geometry: [north(0), north(100), north(200)],
    steps,
    durationSeconds: 200,
  };
  const start = routeProgress(north(0), route);
  assert.equal(start.stepIndex, 0);
  assert.equal(start.next.step.maneuver, "left");
  assert.ok(Math.abs(start.next.distanceMeters - 100) < 0.5);
  assert.equal(start.then.step.maneuver, "arrive");
  assert.deepEqual(
    start.maneuverAlongMeters.map((value) => Math.round(value)),
    [0, 100, 200],
  );
  assert.ok(Math.abs(start.remainingMeters - 200) < 0.5);
  assert.ok(Math.abs(start.remainingSeconds - 200) < 0.5);
  const midway = routeProgress(
    { latitude: north(40).latitude, longitude: 0.0001 },
    route,
  );
  assert.ok(Math.abs(midway.next.distanceMeters - 60) < 0.5);
  assert.ok(midway.offRouteMeters > 10 && midway.offRouteMeters < 12);
  const turned = routeProgress(north(150), route);
  assert.equal(turned.stepIndex, 1);
  assert.equal(turned.next.step.maneuver, "arrive");
  assert.equal(turned.then, undefined);
  assert.ok(Math.abs(turned.remainingSeconds - 50) < 0.5);
  const arrived = routeProgress(north(200), route);
  assert.equal(arrived.next, undefined);
  assert.ok(arrived.remainingMeters < 0.5);
});

test("route steps keep valid maneuvers and reject unknown ones", async () => {
  let bad = false;
  const controller = controllerWith({
    route: async (from, to) =>
      routeFor(from, to, bad ? [{ ...steps[0], maneuver: "teleport" }] : steps),
  });
  controller.setOrigin(north(0));
  await controller.select(
    candidate("Destination", north(200).latitude, 0),
    false,
  );
  await controller.planRoute();
  assert.deepEqual(
    controller.snapshot().route.value.steps.map((step) => step.maneuver),
    ["depart", "left", "arrive"],
  );
  bad = true;
  await controller.planRoute();
  assert.equal(controller.snapshot().route.phase, "error");
  await controller.leave();
});

test("origin search is independent of the destination and cancelled by editing", async () => {
  const pending = [];
  const controller = controllerWith({
    search: (query, signal) =>
      new Promise((resolve) => pending.push({ query, signal, resolve })),
    route: async (from, to) => routeFor(from, to, steps),
  });
  await controller.select(
    candidate("Destination", north(200).latitude, 0),
    false,
  );
  const stale = controller.searchOrigin("Old origin");
  assert.equal(controller.snapshot().originSearch.phase, "loading");
  controller.clearOrigin();
  assert.equal(pending[0].signal.aborted, true, "editing aborts the request");
  pending[0].resolve([candidate("Old origin")]);
  await stale;
  assert.equal(controller.snapshot().originSearch.phase, "idle");
  assert.equal(controller.snapshot().selection.value.name, "Destination");

  const current = controller.searchOrigin("Start");
  pending[1].resolve([candidate("Start", north(0).latitude, 0)]);
  await current;
  const found = controller.snapshot().originSearch;
  assert.equal(found.phase, "ready");
  await controller.chooseOrigin(found.value[0]);
  const state = controller.snapshot();
  assert.equal(state.originLabel, "Start");
  assert.equal(state.originSearch.phase, "idle");
  assert.equal(state.route.phase, "ready");
  assert.equal(state.route.value.from.latitude, north(0).latitude);
  assert.equal(state.selection.value.name, "Destination");
  await controller.leave();
});

test("saved places match origin text and can be chosen as the origin", async () => {
  const saved = new SavedPlaces("test", storage());
  saved.save({ label: "Home base", coordinate: north(0) });
  saved.save({ label: "Office", coordinate: north(50) });
  const controller = controllerWith(
    { route: async (from, to) => routeFor(from, to, steps) },
    saved,
  );
  assert.deepEqual(
    controller.savedMatches("home").map((item) => item.label),
    ["Home base"],
  );
  assert.deepEqual(controller.savedMatches("  "), []);
  await controller.select(
    candidate("Destination", north(200).latitude, 0),
    false,
  );
  await controller.chooseOrigin(controller.savedMatches("home")[0]);
  assert.equal(controller.snapshot().originLabel, "Home base");
  assert.equal(controller.snapshot().route.phase, "ready");
  await controller.reroute(north(40));
  assert.equal(controller.snapshot().originLabel, null);
  assert.equal(
    controller.snapshot().route.value.from.latitude,
    north(40).latitude,
  );
  await controller.leave();
});

test("place details keep bounded opening hours, phone and website", () => {
  const detail = place(
    candidate("Cafe", 1, 2, {
      openingHours: "Mo-Fr 08:00-18:00",
      phone: "+377 93 00 00 00",
      website: "https://example.org/",
    }),
    "test",
  );
  assert.equal(detail.openingHours, "Mo-Fr 08:00-18:00");
  assert.equal(detail.phone, "+377 93 00 00 00");
  assert.throws(
    () => place(candidate("Cafe", 1, 2, { openingHours: "x".repeat(300) })),
    /opening hours/,
  );
});

test("regional provider takes provider identity and bounds from the configured gateway", async () => {
  const configured = [];
  const meta = (providerId, bounds) => ({
    providerId,
    connectionId: "conn_regional_test_0001",
    revision: "r1",
    region: "Test region",
    bounds,
    attribution: "Test data",
    capabilities: {
      map: true,
      search: true,
      placeDetails: true,
      modes: ["walk"],
      traffic: "none",
      transit: "none",
      offline: { map: false, search: false, routing: false },
    },
  });
  let response = meta("osm-test-region", [10, 20, 11, 21]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(response));
  try {
    const maps = (providerId) =>
      createRegionalMaps({
        baseUrl: "https://maps.example/",
        ...(providerId ? { providerId } : {}),
        nativeGateway: "",
        developmentHosts: [],
        development: false,
        isNative: () => false,
        developmentBuild: async () => false,
        transport: {
          request: async () => ({ status: 500, data: "" }),
          cancel: async () => {},
        },
        configure: (value) => configured.push(value),
      });
    const open = maps();
    await open.initializeRegionalMaps();
    assert.equal(open.regionalMap().providerId, "osm-test-region");
    assert.deepEqual(open.regionalMap().bounds, [10, 20, 11, 21]);
    assert.equal(configured.at(-1).providerId, "osm-test-region");
    assert.equal(
      insideRegion(open.regionalMap(), { latitude: 20.5, longitude: 10.5 }),
      true,
    );
    assert.equal(
      insideRegion(open.regionalMap(), { latitude: 43.7, longitude: 7.4 }),
      false,
    );

    const pinned = maps("another-provider");
    await pinned.initializeRegionalMaps();
    assert.equal(
      pinned.regionalMap(),
      undefined,
      "an explicit pin still refuses a different gateway",
    );

    response = meta("osm-test-region", [11, 20, 10, 21]);
    const inverted = maps();
    await inverted.initializeRegionalMaps();
    assert.equal(
      inverted.regionalMap(),
      undefined,
      "inverted bounds are refused",
    );
    assert.equal(inverted.regionalDiagnostics().error, "initialization-failed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("maneuvers are placed by their coordinates, in route order, whatever the step-length convention", () => {
  // Cumulative step distances and a line that passes the same point twice.
  const route = {
    geometry: [north(0), north(100), north(200), north(100)],
    durationSeconds: 300,
    steps: [
      { instruction: "Start", coordinate: north(0), distanceMeters: 0 },
      {
        instruction: "U-turn",
        coordinate: north(200),
        distanceMeters: 200,
        maneuver: "u-turn",
      },
      {
        instruction: "Arrive",
        coordinate: north(100),
        distanceMeters: 300,
        maneuver: "arrive",
      },
    ],
  };
  const start = routeProgress(north(0), route);
  assert.equal(start.next.step.instruction, "U-turn");
  assert.ok(Math.abs(start.next.distanceMeters - 200) < 0.5);
  const atTurn = routeProgress(north(200), route);
  assert.equal(atTurn.stepIndex, 1);
  assert.equal(atTurn.next.step.instruction, "Arrive");
  assert.ok(
    Math.abs(atTurn.next.distanceMeters - 100) < 0.5,
    "the revisited point is the later maneuver",
  );
});

test("route progress follows the short segment across the date line", () => {
  const route = {
    geometry: [
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    ],
    steps: [],
    durationSeconds: 200,
  };
  const halfway = routeProgress({ latitude: 0, longitude: 180 }, route);
  assert.ok(halfway.offRouteMeters < 1, `off route: ${halfway.offRouteMeters}`);
  assert.ok(Math.abs(halfway.remainingSeconds - 100) < 0.01);
});
