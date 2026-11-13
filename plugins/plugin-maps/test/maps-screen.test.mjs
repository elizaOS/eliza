// The shared phone Maps screen controller against the real MapsController,
// saved places and route geometry. Provider, location, voice, background and
// share ports are scripted; this is not evidence of a live provider, device
// GPS, local speech or physical navigation.
import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundNavigation } from "../src/client/background-navigation.ts";
import { createCloudMaps } from "../src/client/cloud-provider.ts";
import { MapsFailure } from "../src/client/contracts.ts";
import { guidanceDistance } from "../src/client/guidance.ts";
import { MapsScreenController } from "../src/client/maps-screen.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const ORIGIN = { latitude: 43.73, longitude: 7.42 };
const END = { latitude: 43.74, longitude: 7.42 };
const OFF_ROUTE = { latitude: 43.735, longitude: 7.43 };
const config = (modes = ["drive", "walk"], alternatives = false) => ({
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
    ...(alternatives ? { alternatives: true } : {}),
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
    contexts: [],
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
    ...(options.reverse ? { reverse: options.reverse } : {}),
    async search(query) {
      calls.searches.push(query);
      return query === "nothing" ? [] : [destination];
    },
    async detail() {
      return destination;
    },
    async routes(from, to, mode, signal) {
      calls.routes.push({ from, mode, alternatives: true });
      const recommended = await this.route(from, to, mode, signal, true);
      return [
        recommended,
        {
          ...recommended,
          id: `${recommended.id}_alt`,
          distanceMeters: 1500,
          durationSeconds: 420,
          steps: [
            { ...recommended.steps[0], instruction: "Head east" },
            ...recommended.steps.slice(1),
          ],
        },
      ];
    },
    async route(from, to, mode, _signal, nested) {
      if (!nested) calls.routes.push({ from, mode });
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
  let deviceFix, deviceFixListener;
  const deviceLocation = {
    awaitingPermission: () => false,
    async start(_oneShot, onFix) {
      deviceFixListener = onFix;
      if (deviceFix) queueMicrotask(() => onFix(deviceFix));
    },
    async stop() {},
  };
  let backgroundActive = false;
  let notificationStop;
  const connection = {
    config: options.unconfigured
      ? { status: "unconfigured" }
      : config(options.modes, !!options.alternatives),
  };
  let connectionListener;
  const host = {
    connection: () => ({
      config: connection.config,
      provider:
        connection.config.status === "configured" ? provider : undefined,
    }),
    onConnectionChange: (listener) => {connectionListener=listener;return () => {connectionListener=undefined;};},
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
    publishContext: (kind, _identity, revision, read) => {
      calls.published.push(kind);
      calls.contexts.push({ kind, revision, value: read?.() });
    },
    clearContext: () => {},
    ...(options.mapsApp ? { mapsApp: options.mapsApp } : {}),
    ...(options.unconfiguredText
      ? { unconfiguredText: options.unconfiguredText }
      : {}),
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
    emitDevice: (value) => deviceFixListener?.(value),
    activate: () => {connection.config=config(options.modes, !!options.alternatives);connectionListener?.();},
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
  assert.equal(view.place?.origin, "provider");
  assert.equal(view.place?.providerId, "fixture");
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

test("place labels name provider places and typed coordinates", async () => {
  const f = fixture();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  assert.match(f.screen.view().place?.meta ?? "", /^Place/);
  f.screen.openDirections();
  const directions = f.screen.view().directions;
  assert.equal(directions?.routeReady, false);
  assert.equal(directions?.meta, "");

  const typed = fixture();
  typed.screen.setQuery("1, 2");
  typed.screen.submit();
  await settle();
  assert.match(typed.screen.view().place?.meta ?? "", /^Place/);
});

test("a host replaces the missing-provider text", async () => {
  const text = "Sign in to use Maps.";
  const directions = fixture({ unconfigured: true, unconfiguredText: text });
  directions.screen.setQuery("1, 2");
  directions.screen.submit();
  directions.screen.openDirections();
  assert.equal(directions.screen.view().status.text, text);

  const search = fixture({ unconfigured: true, unconfiguredText: text });
  search.screen.setQuery("Cafe");
  search.screen.submit();
  await settle();
  await settle();
  assert.equal(search.screen.view().status.text, text);

  const plain = fixture({ unconfigured: true });
  plain.screen.setQuery("Cafe");
  plain.screen.submit();
  await settle();
  await settle();
  assert.match(plain.screen.view().status.text, /Connect a Maps provider/);
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
  assert.equal(
    view.directions?.meta,
    `${guidanceDistance(1200)} · no live traffic`,
  );
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

test("an offered route choice keeps the provider's order; choosing requests nothing and Start follows it", async () => {
  const f = fixture({ alternatives: true, background: true });
  await planned(f);
  let view = f.screen.view();
  assert.deepEqual(f.calls.routes, [
    { from: ORIGIN, mode: "drive", alternatives: true },
  ]);
  assert.deepEqual(
    view.directions?.routes.map(({ label, duration, meta, selected }) => [
      label,
      duration,
      meta,
      selected,
    ]),
    [
      ["Recommended", "5 min", guidanceDistance(1200), true],
      ["Alternative 1", "7 min", guidanceDistance(1500), false],
    ],
  );
  f.screen.chooseRoute(view.directions.routes[1].id);
  view = f.screen.view();
  assert.equal(view.directions?.duration, "7 min");
  assert.equal(view.directions?.via, "Head east");
  assert.deepEqual(
    view.directions?.routes.map((choice) => choice.selected),
    [false, true],
  );
  assert.equal(view.map.route?.id, view.directions.routes[1].id);
  assert.equal(f.calls.routes.length, 1, "choosing a route requests nothing");
  f.screen.start();
  await settle();
  f.emit(f.fix({ coordinate: { latitude: 43.732, longitude: 7.42 } }));
  view = f.screen.view();
  assert.equal(view.mode, "navigation");
  assert.equal(view.navigation?.instruction, "Head east");
  // The choice cannot change under active guidance.
  f.screen.chooseRoute(`route_0123456789abcdef_1`);
  assert.equal(f.screen.view().navigation?.instruction, "Head east");
  f.screen.end();
  await settle();
  // Without the capability one route is requested and no choice is shown.
  const single = fixture();
  await planned(single);
  assert.deepEqual(single.screen.view().directions?.routes, []);
  assert.deepEqual(single.calls.routes, [{ from: ORIGIN, mode: "drive" }]);
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

test("a retired location callback cannot guide a later Start", async () => {
  const f = fixture({ background: true });
  const watches = [];
  const start = f.host.navigationLocation.start;
  f.host.navigationLocation.start = (...args) => {
    watches.push(args[1]);
    return start(...args);
  };
  try {
    await planned(f);
    f.screen.start();
    await settle();
    f.screen.end();
    f.screen.start();
    await settle();
    const surface = f.screen.surface(async () => true);
    const effects = f.calls.voice.length;
    watches[0](f.fix());
    assert.equal(surface.guidance().fix, undefined);
    assert.equal(f.calls.voice.length, effects);
    watches[1](f.fix());
    assert.deepEqual(surface.guidance().fix, f.fix());
  } finally {
    f.screen.dispose();
  }
});

test("arrival ignores later fixes until End", async () => {
  const f = fixture({ background: true });
  try {
    await planned(f);
    f.screen.start();
    await settle();
    f.emit(f.fix({ coordinate: END }));
    const effects = f.calls.voice.length;
    f.emit(f.fix({ coordinate: { latitude: 43.732, longitude: 7.42 } }));
    assert.equal(f.screen.view().navigation.arrived, true);
    assert.equal(f.screen.view().status.text, "Destination reached.");
    assert.equal(f.calls.voice.length, effects);
  } finally {
    f.screen.dispose();
  }
});

test("a completed old background Start cannot stop its replacement", async () => {
  const f = fixture();
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const started = [],
    active = new Set();
  f.host.background = new BackgroundNavigation(
    {
      async navigationAvailability() {
        return { background: true };
      },
      async addListener() {
        return { remove: async () => {} };
      },
      async startNavigation({ sessionId }) {
        started.push(sessionId);
        if (started.length === 1) {
          entered.resolve();
          await pending.promise;
        }
        active.add(sessionId);
      },
      async stopNavigation({ sessionId }) {
        active.delete(sessionId);
        return { stopped: true };
      },
      async updateNavigation({ sessionId }) {
        return { active: active.has(sessionId) };
      },
    },
    () => true,
  );
  try {
    await planned(f);
    f.screen.start();
    await entered.promise;
    pending.resolve();
    // Let the helper finish, then replace the screen session before its completion callback.
    queueMicrotask(() =>
      queueMicrotask(() => {
        f.screen.end();
        f.screen.start();
      }),
    );
    await settle();
    assert.equal(f.screen.isNavigating(), true);
    assert.equal(f.host.background.active(), true);
    assert.equal(f.screen.view().navigation.background, true);
    assert.equal(started.length, 2);
    assert.deepEqual([...active], [started[1]]);
  } finally {
    f.screen.dispose();
  }
});

test("a rejected navigation watch ends guidance and reports the failure", async () => {
  const f = fixture({ background: true });
  const start = f.host.navigationLocation.start;
  f.host.navigationLocation.start = async () => {
    throw new MapsFailure(
      "unavailable",
      "Native location is unavailable in this build.",
    );
  };
  try {
    await planned(f);
    f.screen.start();
    await settle();
    assert.equal(f.screen.isNavigating(), false);
    assert.equal(f.host.background.active(), false);
    assert.equal(
      f.screen.view().status.text,
      "Native location is unavailable in this build.",
    );
    const pending = Promise.withResolvers();
    f.host.navigationLocation.start = () => pending.promise;
    f.screen.start();
    f.screen.end();
    f.host.navigationLocation.start = start;
    f.screen.start();
    await settle();
    const effects = f.calls.voice.length;
    pending.reject(new MapsFailure("unavailable", "Retired watch failed."));
    await settle();
    assert.equal(f.screen.isNavigating(), true);
    assert.equal(f.host.background.active(), true);
    assert.equal(f.calls.voice.length, effects);
    f.emit(f.fix());
    assert.deepEqual(
      f.screen.surface(async () => true).guidance().fix,
      f.fix(),
    );
  } finally {
    f.screen.dispose();
  }
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

test("hiding Maps retains the selected route; screen-off navigation continues", async () => {
  const foreground = fixture();
  await planned(foreground);
  foreground.screen.hidden();
  assert.equal(foreground.calls.released, 1);
  assert.equal(foreground.screen.view().mode, "directions");

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

test("coverage notices retain a selected place without exposing coordinate copy", async () => {
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
  assert.equal(view.place?.address, "");
  assert.equal(view.place?.name, "Dropped pin");
});

test("Cloud admission failure remains visible through explicit search without provider calls", async () => {
  for (const [status, code, message] of [
    [403, "subscription_required", "Maps needs an active Cloud subscription."],
    [401, "unauthorized", "Sign in to Cloud to use Maps."],
  ]) {
    const f = fixture({ unconfigured: true });
    await settle();
    const calls = [];
    const maps = createCloudMaps(
      () => async (route) => {
        calls.push(route);
        throw Object.assign(
          new Error("private response must not be displayed"),
          {
            name: "CloudProtocolError",
            code: "http",
            status,
            data: { code },
          },
        );
      },
      () => {
        throw Error("Denied provider must not be installed");
      },
    );
    f.host.initialize = maps.initializeCloudMaps;
    f.host.diagnostics = maps.cloudMapsDiagnostics;
    await maps.initializeCloudMaps();
    f.screen.setQuery("Ferry Building, San Francisco");
    f.screen.submit();
    await settle();
    assert.equal(f.screen.view().status.text, message);
    assert.equal(f.screen.view().hasResults, false);
    assert.deepEqual(f.calls.searches, []);
    assert.deepEqual(f.calls.routes, []);
    assert.deepEqual(calls, ["capabilities", "capabilities"]);
    f.screen.submit();
    await settle();
    assert.equal(f.screen.view().status.text, message);
    assert.deepEqual(calls, ["capabilities", "capabilities", "capabilities"]);
    f.screen.dispose();
  }
});

test("leaving the view retains navigation and an unavailable reroute keeps the exact route", async () => {
  const f = fixture({ background: true });
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  const surface = f.screen.surface(async () => true),
    before = surface.snapshot().route.value;
  f.screen.leaveView();
  assert.equal(f.screen.isNavigating(), true);
  assert.equal(f.screen.view().mode, "navigation");
  assert.equal(f.calls.background.filter((row) => row[0] === "stop").length, 0);
  f.host.connection().provider.route = async () => {
    throw new MapsFailure("unavailable", "Offline.");
  };
  f.screen.reroute();
  await settle();
  assert.equal(f.screen.isNavigating(), true);
  assert.deepEqual(surface.snapshot().route.value, before);
  assert.equal(f.screen.view().mode, "navigation");
  assert.match(f.screen.view().status.text, /Offline/);
  assert.equal(f.calls.background.filter((row) => row[0] === "stop").length, 0);
  f.screen.dispose();
});

test("GPS progress keeps the selected route approval current; a new route retires it", async () => {
  const f = fixture();
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  const before = f.calls.contexts.at(-1);
  f.emit(f.fix({ coordinate: ORIGIN }));
  const progress = f.calls.contexts.at(-1);
  assert.equal(progress.kind, "map-route");
  assert.equal(progress.revision, before.revision);
  assert.deepEqual(progress.value, before.value);
  f.emit(f.fix());
  f.screen.reroute();
  await settle();
  assert.notEqual(f.calls.contexts.at(-1).revision, before.revision);
  f.screen.dispose();
});

test("recenter keeps the viewed place, reports its map coverage and biases a later search from the explicit position", async () => {
  const f = fixture({
    coverage: {
      name: "Monaco",
      mapRestricted: true,
      contains: (point) => point.latitude > 43.72 && point.latitude < 43.76,
    },
  });
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  const before = f.screen.view().place;
  f.setDeviceFix(
    f.fix({ coordinate: { latitude: 48.8566, longitude: 2.3522 } }),
  );
  f.screen.recenter();
  await settle();
  const outside = f.screen.view();
  assert.equal(outside.place.name, before.name);
  assert.equal(outside.status.map, "outside-coverage");
  assert.match(outside.status.text, /outside Monaco map coverage/);
  assert.equal(outside.map.selected, undefined);
  f.setDeviceFix(f.fix());
  f.screen.recenter();
  await settle();
  const view = f.screen.view();
  assert.equal(view.place.name, before.name);
  assert.deepEqual(view.map.selected, OFF_ROUTE);
  let options;
  f.host.connection().provider.search = async (_query, _signal, input) => {
    options = input;
    return [];
  };
  f.screen.searchFor("Coffee");
  await settle();
  assert.deepEqual(options.near, OFF_ROUTE);
  f.screen.dispose();
});

test("an unanswered explicit location request becomes retryable after fifteen seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.screen.locate();
  assert.equal(f.screen.view().status.locationBusy, true);
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(f.screen.view().status.locationBusy, false);
  assert.match(f.screen.view().status.text, /Couldn't find your location/);
  f.screen.dispose();
});

test("late location and provider callbacks after leaving cannot publish a selection", async () => {
  const options = {},
    f = fixture(options);
  let finish;
  f.host.connection().provider.search = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.screen.locate();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  options.inactive = true;
  f.screen.leaveView();
  const contexts = f.calls.contexts.length;
  f.emitDevice(f.fix());
  finish([f.destination]);
  await settle();
  assert.equal(f.screen.surface(async () => true).snapshot().origin, null);
  assert.equal(f.screen.view().mode, "results");
  assert.equal(f.screen.view().hasResults, false);
  assert.equal(f.calls.contexts.length, contexts);
  f.screen.dispose();
});

test("leaving Maps keeps foreground navigation even without background-service support", async () => {
  const f = fixture();
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  const route = f.screen.surface(async () => true).guidance().routeId;
  f.screen.leaveView();
  f.emit(f.fix({ coordinate: ORIGIN }));
  assert.equal(f.screen.isNavigating(), true);
  assert.equal(f.screen.surface(async () => true).guidance().routeId, route);
  assert.equal(f.stops(), 0);
  f.screen.dispose();
});

test("a location callback after the timeout cannot replace the retained origin", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.screen.locate();
  t.mock.timers.tick(15_000);
  await settle();
  f.emitDevice(f.fix());
  assert.equal(f.screen.surface(async () => true).snapshot().origin, null);
  assert.equal(f.screen.view().mode, "base");
  assert.match(f.screen.view().status.text, /Couldn't find your location/);
  f.screen.dispose();
});

test("a hidden page without background admission stops guidance and keeps its route for explicit resume", async () => {
  const f = fixture();
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  const surface = f.screen.surface(async () => true),
    route = surface.snapshot().route.value;
  f.screen.hidden();
  await settle();
  assert.equal(f.screen.isNavigating(), false);
  assert.equal(f.screen.view().mode, "directions");
  assert.deepEqual(surface.snapshot().route.value, route);
  assert.equal(f.stops(), 1);
  assert.match(f.screen.view().status.text, /Tap Start to resume/);
  f.screen.refresh();
  assert.equal(
    f.screen.isNavigating(),
    false,
    "foreground return does not restart guidance",
  );
  f.screen.dispose();
});

test("hiding without background admission during reroute retains the admitted route and ignores its late answer", async () => {
  const f = fixture();
  await planned(f);
  f.screen.start();
  await settle();
  f.emit(f.fix());
  const surface = f.screen.surface(async () => true),
    route = surface.snapshot().route.value;
  let finish;
  f.host.connection().provider.route = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.screen.reroute();
  await settle();
  f.screen.hidden();
  await settle();
  finish({ ...route, id: "late_route_0123456789", from: OFF_ROUTE });
  await settle();
  assert.equal(f.screen.isNavigating(), false);
  assert.equal(f.screen.view().directions.routeReady, true);
  assert.deepEqual(surface.snapshot().route.value, route);
  assert.deepEqual(surface.snapshot().origin, route.from);
  f.screen.dispose();
});

test("retiring a provider clears a recentered location without a selected place", async () => {
  const f = fixture();
  f.setDeviceFix(f.fix());
  f.screen.recenter();
  await settle();
  assert.deepEqual(f.screen.view().map.selected, OFF_ROUTE);
  f.screen.release(false);
  assert.equal(f.screen.view().map.selected, undefined);
  f.screen.dispose();
});

test("a GPS origin displays My location and keeps the exact route point internal", async () => {
  const f = fixture();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  f.screen.openDirections();
  f.setDeviceFix(f.fix({ coordinate: ORIGIN }));
  f.screen.locate();
  await settle();
  assert.equal(f.screen.view().directions?.originText, "My location");
  assert.deepEqual(f.calls.routes.at(-1).from, ORIGIN);
  f.screen.planOrigin();
  await settle();
  assert.equal(f.screen.view().directions?.originText, "My location");
  f.screen.setOriginText("Destination");
  f.screen.planOrigin();
  await settle();
  assert.equal(f.screen.view().mode, "origin");
  assert.equal(f.screen.view().directions?.originText, "Destination");
});

test("an early search continues once the first provider becomes available", async () => {
  const f = fixture({unconfigured:true});
  f.screen.setQuery("Destination");f.screen.submit();await settle();
  assert.equal(f.calls.searches.length,0);
  f.activate();await settle();
  assert.deepEqual(f.calls.searches,["Destination"]);
  assert.equal(f.screen.view().results[0].name,"Destination");
  f.screen.dispose();
});

test("directions use an allowed device location and swapping reverses the endpoints", async () => {
 const f=fixture();
 f.setDeviceFix({coordinate:ORIGIN,accuracyMeters:5,timestamp:Date.now(),precision:"precise"});
 f.screen.setQuery("Destination");f.screen.submit();await settle();
 f.screen.choose("place:fixture:destination");await settle();
 f.screen.openDirections(true);await settle();
 assert.equal(f.screen.view().directions?.routeReady,true);
 assert.equal(f.screen.view().directions?.originText,"My location");
 f.screen.swapDirections();await settle();
 assert.equal(f.screen.view().directions?.name,"My location");
 assert.equal(f.screen.view().directions?.originText,"Destination");
 assert.deepEqual(f.calls.routes.at(-1).from,END);
 assert.deepEqual(f.screen.view().map.route.to,ORIGIN);
 f.screen.dispose();
});

test("editing the automatic origin fences a late device location", async () => {
  const f = fixture();
  f.screen.setQuery("Destination");
  f.screen.submit();
  await settle();
  f.screen.choose("place:fixture:destination");
  await settle();
  f.screen.openDirections(true);
  await settle();
  f.screen.setOriginText("43.71, 7.40");
  f.screen.planOrigin();
  await settle();
  f.emitDevice({
    coordinate: ORIGIN,
    accuracyMeters: 5,
    timestamp: Date.now(),
    precision: "precise",
  });
  await settle();
  assert.deepEqual(f.screen.view().map.route.from, {
    latitude: 43.71,
    longitude: 7.4,
  });
  f.screen.dispose();
});

test("map taps resolve a named place before saving or routing", async () => {
  let resolve;
  const f = fixture({
    reverse: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.screen.selectPoint(END);
  assert.equal(f.screen.view().place.loading, true);
  f.screen.toggleSaved();
  f.screen.openDirections();
  assert.equal(f.screen.view().saved.length, 0);
  assert.equal(f.screen.view().mode, "place");
  resolve(f.destination);
  await settle();
  assert.equal(f.screen.view().place.name, "Destination");
  assert.equal(f.screen.view().place.loading, false);
  assert.equal(f.screen.view().place.origin, "provider");
  f.screen.dispose();
});

test("a newer map tap or closed card rejects a late place lookup", async () => {
  const pending = [];
  const f = fixture({
    reverse: (point, signal) =>
      new Promise((resolve) => pending.push({ point, signal, resolve })),
  });
  f.screen.selectPoint(END);
  f.screen.selectPoint(OFF_ROUTE);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(f.destination);
  await settle();
  assert.equal(f.screen.view().place.loading, true);
  f.screen.closePlace();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(f.destination);
  await settle();
  assert.equal(f.screen.view().place, undefined);
  assert.equal(f.screen.view().saved.length, 0);
  f.screen.dispose();
});
