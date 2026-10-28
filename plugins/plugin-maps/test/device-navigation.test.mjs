// The phone side of MapsDeviceNavigation against the real shared MapsController and a
// stubbed Eliza Cloud Maps provider. The Maps screen is a scripted surface with a host
// screen's semantics. Nothing leaves the process; this is not evidence of a resident
// agent reaching a phone, a live route, a device location or physical navigation.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  bindAgentNavigation,
  createMapsNavigationPort,
} from "../src/client/agent-navigation.ts";
import { MapsFailure } from "../src/client/contracts.ts";
import { DeviceMapsNavigation } from "../src/client/device-navigation.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const residentMapsNavigationPort = createMapsNavigationPort();
const ATTRIBUTION = "© OpenStreetMap contributors (ODbL).";
const CASINO = { latitude: 43.7397, longitude: 7.4276 },
  PORT = { latitude: 43.7347, longitude: 7.4206 },
  PALACE = { latitude: 43.7314, longitude: 7.4199 };
const config = {
  status: "configured",
  providerId: "eliza-cloud-osm",
  connectionId: "conn_eliza_cloud_maps_osm",
  revision: "osm-monaco-2026-09-29",
  capabilities: {
    map: false,
    search: true,
    placeDetails: true,
    modes: ["drive", "walk", "bicycle"],
    traffic: "none",
    transit: "none",
    offline: { map: false, search: false, routing: false },
  },
};
const owner = {
  providerId: config.providerId,
  attribution: ATTRIBUTION,
  current: () => true,
};
const portRef = {
  provider: "eliza-cloud",
  providerPlaceId: "N1234",
  name: "Port",
  coordinates: PORT,
  categories: [],
};
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};
const noLocation = {
  awaitingPermission: () => false,
  start: async () => {},
  stop: async () => {},
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const failsWith = async (promise, code, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "DeviceNavigationFailure");
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

/** A stubbed Cloud provider that records each request. Routes end exactly at the destination. */
function provider(options = {}) {
  const calls = [];
  let routeCount = 0;
  return {
    calls,
    providerId: config.providerId,
    connectionId: config.connectionId,
    async search() {
      return [];
    },
    async detail(id) {
      calls.push(["detail", id]);
      if (id !== "N1234") return null;
      return {
        providerId: config.providerId,
        id,
        name: "Port Hercule",
        coordinate: PORT,
        address: "Port Hercule, Monaco",
        attribution: ATTRIBUTION,
        fetchedAt: Date.now(),
      };
    },
    async route(from, to, mode, signal) {
      calls.push(["route", from, to, mode]);
      if (options.route) await options.route(signal);
      if (options.noRoute)
        throw new MapsFailure(
          "unsupported",
          "No route is available between these places.",
        );
      return {
        providerId: config.providerId,
        id: `route_${++routeCount}_0123456789abcdef`,
        from,
        to,
        mode,
        geometry: [from, to],
        distanceMeters: 640,
        durationSeconds: 480,
        steps: [
          {
            instruction: "Head south",
            coordinate: from,
            distanceMeters: 640,
            maneuver: "depart",
          },
          {
            instruction: "Arrive",
            coordinate: to,
            distanceMeters: 0,
            maneuver: "arrive",
          },
        ],
        attribution: ATTRIBUTION,
        fetchedAt: Date.now(),
        traffic: "none",
      };
    },
  };
}

/** The Maps screen as prototype/maps-adapter.ts drives it: the user's Start is the only way guidance begins. */
function screen(maps, options = {}) {
  const controller = new MapsController(
    config,
    maps,
    new SavedPlaces("test.maps.agent", memory()),
    noLocation,
  );
  let navigating = false,
    routeId = "",
    fix,
    placeName = "",
    released = new Set(),
    sheet = "base",
    rerouting = false,
    arrived = false;
  const located = [];
  const surface = {
    sheet: () => sheet,
    async present() {
      return options.present ?? true;
    },
    snapshot: () => controller.snapshot(),
    async showPlace(place, resolve) {
      sheet = "place";
      await controller.select(place, resolve);
      placeName = controller.snapshot().selection.value?.name ?? place.name;
    },
    async showDirections(place, mode, resolve) {
      sheet = "directions";
      controller.clearOrigin();
      controller.setMode(mode);
      await controller.select(place, resolve);
      placeName = controller.snapshot().selection.value?.name ?? place.name;
    },
    async locationGranted() {
      return options.granted ?? true;
    },
    locate(signal) {
      located.push(signal);
      return options.locate
        ? options.locate(signal)
        : Promise.resolve({
            coordinate: CASINO,
            accuracyMeters: 8,
            timestamp: Date.now(),
            precision: "precise",
          });
    },
    planFrom(origin) {
      controller.setOrigin(origin);
      return controller.planRoute();
    },
    // As the adapter: the session lasts from the user's Start to End, through rerouting and arrival.
    guidance: () =>
      navigating
        ? {
            routeId,
            placeName,
            travelMode: controller.snapshot().mode,
            rerouting,
            arrived,
            ...(fix ? { fix } : {}),
          }
        : null,
    async reroute(from) {
      rerouting = true;
      try {
        await controller.reroute(from);
      } finally {
        rerouting = false;
      }
      const route = controller.snapshot().route;
      if (route.phase === "ready") routeId = route.value.id;
      else navigating = false;
    },
    async stop() {
      navigating = false;
      routeId = "";
      fix = undefined;
      rerouting = false;
      arrived = false;
    },
    onRelease(listener) {
      released.add(listener);
      return () => released.delete(listener);
    },
  };
  return {
    controller,
    surface,
    located,
    /** The user's own Start on the reviewed route sheet. */
    userStarts(position) {
      const route = controller.snapshot().route;
      assert.equal(route.phase, "ready");
      navigating = true;
      routeId = route.value.id;
      sheet = "navigation";
      fix = position;
    },
    moveTo(position) {
      fix = position;
    },
    arrive() {
      arrived = true;
    },
    release() {
      for (const listener of [...released]) listener();
    },
  };
}

// Contract: the client binding repeats the agent-side contract in ../src/navigation.ts.
{
  const text = (name) =>
    fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const navigation = text("navigation.ts");
  assert.match(
    navigation,
    /export type MapsDeviceNavigationState =\s*\| "selected"\s*\| "navigating"\s*\| "stopped"\s*\| "awaiting-location"\s*\| "awaiting-confirmation";/,
    "device navigation states changed",
  );
  for (const method of [
    "select(place: PlaceRef): Promise<MapsDeviceNavigationStatus>;",
    "reroute(): Promise<MapsDeviceNavigationStatus>;",
    "stop(): Promise<MapsDeviceNavigationStatus>;",
  ])
    assert.ok(navigation.includes(method), `agent contract changed: ${method}`);
  assert.match(
    navigation,
    /start\(request: \{\s*destination: PlaceRef;\s*travelMode: TravelMode;\s*\}\): Promise<MapsDeviceNavigationStatus>;/,
  );
  assert.match(
    text("cloud-adapter.ts"),
    /export const ELIZA_CLOUD_MAPS_PROVIDER_ID = "eliza-cloud";/,
    "the agent Cloud provider id changed",
  );
  assert.match(
    text("service.ts"),
    /registerDeviceNavigation\(controller: MapsDeviceNavigation \| null\): void/,
  );
  assert.match(
    text("client/navigation-relay.ts"),
    /export async function withMapsNavigationRelay/,
  );
  assert.equal(residentMapsNavigationPort.relay, false);
}

// Select: a Cloud place from the agent is re-read from the phone's own Cloud provider and shown.
{
  const maps = provider(),
    phone = screen(maps),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  assert.deepEqual(await nav.select(portRef), {
    state: "selected",
    placeName: "Port Hercule",
  });
  assert.deepEqual(maps.calls, [["detail", "N1234"]]);
  assert.equal(phone.surface.sheet(), "place");
  assert.equal(
    phone.controller.snapshot().selection.value.address,
    "Port Hercule, Monaco",
  );
  // A coordinate place is a dropped pin; no provider request.
  assert.deepEqual(
    await nav.select({
      provider: "coordinates",
      providerPlaceId: "geo:43.7314,7.4199",
      name: "Palace",
      coordinates: PALACE,
      categories: [],
    }),
    { state: "selected", placeName: "Palace" },
  );
  assert.equal(maps.calls.length, 1);
  await failsWith(
    nav.select({ ...portRef, providerPlaceId: "N9999" }),
    "MAPS_NOT_FOUND",
  );
  await failsWith(
    nav.select({ ...portRef, provider: "google" }),
    "MAPS_INVALID_INPUT",
    /Cloud Maps places or coordinates/,
  );
  await failsWith(
    nav.select({ ...portRef, coordinates: { latitude: 91, longitude: 0 } }),
    "MAPS_INVALID_INPUT",
  );
  const hidden = screen(provider(), { present: false });
  await failsWith(
    new DeviceMapsNavigation(hidden.surface, owner).select(portRef),
    "MAPS_DEVICE_UNAVAILABLE",
    /Open Maps/,
  );
  assert.equal(
    hidden.controller.snapshot().selection.phase,
    "idle",
    "nothing is shown when the phone cannot present Maps",
  );
}

// Start: plans from a fresh device fix and stops at the reviewed route sheet; the user starts guidance.
{
  const maps = provider(),
    phone = screen(maps),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  assert.deepEqual(
    await nav.start({ destination: portRef, travelMode: "walk" }),
    {
      state: "awaiting-confirmation",
      placeName: "Port Hercule",
      travelMode: "walk",
    },
  );
  assert.deepEqual(maps.calls.at(-1), ["route", CASINO, PORT, "walk"]);
  assert.equal(phone.surface.sheet(), "directions");
  assert.equal(
    phone.surface.guidance(),
    null,
    "an agent request never begins guidance",
  );
  assert.equal(phone.controller.snapshot().route.value.mode, "walk");
  phone.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  // Active guidance is not replaced by another agent request.
  await failsWith(
    nav.start({ destination: portRef, travelMode: "drive" }),
    "MAPS_INVALID_INPUT",
    /already active/,
  );
  await failsWith(nav.select(portRef), "MAPS_INVALID_INPUT", /End it/);
  assert.equal(phone.surface.guidance().travelMode, "walk");
  // Unsupported modes and unroutable places are typed, never guessed.
  const other = screen(provider());
  await failsWith(
    new DeviceMapsNavigation(other.surface, owner).start({
      destination: portRef,
      travelMode: "transit",
    }),
    "MAPS_UNSUPPORTED_REGION",
    /transit/,
  );
  await failsWith(
    new DeviceMapsNavigation(other.surface, owner).start({
      destination: portRef,
      travelMode: "fly",
    }),
    "MAPS_INVALID_INPUT",
  );
  const blocked = screen(provider({ noRoute: true }));
  await failsWith(
    new DeviceMapsNavigation(blocked.surface, owner).start({
      destination: portRef,
      travelMode: "drive",
    }),
    "MAPS_NOT_FOUND",
    /No route/,
  );
}

// Stale location: no permission, a stale fix, an approximate fix or no fix is awaiting-location, and no route is planned.
{
  const ungranted = screen(provider(), { granted: false });
  assert.deepEqual(
    await new DeviceMapsNavigation(ungranted.surface, owner).start({
      destination: portRef,
      travelMode: "drive",
    }),
    {
      state: "awaiting-location",
      placeName: "Port Hercule",
      travelMode: "drive",
    },
  );
  assert.equal(
    ungranted.located.length,
    0,
    "an agent request never shows a permission prompt",
  );
  for (const [label, locate] of [
    [
      "stale",
      async () => ({
        coordinate: CASINO,
        accuracyMeters: 8,
        timestamp: Date.now() - 120_000,
        precision: "precise",
      }),
    ],
    [
      "approximate",
      async () => ({
        coordinate: CASINO,
        accuracyMeters: 900,
        timestamp: Date.now(),
        precision: "approximate",
      }),
    ],
    [
      "denied",
      async () => {
        throw new MapsFailure(
          "permission-denied",
          "Location permission was denied.",
        );
      },
    ],
    [
      "silent",
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(new MapsFailure("cancelled", "stopped")),
          ),
        ),
    ],
  ]) {
    const maps = provider(),
      phone = screen(maps, { locate }),
      nav = new DeviceMapsNavigation(phone.surface, owner, {
        fixTimeoutMs: 20,
      });
    assert.deepEqual(
      await nav.start({ destination: portRef, travelMode: "drive" }),
      {
        state: "awaiting-location",
        placeName: "Port Hercule",
        travelMode: "drive",
      },
      label,
    );
    assert.ok(
      !maps.calls.some(([kind]) => kind === "route"),
      `${label}: no route without a fresh fix`,
    );
    assert.ok(
      phone.located[0].aborted,
      `${label}: the one-shot location request is released`,
    );
  }
}

