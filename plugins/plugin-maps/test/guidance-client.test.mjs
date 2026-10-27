import assert from "node:assert/strict";
import test from "node:test";

test("guidance presents the next maneuver, the following step and the remaining trip", async () => {
  const { guidanceView, guidanceDistance, maneuverIcon, MANEUVER_ICONS } =
    await import("../src/client/guidance.ts");
  assert.equal(guidanceDistance(42), "40 m");
  assert.equal(guidanceDistance(437), "440 m");
  assert.equal(guidanceDistance(1830), "1.8 km");
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
      then: { index: 2, step: step("Turn right", "right") },
    },
    new Date(2026, 9, 8, 12, 0),
  );
  assert.equal(view.icon, MANEUVER_ICONS.left);
  assert.equal(view.distance, "120 m");
  assert.equal(view.instruction, "Turn left onto Rue A");
  assert.equal(view.hasThen, true);
  assert.equal(view.thenIcon, MANEUVER_ICONS.right);
  assert.equal(view.remainingTime, "3 min");
  assert.match(view.remaining, /^900 m · arrive .+ · no live traffic$/);
  assert.equal(view.spoken, "Turn left onto Rue A");
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

function bridge() {
  const calls = [],
    listeners = [];
  return {
    calls,
    listeners,
    available: true,
    async navigationAvailability() {
      return { background: this.available };
    },
    async startNavigation(input) {
      calls.push(["start", input.sessionId]);
    },
    async updateNavigation(input) {
      calls.push(["update", input.title]);
      return { active: true };
    },
    async stopNavigation(input) {
      calls.push(["stop", input.sessionId]);
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
