import assert from "node:assert/strict";
import test from "node:test";
import { NativeMapsLocation } from "../src/client/native-location.ts";

function bridge() {
  const listeners = {};
  const cleared = [];
  return {
    listeners,
    cleared,
    async checkPermissions() {
      return { location: "granted", accuracy: "precise" };
    },
    async requestPermissions() {
      return { location: "granted", accuracy: "precise" };
    },
    async cancelPermissionRequest() {},
    async watchPosition() {
      return { watchId: "watch-1" };
    },
    async clearWatch(options) {
      cleared.push(options.watchId);
    },
    async addListener(name, callback) {
      listeners[name] = callback;
      return { remove: async () => {} };
    },
  };
}

const fix = (timestamp) => ({
  coords: { latitude: 37.77, longitude: -122.42, accuracy: 8, timestamp },
  cached: false,
});

test("a stale or future-dated fix is skipped and the watch keeps running", async () => {
  const location = bridge();
  const native = new NativeMapsLocation(location, {
    isNative: () => true,
    available: () => true,
  });
  const fixes = [];
  const errors = [];
  await native.start(
    false,
    (position) => fixes.push(position),
    (error) => errors.push(error),
  );
  location.listeners.locationChange(fix(Date.now() - 60_000));
  location.listeners.locationChange(fix(Date.now() + 60_000));
  assert.deepEqual(errors, []);
  assert.deepEqual(fixes, []);
  assert.deepEqual(location.cleared, []);

  const now = Date.now();
  location.listeners.locationChange(fix(now));
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].timestamp, now);
  assert.deepEqual(errors, []);
  assert.deepEqual(location.cleared, []);
  await native.stop();
  assert.deepEqual(location.cleared, ["watch-1"]);
});

test("a malformed fix still stops the watch with an error", async () => {
  const location = bridge();
  const native = new NativeMapsLocation(location, {
    isNative: () => true,
    available: () => true,
  });
  const errors = [];
  await native.start(
    false,
    () => assert.fail("a malformed fix must not be reported"),
    (error) => errors.push(error),
  );
  location.listeners.locationChange({
    coords: { ...fix(Date.now()).coords, accuracy: -1 },
    cached: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "invalid-response");
  assert.deepEqual(location.cleared, ["watch-1"]);
});
