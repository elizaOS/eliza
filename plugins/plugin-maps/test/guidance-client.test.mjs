import assert from "node:assert/strict";
import test from "node:test";

test("guidance presents the next maneuver, the following step and the remaining trip", async () => {
  const { guidanceView, guidanceDistance, maneuverIcon, MANEUVER_ICONS } =
    await import("../src/client/guidance.ts");
  assert.equal(guidanceDistance(42, "en-GB"), "40 m");
  assert.equal(guidanceDistance(437, "en-GB"), "440 m");
  assert.equal(guidanceDistance(1830, "en-GB"), "1.8 km");
  assert.equal(maneuverIcon(undefined), MANEUVER_ICONS.continue);
  const step = (instruction, maneuver) => ({
    instruction,
    maneuver,
    coordinate: { latitude: 0, longitude: 0 },
    distanceMeters: 1,
  });
  const view = guidanceView(
    {
      offRouteMeters: 2,
      alongMeters: 100,
      remainingMeters: 900,
      remainingSeconds: 150,
      stepIndex: 0,
      next: {
        index: 1,
        step: step("Turn left onto Rue A", "left"),
        distanceMeters: 120,
      },
      // biome-ignore lint/suspicious/noThenProperty: RouteProgress names the following maneuver `then`.
      then: { index: 2, step: step("Turn right", "right") },
    },
    new Date(2026, 9, 8, 12, 0),
    "none",
    "en-GB",
  );
  assert.equal(view.icon, MANEUVER_ICONS.left);
  assert.equal(view.distance, "120 m");
  assert.equal(view.instruction, "Turn left onto Rue A");
  assert.equal(view.hasThen, true);
  assert.equal(view.thenIcon, MANEUVER_ICONS.right);
  assert.equal(view.remainingTime, "3 min");
  assert.match(view.remaining, /^900 m · arrive .+ · no live traffic$/);
  assert.equal(view.spoken, "In 120 m, Turn left onto Rue A");
  const near = guidanceView({
    offRouteMeters: 1,
    alongMeters: 0,
    remainingMeters: 10,
    remainingSeconds: 5,
    stepIndex: 0,
    next: {
      index: 1,
      step: step("Arrive at destination", "arrive"),
      distanceMeters: 10,
    },
  });
  assert.equal(near.spoken, "Arrive at destination");
  assert.equal(near.hasThen, false);
});

test("the upcoming maneuver stays fixed until the device has come near it", async () => {
  const { atStep } = await import("../src/client/guidance.ts");
  const step = (instruction) => ({
    instruction,
    coordinate: { latitude: 0, longitude: 0 },
    distanceMeters: 1,
  });
  const steps = [step("Start"), step("Turn right"), step("Arrive")];
  // A fix past the turn on the line, but never near it, still announces the turn.
  const progress = {
    offRouteMeters: 1,
    alongMeters: 222,
    remainingMeters: 111,
    remainingSeconds: 60,
    stepIndex: 1,
    maneuverAlongMeters: [0, 111, 333],
    next: { index: 2, step: steps[2], distanceMeters: 111 },
  };
  const held = atStep(progress, steps, 1);
  assert.equal(held.next.step.instruction, "Turn right");
  assert.equal(held.next.distanceMeters, 0);
  assert.equal(held.then.step.instruction, "Arrive");
  const last = atStep(progress, steps, 2);
  assert.equal(last.next.step.instruction, "Arrive");
  assert.equal(last.next.distanceMeters, 111);
  assert.equal(last.then, undefined);
});

