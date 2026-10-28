// The shared phone Maps screen controller against the real MapsController,
// saved places and route geometry. Provider, location, voice, background and
// share ports are scripted; this is not evidence of a live provider, device
// GPS, local speech or physical navigation.
import assert from "node:assert/strict";
import test from "node:test";
import { MapsScreenController } from "../src/client/maps-screen.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const ORIGIN = { latitude: 43.73, longitude: 7.42 };
const END = { latitude: 43.74, longitude: 7.42 };
const OFF_ROUTE = { latitude: 43.735, longitude: 7.43 };
const config = (modes = ["drive", "walk"]) => ({
  status: "configured",
  providerId: "fixture",
  connectionId: "conn_fixture_123456789",
  revision: "1",
  capabilities: {
    map: false,
    search: true,
    placeDetails: true,
    modes,
    traffic: "none",
    transit: "none",
    offline: { map: false, search: false, routing: false },
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

function fixture(options = {}) {
  let now = 1_760_000_000_000;
  const calls = {
    routes: [],
    searches: [],
    shares: [],
    websites: [],
    toasts: [],
    background: [],
    voice: [],
    published: [],
    released: 0,
    handoffDiscarded: 0,
    initialized: 0,
  };
  const destination = {
    providerId: "fixture",
    id: "destination",
    name: "Destination",
    coordinate: END,
    address: "1 Destination Street",
    website: options.website ?? "https://destination.example/",
    openingHours: "Mo-Fr 09:00-17:00",
    attribution: "Fixture data",
    fetchedAt: now,
  };
  const provider = {
    providerId: "fixture",
    connectionId: "conn_fixture_123456789",
    async search(query) {
      calls.searches.push(query);
      return query === "nothing" ? [] : [destination];
    },
    async detail() {
      return destination;
    },
    async route(from, to, mode) {
      calls.routes.push({ from, mode });
      return {
        providerId: "fixture",
        id: `route_0123456789abcdef_${calls.routes.length}`,
        from,
        to,
        mode,
        geometry: [from, to],
        distanceMeters: 1200,
        durationSeconds: 300,
        steps: [
          {
            instruction: "Head north",
            coordinate: from,
            distanceMeters: 1100,
            maneuver: "depart",
          },
          {
            instruction: "Turn left onto Rue A",
            coordinate: { latitude: 43.739, longitude: 7.42 },
            distanceMeters: 100,
            maneuver: "left",
          },
          {
            instruction: "Arrive",
            coordinate: to,
            distanceMeters: 0,
            maneuver: "arrive",
          },
        ],
        attribution: "Fixture data",
        fetchedAt: now,
        traffic: "none",
      };
    },
  };
  let receiveFix;
  let stopped = 0;
  const location = {
    awaitingPermission: () => false,
    async start(_oneShot, onFix) {
      receiveFix = onFix;
    },
    async stop() {
      stopped++;
    },
  };
  let deviceFix;
  const deviceLocation = {
    awaitingPermission: () => false,
    async start(_oneShot, onFix) {
      if (deviceFix) queueMicrotask(() => onFix(deviceFix));
    },
    async stop() {},
  };
  let backgroundActive = false;
  let notificationStop;
  const connection = {
    config: options.unconfigured
      ? { status: "unconfigured" }
      : config(options.modes),
  };
  const host = {
    connection: () => ({
      config: connection.config,
      provider:
        connection.config.status === "configured" ? provider : undefined,
    }),
    onConnectionChange: () => () => {},
    initialize: async () => {
      calls.initialized++;
    },
    diagnostics: () => ({ configured: true, error: "" }),
    coverage: () => options.coverage,
    attribution: () => "Fixture data",
    createController: (current, maps) =>
      new MapsController(
        current,
        maps,
        new SavedPlaces("screen.test", memory()),
        deviceLocation,
      ),
    navigationLocation: location,
    agentLocation: deviceLocation,
    locationGranted: async () => options.granted ?? true,
    voice: {
      enabled: true,
      update: (key, text) => calls.voice.push(["update", key, text]),
      pause: () => calls.voice.push(["pause"]),
      toggle() {
        this.enabled = !this.enabled;
      },
    },
    background: {
      active: () => backgroundActive,
      async start(title, _text, onStopped) {
        calls.background.push(["start", title]);
        notificationStop = onStopped;
        backgroundActive = !!options.background;
        return backgroundActive;
      },
      update: (title) => calls.background.push(["update", title]),
      async stop() {
        if (backgroundActive) calls.background.push(["stop"]);
        backgroundActive = false;
      },
    },
    share: async (data) => {
      calls.shares.push(data);
      return "copied";
    },
    openWebsite: (url) => calls.websites.push(url.href),
    active: () => !options.inactive,
    invalidate: () => {},
    toast: (text) => calls.toasts.push(text),
    discardHandoff: () => calls.handoffDiscarded++,
    handoffReturn: () => options.handoffReturn ?? false,
    released: () => calls.released++,
    now: () => now,
    publishContext: (kind) => calls.published.push(kind),
    clearContext: () => {},
    ...(options.mapsApp ? { mapsApp: options.mapsApp } : {}),
  };
  const screen = new MapsScreenController(host);
  screen.ensure();
  const fix = (overrides = {}) => ({
    coordinate: OFF_ROUTE,
    accuracyMeters: 8,
    precision: "precise",
    timestamp: now,
    ...overrides,
  });
  return {
    screen,
    calls,
    destination,
    host,
    fix,
    emit: (value) => receiveFix(value),
    advance: (ms) => {
      now += ms;
    },
    stops: () => stopped,
    setDeviceFix: (value) => {
      deviceFix = value;
    },
    notificationStop: (reason) => notificationStop?.(reason),
  };
}

/** Search, choose the destination, and plan a route from typed coordinates. */
async function planned(f) {
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  f.screen.openDirections();
  f.screen.setOriginText(`${ORIGIN.latitude}, ${ORIGIN.longitude}`);
  f.screen.planOrigin();
  await settle();
  assert.equal(f.screen.view().directions?.routeReady, true);
}

test("search results, place detail, saved place and rename", async () => {
  const f = fixture();
  assert.equal(f.screen.view().mode, "base");
  f.screen.setQuery("Destination");
  assert.equal(f.screen.view().mode, "results");
  f.screen.submit();
  await settle();
  let view = f.screen.view();
  assert.deepEqual(f.calls.searches.at(-1), "Destination");
  assert.deepEqual(
    view.results.map((row) => [row.key, row.detail]),
    [["place:fixture:destination", "1 Destination Street"]],
  );
  assert.deepEqual(
    view.map.overlay.pins.map((pin) => pin.id),
    ["destination"],
  );
  f.screen.choose("place:fixture:destination");
  await settle();
  view = f.screen.view();
  assert.equal(view.mode, "place");
  assert.equal(view.place?.address, "1 Destination Street");
  assert.equal(view.place?.hours, "Mo-Fr 09:00-17:00");
  assert.equal(view.place?.website, "https://destination.example/");
  assert.equal(view.place?.canDirections, true);
  assert.equal(view.searchLead, "back");
  assert.ok(f.calls.published.includes("map-place"));

  f.screen.toggleSaved();
  view = f.screen.view();
  assert.equal(view.place?.saved, true);
  assert.equal(view.status.text, "Place saved on this device.");
  assert.equal(view.saved.length, 1);
  f.screen.startRename();
  f.screen.rename("Office");
  f.screen.applyName();
  assert.equal(f.screen.view().saved[0].label, "Office");
  assert.equal(f.screen.view().status.text, "Saved place renamed.");
  f.screen.toggleSaved();
  assert.equal(f.screen.view().saved.length, 0);

  f.screen.openWebsite();
  assert.deepEqual(f.calls.websites, ["https://destination.example/"]);
  f.screen.sharePlace();
  await settle();
  assert.equal(f.calls.shares[0].title, "Office");
  assert.deepEqual(f.calls.toasts, ["Copied"]);

  // Closing a chosen place returns to the map with the search text kept.
  assert.equal(f.screen.back(), true);
  assert.equal(f.screen.view().mode, "base");
  assert.equal(f.screen.view().query, "Destination");
  assert.equal(f.screen.back(), true);
  assert.equal(f.screen.view().query, "");
  assert.equal(f.screen.back(), false);
});

test("coordinates drop a pin; an empty search is distinct from a failure", async () => {
  const f = fixture();
  f.screen.setQuery("43.7397, 7.4276");
  f.screen.submit();
  let view = f.screen.view();
  assert.equal(view.mode, "place");
  assert.equal(view.place?.name, "Dropped pin");
  assert.deepEqual(view.map.selected, { latitude: 43.7397, longitude: 7.4276 });
  assert.equal(
    f.calls.searches.length,
    0,
    "coordinates never reach the provider",
  );
  f.screen.back();
  f.screen.setQuery("nothing");
  f.screen.submit();
  await settle();
  view = f.screen.view();
  assert.equal(view.noResults, true);
  assert.equal(view.hasResults, false);
});

test("an unsafe provider website is never offered or opened", async () => {
  const f = fixture({ website: "javascript:alert(1)" });
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  assert.equal(f.screen.view().place?.website, undefined);
  f.screen.openWebsite();
  assert.deepEqual(f.calls.websites, []);
});

test("directions need a real origin and a served mode", async () => {
  const unconfigured = fixture({ unconfigured: true });
  unconfigured.screen.setQuery("1, 2");
  unconfigured.screen.submit();
  unconfigured.screen.openDirections();
  assert.equal(unconfigured.screen.view().mode, "place");
  assert.match(
    unconfigured.screen.view().status.text,
    /Connect a Maps provider/,
  );

  const f = fixture();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  f.screen.openDirections();
  let view = f.screen.view();
  assert.equal(view.mode, "directions");
  assert.equal(view.directions?.routeReady, false);
  assert.equal(
    view.directions?.via,
    "Choose a real origin to calculate a route.",
  );
  assert.deepEqual(
    view.directions?.modes.map((choice) => [choice.mode, choice.available]),
    [
      ["drive", true],
      ["transit", false],
      ["walk", true],
      ["bicycle", false],
    ],
  );
  f.screen.setMode("transit");
  assert.match(
    f.screen.view().status.text,
    /Transit schedules are not available/,
  );
  f.screen.planOrigin();
  assert.match(f.screen.view().status.text, /Enter a starting place/);
  f.screen.setOriginText(`${ORIGIN.latitude}, ${ORIGIN.longitude}`);
  f.screen.planOrigin();
  await settle();
  view = f.screen.view();
  assert.equal(view.directions?.routeReady, true);
  assert.equal(view.directions?.duration, "5 min");
  assert.equal(view.directions?.meta, "1.2 km · no live traffic");
  f.screen.setMode("walk");
  await settle();
  assert.deepEqual(
    f.calls.routes.map((call) => call.mode),
    ["drive", "walk"],
  );
  f.screen.shareRoute();
  await settle();
  assert.match(f.calls.shares[0].title, /Destination/);
  f.screen.setOriginText("4");
  assert.equal(
    f.screen.view().directions?.routeReady,
    false,
    "editing the origin clears the route",
  );
});

test("a named origin offers saved places and provider results, then plans", async () => {
  const f = fixture();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  f.screen.toggleSaved();
  f.screen.openDirections();
  f.screen.setOriginText("Destination");
  f.screen.planOrigin();
  await settle();
  const view = f.screen.view();
  assert.equal(view.mode, "origin");
  assert.equal(view.query, "Destination");
  assert.deepEqual(
    view.results.map((row) => row.saved),
    [true, false],
  );
  f.screen.choose(view.results[0].key);
  await settle();
  assert.equal(f.screen.view().mode, "directions");
  assert.equal(f.calls.routes.length, 1);
});

test("Start guides from fresh fixes; arrival and End release the watch", async () => {
  const f = fixture({ background: true });
  await planned(f);
  f.screen.start();
  await settle();
  let view = f.screen.view();
  assert.equal(view.mode, "navigation");
  assert.equal(view.navigation?.distance, "Locating…");
  assert.deepEqual(f.calls.background[0], ["start", "Route to Destination"]);
  assert.equal(view.navigation?.background, true);
  f.emit(f.fix({ coordinate: { latitude: 43.732, longitude: 7.42 } }));
  view = f.screen.view();
  assert.equal(view.navigation?.instruction, "Head north");
  assert.equal(view.navigation?.following?.text, "Turn left onto Rue A");
  assert.equal(view.navigation?.offRoute, false);
  assert.ok(
    f.calls.voice.some(
      (call) => call[0] === "update" && call[2] === "Head north",
    ),
  );
  assert.equal(view.map.overlay.follow, true);
  f.emit(f.fix({ coordinate: END, accuracyMeters: 5 }));
  view = f.screen.view();
  assert.equal(view.navigation?.arrived, true);
  assert.equal(view.status.text, "Destination reached.");
  f.screen.end();
  await settle();
  assert.equal(f.screen.view().mode, "directions");
  assert.ok(f.stops() >= 1);
});

test("a notification Stop ends navigation once; a refused service stays foreground-only", async () => {
  const f = fixture({ background: true });
  await planned(f);
  f.screen.start();
  await settle();
  f.notificationStop("notification");
  await settle();
  assert.equal(f.screen.view().mode, "directions");
  assert.equal(
    f.screen.view().status.text,
    "Navigation stopped from the notification.",
  );
});

test("an aged reroute request is refused and the exact active route kept", async () => {
  const f = fixture();
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  assert.equal(f.screen.view().navigation?.canReroute, true);
  const surface = f.screen.surface(async () => true);
  const previous = surface.snapshot().route.value;
  f.advance(30_001); // No GPS event: the screen must recheck freshness.
  f.screen.reroute();
  assert.equal(f.calls.routes.length, 1);
  assert.equal(surface.snapshot().route.value, previous);
  assert.equal(surface.guidance()?.routeId, previous.id);
  assert.equal(f.screen.view().navigation?.canReroute, false);
  assert.match(f.screen.view().status.text, /current route was kept/);
  f.emit(f.fix());
  assert.equal(
    f.calls.routes.length,
    1,
    "fresh GPS does not reroute automatically",
  );
  f.screen.reroute();
  await settle();
  assert.equal(f.calls.routes.length, 2);
  assert.notEqual(surface.snapshot().route.value, previous);
  assert.equal(surface.guidance()?.routeId, surface.snapshot().route.value.id);
  assert.equal(f.screen.view().status.text, "New route ready.");
});

test("an approximate or inaccurate update invalidates an older precise fix", async () => {
  for (const update of [
    { accuracyMeters: 900 },
    { precision: "approximate", accuracyMeters: 8 },
  ]) {
    const f = fixture();
    await planned(f);
    f.screen.start();
    await settle();
    f.emit(f.fix());
    const surface = f.screen.surface(async () => true);
    f.emit(f.fix(update));
    assert.equal(surface.guidance()?.fix, undefined);
    f.screen.reroute();
    assert.equal(f.calls.routes.length, 1);
    assert.equal(f.screen.view().navigation?.canReroute, false);
    f.emit(f.fix());
    assert.equal(f.screen.view().navigation?.canReroute, true);
  }
});

test("hiding Maps releases it unless screen-off navigation continues", async () => {
  const foreground = fixture();
  await planned(foreground);
  foreground.screen.hidden();
  assert.equal(foreground.calls.released, 1);
  assert.equal(foreground.screen.view().mode, "base");

  const background = fixture({ background: true });
  await planned(background);
  background.screen.start();
  await settle();
  background.screen.hidden();
  assert.equal(background.calls.released, 0);
  assert.equal(background.screen.view().mode, "navigation");
  background.screen.dispose();
  assert.equal(background.calls.released, 1);
});

test("an event hand-off searches once; Back returns to the event", async () => {
  const f = fixture({ handoffReturn: true });
  f.screen.handoff("  1 Destination Street  ", true);
  await settle();
  assert.deepEqual(f.calls.searches, ["1 Destination Street"]);
  assert.equal(f.screen.showingEventHandoff(), true);
  assert.equal(f.screen.back(), false, "the shell returns to the event");
  assert.equal(f.screen.showingEventHandoff(), false);
  assert.equal(f.screen.view().query, "");
  assert.deepEqual(
    f.calls.searches,
    ["1 Destination Street"],
    "Back never searches again",
  );
  // Without a way back to the event, Back stays inside Maps.
  const inside = fixture();
  inside.screen.handoff("1 Destination Street", true);
  assert.equal(inside.screen.back(), true);
});

test("without a provider an event location can be handed to a maps app on tap", async () => {
  const opened = [];
  const f = fixture({
    unconfigured: true,
    mapsApp: {
      available: async () => true,
      open: async (text) => {
        opened.push(text);
        return { opened: true };
      },
    },
  });
  f.screen.handoff("1 Destination Street", true);
  f.screen.view();
  await settle();
  assert.equal(f.screen.view().status.mapsAppHandoff, true);
  f.screen.openInMapsApp();
  await settle();
  assert.deepEqual(opened, ["1 Destination Street"]);
  assert.match(f.screen.view().status.text, /Opened in your maps app/);
  f.screen.setQuery("other");
  assert.equal(f.screen.view().status.mapsAppHandoff, false);
});

test("the agent surface shows directions and plans only from an explicit device fix", async () => {
  const f = fixture();
  const surface = f.screen.surface(async () => true);
  await surface.showDirections(f.destination, "walk", true);
  let view = f.screen.view();
  assert.equal(view.mode, "directions");
  assert.match(view.status.text, /Your agent asked for directions/);
  assert.equal(
    view.directions?.routeReady,
    false,
    "no route without an origin",
  );
  f.setDeviceFix({
    coordinate: ORIGIN,
    accuracyMeters: 6,
    precision: "precise",
    timestamp: Date.now(),
  });
  const position = await surface.locate(new AbortController().signal);
  await surface.planFrom(position.coordinate);
  view = f.screen.view();
  assert.equal(view.directions?.routeReady, true);
  assert.equal(
    surface.guidance(),
    null,
    "only the user's Start begins guidance",
  );
  const denied = fixture({ granted: false });
  await assert.rejects(
    denied.screen
      .surface(async () => true)
      .locate(new AbortController().signal),
    (error) => error.code === "permission-denied",
  );
});

test("coverage notices keep the coordinates of a place outside the region", async () => {
  const f = fixture({
    coverage: {
      name: "Monaco",
      mapRestricted: true,
      contains: (point) => point.latitude > 43.72 && point.latitude < 43.76,
    },
  });
  f.screen.setQuery("48.8566, 2.3522");
  f.screen.submit();
  const view = f.screen.view();
  assert.equal(view.status.map, "outside-coverage");
  assert.match(view.status.text, /outside Monaco map coverage/);
  assert.equal(view.map.selected, undefined);
  assert.equal(view.place?.address, "48.85660, 2.35220");
});
