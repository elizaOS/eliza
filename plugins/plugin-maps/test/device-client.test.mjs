import assert from "node:assert/strict";
import test from "node:test";
import { NavigationVoice } from "../src/client/navigation-voice.ts";
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
  connectionId: "conn_test_device_123456",
  revision: "one",
  capabilities: {
    map: false,
    search: true,
    placeDetails: false,
    modes: ["walk"],
    traffic: "none",
    transit: "none",
    offline: { map: false, search: false, routing: false },
  },
};
const place = (name) => ({
  providerId: "test",
  id: name,
  name,
  coordinate: { latitude: 1, longitude: 2 },
  attribution: "Test data",
  fetchedAt: Date.now(),
});
test("host namespaces retain installed data without sharing saved places", () => {
  const store = storage(),
    first = new SavedPlaces("host.one", store),
    second = new SavedPlaces("host.two", store);
  first.save({
    label: "First home",
    coordinate: { latitude: 1, longitude: 2 },
  });
  assert.equal(
    new SavedPlaces("host.one", store).read()[0].label,
    "First home",
  );
  assert.deepEqual(second.read(), []);
  store.setItem("host.two", "broken");
  assert.throws(() => second.read(), /could not be read/);
  assert.equal(store.getItem("host.two"), "broken");
});
test("late search results cannot replace the current query or survive controller retirement", async () => {
  const pending = [];
  const provider = {
    providerId: "test",
    connectionId: config.connectionId,
    search: () => new Promise((resolve) => pending.push(resolve)),
  };
  const controller = new MapsController(
    config,
    provider,
    new SavedPlaces("test", storage()),
    location(),
  );
  const first = controller.search("old"),
    second = controller.search("new");
  pending[1]([place("new")]);
  await second;
  pending[0]([place("old")]);
  await first;
  assert.equal(controller.snapshot().search.value[0].name, "new");
  const third = controller.search("retired");
  await controller.leave();
  pending[2]([place("retired")]);
  await third;
  assert.equal(controller.snapshot().search.phase, "loading");
});
test("guidance uses the supplied speaker and cancels owned speech when retired", async () => {
  const spoken = [];
  let failed = 0;
  const voice = new NavigationVoice(
    () => failed++,
    (text, signal) =>
      new Promise((resolve, reject) => {
        spoken.push({ text, signal });
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  voice.update("one", "First");
  voice.update("one", "First");
  assert.equal(spoken.length, 1);
  voice.update("two", "Second");
  assert.equal(spoken[0].signal.aborted, true);
  voice.pause();
  assert.equal(spoken[1].signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed, 0);
});