test("a maneuver that no fix came near is passed after two fixes clear beyond it", async () => {
  const { advanceStep } = await import("../src/client/guidance.ts");
  const { routeProgress } = await import("../src/client/route-distance.ts");
  const at = (latitude, longitude = 0) => ({ latitude, longitude });
  const step = (coordinate) => ({
    instruction: "",
    coordinate,
    distanceMeters: 1,
  });
  const after = (hold, route, coordinate, onRoute = true) =>
    advanceStep(
      hold,
      route,
      routeProgress(coordinate, route),
      { coordinate, accuracyMeters: 8 },
      onRoute,
    );
  // A straight line north. The turn is 111 m from the start.
  const straight = {
    geometry: [at(0), at(0.003)],
    steps: [step(at(0)), step(at(0.001)), step(at(0.003))],
    durationSeconds: 60,
  };
  const held = { index: 1, cleared: 0 };
  assert.deepEqual(after(held, straight, at(0.0008)), { index: 2, cleared: 0 });
  // The watch lost the turn. The first fix is 111 m beyond it.
  const once = after(held, straight, at(0.002));
  assert.deepEqual(once, { index: 1, cleared: 1 });
  assert.deepEqual(after(once, straight, at(0.0021)), { index: 2, cleared: 0 });
  // One jumping fix, an off-route fix and the last step do not pass a maneuver.
  assert.deepEqual(after(once, straight, at(0.0005)), held);
  assert.deepEqual(after(once, straight, at(0.0021), false), held);
  assert.deepEqual(
    after({ index: 2, cleared: 0 }, straight, at(0.0031, 0.001)),
    { index: 2, cleared: 0 },
  );
  // The route goes north and returns 11 m to the east. A fix on the return
  // line is still near the line before the U-turn, so the U-turn stays.
  const back = {
    geometry: [at(0), at(0.003), at(0.003, 0.0001), at(0, 0.0001)],
    steps: [step(at(0)), step(at(0.003)), step(at(0, 0.0001))],
    durationSeconds: 60,
  };
  const fix = at(0.001, 0.0001);
  const progress = routeProgress(fix, back);
  assert.ok(progress.alongMeters > progress.maneuverAlongMeters[1]);
  assert.deepEqual(after(after(held, back, fix), back, fix), held);
});

function bridge() {
  const calls = [],
    listeners = [],
    active = new Set();
  return {
    calls,
    listeners,
    active,
    available: true,
    async navigationAvailability() {
      return { background: this.available };
    },
    async startNavigation(input) {
      calls.push(["start", input.sessionId]);
      active.add(input.sessionId);
    },
    async updateNavigation(input) {
      calls.push(["update", input.title]);
      return { active: true };
    },
    async stopNavigation(input) {
      calls.push(["stop", input.sessionId]);
      active.delete(input.sessionId);
      return { stopped: true };
    },
    async addListener(name, listener) {
      const entry = { name, listener };
      listeners.push(entry);
      return {
        remove: async () => {
          listeners.splice(listeners.indexOf(entry), 1);
        },
      };
    },
  };
}

test("screen-off navigation session stops exactly once from the app or the notification", async () => {
  const { BackgroundNavigation } = await import(
    "../src/client/background-navigation.ts"
  );
  const web = new BackgroundNavigation(bridge(), () => false);
  assert.equal(
    await web.start("Route", "Waiting", () => {}),
    false,
    "browsers stay foreground-only",
  );

  const unavailable = bridge();
  unavailable.available = false;
  assert.equal(
    await new BackgroundNavigation(unavailable, () => true).start(
      "Route",
      "Waiting",
      () => {},
    ),
    false,
    "a build without the service stays foreground-only",
  );
  assert.deepEqual(
    unavailable.calls.filter(([kind]) => kind === "start"),
    [],
  );

  const native = bridge(),
    session = new BackgroundNavigation(native, () => true);
  const stops = [];
  assert.equal(
    await session.start("Route", "Waiting", (reason) => stops.push(reason)),
    true,
  );
  assert.equal(session.active(), true);
  session.update("120 m · Turn left", "3 min");
  session.update("120 m · Turn left", "3 min");
  assert.equal(
    native.calls.filter(([kind]) => kind === "update").length,
    1,
    "unchanged text is not resent",
  );
  const id = native.calls[0][1];
  native.listeners[0].listener({
    sessionId: "other-session",
    reason: "notification",
  });
  assert.deepEqual(stops, [], "another session never stops this one");
  native.listeners[0].listener({ sessionId: id, reason: "notification" });
  assert.deepEqual(stops, ["notification"]);
  assert.equal(session.active(), false);
  await session.stop();
  assert.equal(
    native.calls.filter(([kind]) => kind === "stop").length,
    0,
    "a notification Stop is not repeated by the app",
  );

  const app = bridge(),
    second = new BackgroundNavigation(app, () => true),
    heard = [];
  await second.start("Route", "Waiting", (reason) => heard.push(reason));
  await second.stop();
  await second.stop();
  assert.equal(
    app.calls.filter(([kind]) => kind === "stop").length,
    1,
    "the app stops its session once",
  );
  assert.equal(app.listeners.length, 0, "the stop listener is released");
  assert.deepEqual(heard, []);
});