// Reroute: only active guidance; a stale fix is reported and the old route kept; a fresh fix replans the same session.
{
  const maps = provider(),
    phone = screen(maps),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  await failsWith(
    nav.reroute(),
    "MAPS_INVALID_INPUT",
    /No navigation is active/,
  );
  await nav.start({ destination: portRef, travelMode: "drive" });
  phone.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now() - 60_000,
    precision: "precise",
  });
  const before = phone.surface.guidance().routeId,
    routes = maps.calls.length;
  await failsWith(
    nav.reroute(),
    "MAPS_DEVICE_UNAVAILABLE",
    /kept the current route/,
  );
  assert.equal(
    maps.calls.length,
    routes,
    "a stale fix never becomes a route origin",
  );
  assert.equal(
    phone.surface.guidance().routeId,
    before,
    "guidance continues on the current route",
  );
  phone.moveTo({
    coordinate: PALACE,
    accuracyMeters: 120,
    timestamp: Date.now(),
    precision: "approximate",
  });
  await failsWith(nav.reroute(), "MAPS_DEVICE_UNAVAILABLE", /fresh, precise/);
  phone.moveTo({
    coordinate: PALACE,
    accuracyMeters: 6,
    timestamp: Date.now(),
    precision: "precise",
  });
  assert.deepEqual(await nav.reroute(), {
    state: "navigating",
    placeName: "Port Hercule",
    travelMode: "drive",
  });
  assert.deepEqual(maps.calls.at(-1), ["route", PALACE, PORT, "drive"]);
  assert.notEqual(phone.surface.guidance().routeId, before);
  // A failed replan ends guidance on the phone; the agent hears the typed reason.
  const failing = provider(),
    broken = screen(failing),
    brokenNav = new DeviceMapsNavigation(broken.surface, owner);
  await brokenNav.start({ destination: portRef, travelMode: "drive" });
  broken.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  failing.route = async () => {
    throw new MapsFailure(
      "offline",
      "Eliza Cloud Maps is unreachable. Check the connection.",
    );
  };
  await failsWith(brokenNav.reroute(), "MAPS_PROVIDER_NETWORK", /unreachable/);
  assert.equal(broken.surface.guidance(), null);
}