test("Stop cancels a background Start before it acquires native ownership", async () => {
  const { BackgroundNavigation } = await import(
    "../src/client/background-navigation.ts"
  );
  const native = bridge(),
    session = new BackgroundNavigation(native, () => true),
    starting = session.start("Route", "Waiting", () => {});
  await session.stop();
  assert.equal(await starting, false);
  assert.equal(session.active(), false);
  assert.deepEqual(native.calls, []);
  assert.deepEqual(native.listeners, []);
});

test("a retired native Start is stopped after acknowledgement without stopping its replacement", async () => {
  const { BackgroundNavigation } = await import(
    "../src/client/background-navigation.ts"
  );
  const native = bridge(),
    session = new BackgroundNavigation(native, () => true),
    pending = Promise.withResolvers(),
    entered = Promise.withResolvers();
  native.startNavigation = async (input) => {
    native.calls.push(["start", input.sessionId]);
    if (input.title === "Old") {
      entered.resolve(input.sessionId);
      await pending.promise;
    }
    native.active.add(input.sessionId);
  };
  const oldStart = session.start("Old", "Waiting", () => {});
  const oldId = await entered.promise;
  await session.stop();
  assert.equal(await session.start("New", "Waiting", () => {}), true);
  const newId = native.calls.filter(([kind]) => kind === "start").at(-1)[1];
  pending.resolve();
  assert.equal(await oldStart, false);
  assert.equal(native.active.has(oldId), false);
  assert.equal(native.active.has(newId), true);
  assert.equal(session.active(), true);
  assert.equal(
    native.calls.filter(([kind, id]) => kind === "stop" && id === newId).length,
    0,
  );
  assert.equal(native.listeners.length, 1);
  await session.stop();
});

test("a failed update from an old route cannot retire its replacement", async () => {
  const { BackgroundNavigation } = await import(
    "../src/client/background-navigation.ts"
  );
  const native = bridge(),
    heard = [],
    session = new BackgroundNavigation(native, () => true);
  let fail;
  native.updateNavigation = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  await session.start("Old", "Start", (reason) => heard.push(reason));
  session.update("Old turn", "Now");
  await session.start("New", "Start", (reason) => heard.push(reason));
  fail(Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.active(), true);
  assert.deepEqual(heard, []);
  await session.stop();
});

test("an instruction that changes while native navigation is starting is sent once it has started", async () => {
  const { BackgroundNavigation } = await import(
    "../src/client/background-navigation.ts"
  );
  const native = bridge(),
    heard = [],
    session = new BackgroundNavigation(native, () => true);
  let started = false,
    release;
  native.startNavigation = (input) =>
    new Promise((resolve) => {
      release = () => {
        started = true;
        native.calls.push(["start", input.sessionId]);
        resolve();
      };
    });
  native.updateNavigation = async (input) => {
    native.calls.push(["update", input.title]);
    return { active: started };
  };
  const running = session.start("Route", "Waiting for location", (reason) =>
    heard.push(reason),
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  session.update("Turn left", "In 40 m");
  release();
  assert.equal(await running, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.active(), true);
  assert.deepEqual(heard, []);
  assert.deepEqual(
    native.calls.filter(([kind]) => kind === "update"),
    [["update", "Turn left"]],
  );
  await session.stop();
});

test("guidance respects the distance locale and does not deny live traffic", async () => {
  const { guidanceDistance, guidanceView } = await import(
    "../src/client/guidance.ts"
  );
  assert.equal(guidanceDistance(1609.344, "en-US"), "1.0 mi");
  assert.equal(guidanceDistance(30.48, "en-US"), "100 ft");
  assert.equal(guidanceDistance(1609.344, "fr-FR"), "1.6 km");
  const result = guidanceView(
    { remainingMeters: 1609.344, remainingSeconds: 60 },
    new Date(),
    "live",
    "en-US",
  );
  assert.match(result.remaining, /^1.0 mi/);
  assert.doesNotMatch(result.remaining, /no live traffic/);
});