// While a new route is planned, the session is still active: no agent request takes it over, and arrival ends rerouting.
{
  const gate = deferred(),
    maps = provider(),
    phone = screen(maps),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  await nav.start({ destination: portRef, travelMode: "drive" });
  phone.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  maps.route = async (from, to, mode) => {
    await gate.promise;
    return {
      providerId: config.providerId,
      id: "route_slow_0123456789abcdef",
      from,
      to,
      mode,
      geometry: [from, to],
      distanceMeters: 1,
      durationSeconds: 1,
      steps: [],
      attribution: ATTRIBUTION,
      fetchedAt: Date.now(),
      traffic: "none",
    };
  };
  const user = phone.surface.reroute(PALACE);
  assert.equal(phone.surface.guidance().rerouting, true);
  await failsWith(
    nav.start({ destination: portRef, travelMode: "walk" }),
    "MAPS_INVALID_INPUT",
    /already active/,
  );
  await failsWith(nav.select(portRef), "MAPS_INVALID_INPUT", /End it/);
  await failsWith(nav.reroute(), "MAPS_DEVICE_UNAVAILABLE", /already planning/);
  gate.resolve();
  await user;
  assert.equal(phone.surface.guidance().routeId, "route_slow_0123456789abcdef");
  phone.arrive();
  phone.moveTo({
    coordinate: PORT,
    accuracyMeters: 5,
    timestamp: Date.now(),
    precision: "precise",
  });
  await failsWith(nav.reroute(), "MAPS_INVALID_INPUT", /arrived/);
}

// Stop: ends guidance and is idempotent.
{
  const phone = screen(provider()),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  await nav.start({ destination: portRef, travelMode: "bicycle" });
  phone.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  assert.deepEqual(await nav.stop(), {
    state: "stopped",
    placeName: "Port Hercule",
    travelMode: "bicycle",
  });
  assert.equal(phone.surface.guidance(), null);
  assert.deepEqual(await nav.stop(), { state: "stopped" });
}

// Cancellation: Stop, a newer request or leaving Maps cancels a pending start before any route is planned.
{
  for (const cancel of ["stop", "newer", "release"]) {
    const fix = deferred(),
      maps = provider();
    let first = true;
    const phone = screen(maps, {
      locate: () => {
        if (first) {
          first = false;
          return fix.promise;
        }
        return Promise.resolve({
          coordinate: CASINO,
          accuracyMeters: 8,
          timestamp: Date.now(),
          precision: "precise",
        });
      },
    });
    const nav = new DeviceMapsNavigation(phone.surface, owner);
    const pending = nav.start({ destination: portRef, travelMode: "drive" });
    while (!phone.located.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const later =
      cancel === "stop"
        ? nav.stop()
        : cancel === "newer"
          ? nav.start({ destination: portRef, travelMode: "walk" })
          : (phone.release(), undefined);
    fix.resolve({
      coordinate: CASINO,
      accuracyMeters: 8,
      timestamp: Date.now(),
      precision: "precise",
    });
    await failsWith(pending, "MAPS_DEVICE_UNAVAILABLE", /cancelled/);
    assert.ok(
      phone.located[0].aborted,
      `${cancel}: the pending location request is released`,
    );
    if (cancel === "newer") assert.equal((await later).travelMode, "walk");
    else {
      await later;
      assert.ok(
        !maps.calls.some(
          ([kind, , , mode]) => kind === "route" && mode === "drive",
        ),
        `${cancel}: the cancelled start planned no route`,
      );
    }
  }
  // A route already in flight is abandoned, not reported.
  const gate = deferred(),
    maps = provider({ route: () => gate.promise }),
    phone = screen(maps),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  const pending = nav.start({ destination: portRef, travelMode: "drive" });
  while (!maps.calls.some(([kind]) => kind === "route"))
    await new Promise((resolve) => setTimeout(resolve, 1));
  await nav.stop();
  gate.resolve();
  await failsWith(pending, "MAPS_DEVICE_UNAVAILABLE", /cancelled/);
}

// User actions during asynchronous presentation or GPS always retain ownership of the route.
for (const operation of ["select", "start"]) {
  const phone = screen(provider()),
    nav = new DeviceMapsNavigation(phone.surface, owner);
  await nav.start({ destination: portRef, travelMode: "drive" });
  const gate = deferred();
  phone.surface.present = () => gate.promise;
  const pending =
    operation === "select"
      ? nav.select(portRef)
      : nav.start({ destination: portRef, travelMode: "walk" });
  phone.userStarts({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  const active = phone.surface.guidance();
  gate.resolve(true);
  await failsWith(pending, "MAPS_INVALID_INPUT", /Navigation started/);
  assert.deepEqual(phone.surface.guidance(), active);
  assert.equal(phone.surface.sheet(), "navigation");
}
for (const change of ["mode", "selection"]) {
  const fix = deferred(),
    maps = provider(),
    phone = screen(maps, { locate: () => fix.promise });
  const nav = new DeviceMapsNavigation(phone.surface, owner);
  const pending = nav.start({ destination: portRef, travelMode: "drive" });
  while (!phone.located.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  if (change === "mode") phone.controller.setMode("walk");
  else
    await phone.controller.select(
      {
        ...phone.controller.snapshot().selection.value,
        id: "coordinates",
        coordinate: PALACE,
      },
      false,
    );
  fix.resolve({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  await failsWith(pending, "MAPS_DEVICE_UNAVAILABLE", /Maps changed/);
  assert.equal(
    maps.calls.some(([kind]) => kind === "route"),
    false,
    "a delayed fix never replans a changed sheet",
  );
}

// Registration: offered only while Eliza Cloud Maps is installed for the signed-in account; an account change retires it.
{
  const listeners = new Set(),
    registered = [];
  let connection = { config: { status: "unconfigured" } },
    coverage;
  const change = () => listeners.forEach((listener) => listener());
  const port = { register: (navigation) => registered.push(navigation) };
  const phoneA = screen(provider());
  const options = {
    installation: () => coverage,
    connection: () => connection,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    surface: phoneA.surface,
    port,
  };
  // Unconfigured (signed out, no subscription, Cloud Maps not deployed): nothing is offered, so the agent reports unavailable.
  const binding = bindAgentNavigation({ ...options, enabled: () => true });
  assert.equal(binding.registered(), false);
  assert.deepEqual(registered, []);
  // The test-mocks regional gateway is never offered to the agent.
  const regional = bindAgentNavigation({
    ...options,
    enabled: () => false,
    port: {
      register: () =>
        assert.fail("regional development Maps was offered to the agent"),
    },
  });
  const accountA = provider();
  coverage = { providerId: config.providerId, attribution: ATTRIBUTION };
  connection = { config, provider: accountA };
  change();
  assert.equal(binding.registered(), true);
  const offeredA = registered.at(-1);
  assert.ok(offeredA);
  assert.equal((await offeredA.select(portRef)).state, "selected");
  // An unrelated change event keeps the same binding.
  change();
  assert.equal(registered.at(-1), offeredA);
  // Account change: in-flight work is cancelled, the old binding is withdrawn and refuses later calls.
  const fix = deferred();
  phoneA.surface.locate = () => fix.promise;
  const pending = offeredA.start({ destination: portRef, travelMode: "drive" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  coverage = undefined;
  connection = { config: { status: "unconfigured" } };
  change();
  fix.resolve({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  await failsWith(pending, "MAPS_DEVICE_UNAVAILABLE", /cancelled/);
  assert.equal(registered.at(-1), null, "the agent is told navigation is gone");
  await failsWith(
    offeredA.select(portRef),
    "MAPS_PROVIDER_CHANGED",
    /account on the phone changed/,
  );
  await failsWith(offeredA.stop(), "MAPS_PROVIDER_CHANGED", /account/);
  // The next account gets a fresh binding; the previous one stays retired.
  const accountB = provider();
  coverage = { providerId: config.providerId, attribution: ATTRIBUTION };
  connection = { config, provider: accountB };
  change();
  const offeredB = registered.at(-1);
  assert.ok(offeredB && offeredB !== offeredA);
  await failsWith(offeredA.select(portRef), "MAPS_PROVIDER_CHANGED");
  // A direct provider swap without an unconfigured step also retires the old binding first.
  connection = { config, provider: provider() };
  change();
  assert.deepEqual(
    registered
      .slice(-2)
      .map((value) => (value === null ? null : value === offeredB ? "B" : "C")),
    [null, "C"],
  );
  await failsWith(offeredB.select(portRef), "MAPS_PROVIDER_CHANGED");
  binding.dispose();
  regional.dispose();
  assert.equal(registered.at(-1), null);
  assert.equal(listeners.size, 0);
}

// A cancelled resident turn cannot use a late GPS fix to plan a route.
{
  const maps = provider(),
    fix = deferred(),
    phone = screen(maps, { locate: () => fix.promise });
  const navigation = new DeviceMapsNavigation(phone.surface, owner),
    turn = new AbortController();
  const pending = navigation.start(
    { destination: portRef, travelMode: "drive" },
    turn.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 1));
  turn.abort();
  fix.resolve({
    coordinate: CASINO,
    accuracyMeters: 8,
    timestamp: Date.now(),
    precision: "precise",
  });
  await failsWith(pending, "MAPS_DEVICE_UNAVAILABLE", /cancelled/);
  assert.equal(
    maps.calls.filter((call) => call[0] === "route").length,
    0,
    "cancelled turn never plans from its late fix",
  );
  await failsWith(
    navigation.stop(turn.signal),
    "MAPS_DEVICE_UNAVAILABLE",
    /cancelled/,
  );
  navigation.retire();
}

console.log(
  "maps device navigation: select, start, reroute, stop, cancellation, stale location, account change and unconfigured registration passed",
);
