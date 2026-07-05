/**
 * End-state contract self-tests for the mobile-auth simulator smoke (#13693).
 *
 * `test:sim:auth` fires a synthetic `<scheme>://auth/callback` deep link and then
 * reads back what the in-app handler wrote to Capacitor Preferences. The value of
 * the lane is entirely in the READBACK assertion: `assertAuthCallbackResult` is
 * the single shared contract both the iOS poll and the Android poll run against,
 * so a regression that made the smoke "pass on delivery alone" (the exact silent
 * pass the issue calls out) is caught here, not only in a simulator.
 *
 * These run under the Node built-in test runner (`node --test`) — no vitest, no
 * package deps — so they exercise the real exported decision logic even on a
 * disk-contended host with no install. The vitest twin
 * (`test/scripts/mobile-auth-simulator-smoke.test.ts`) covers the same surface in
 * the app-core lane; this file guarantees the pure contract is verifiable
 * standalone and, when a simulator is booted, round-trips the assertion through
 * the REAL `xcrun simctl defaults` store the app-side verifier writes into.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  assertAuthCallbackResult,
  buildAndroidPreferenceXml,
  buildCallbackUrl,
  expectedAuthCallbackFromUrl,
  readAndroidPreferenceFromXml,
} from "./mobile-auth-simulator-smoke.mjs";

const CALLBACK_URL =
  "elizaos://auth/callback?state=simulator-oauth-state&code=simulator-oauth-code";
const AUTH_CALLBACK_RESULT_KEY = "eliza:auth-callback-smoke:result";
const expected = expectedAuthCallbackFromUrl(CALLBACK_URL);

// The exact payload shape `recordIosAuthCallbackSmoke` (packages/app/src/main.tsx)
// writes for the default synthetic callback: rejected, classified, session
// unchanged. Kept in lock-step with that handler — if the app writes a different
// shape, the assertion (and this fixture) must move together.
const HANDLED_RESULT = {
  ok: true,
  phase: "handled",
  classification: "synthetic_callback_rejected",
  accepted: false,
  sessionEstablished: false,
  sessionChanged: false,
  activeServerBeforePresent: false,
  activeServerAfterPresent: false,
  path: expected.path,
  state: expected.state,
  code: expected.code,
};

test("expectedAuthCallbackFromUrl extracts the path/state/code the app must echo", () => {
  assert.deepEqual(expected, {
    path: "auth/callback",
    state: "simulator-oauth-state",
    code: "simulator-oauth-code",
  });
});

test("buildCallbackUrl targets the app's own scheme", () => {
  const url = buildCallbackUrl(
    { urlScheme: "elizaos" },
    { path: "auth/callback", query: "state=s&code=c", url: "" },
  );
  assert.equal(url, "elizaos://auth/callback?state=s&code=c");
});

test("accepts a handled callback that did NOT change the session", () => {
  assert.equal(
    assertAuthCallbackResult(HANDLED_RESULT, expected, "iOS"),
    HANDLED_RESULT,
  );
});

test("accepts an already-authenticated simulator when the session is untouched", () => {
  const preAuthenticated = {
    ...HANDLED_RESULT,
    sessionEstablished: true,
    activeServerBeforePresent: true,
    activeServerAfterPresent: true,
  };
  assert.equal(
    assertAuthCallbackResult(preAuthenticated, expected, "iOS"),
    preAuthenticated,
  );
});

test("RED: rejects a deliver-only echo (no classification, no readback)", () => {
  const deliverOnly = {
    ok: true,
    phase: "handled",
    path: expected.path,
    state: expected.state,
    code: expected.code,
  };
  assert.throws(
    () => assertAuthCallbackResult(deliverOnly, expected, "iOS"),
    /callback was not classified/,
  );
});

test("RED: rejects a session readback with no classification", () => {
  assert.throws(
    () =>
      assertAuthCallbackResult(
        { ...HANDLED_RESULT, classification: undefined },
        expected,
        "iOS",
      ),
    /callback was not classified/,
  );
});

test("RED: rejects a classified-but-not-explicitly-rejected callback", () => {
  assert.throws(
    () =>
      assertAuthCallbackResult(
        { ...HANDLED_RESULT, accepted: true },
        expected,
        "iOS",
      ),
    /not explicitly rejected/,
  );
});

test("RED: rejects a callback that authenticated/swapped the session (security regression)", () => {
  assert.throws(
    () =>
      assertAuthCallbackResult(
        { ...HANDLED_RESULT, sessionEstablished: true, sessionChanged: true },
        expected,
        "iOS",
      ),
    /changed the active session/,
  );
});

test("RED: rejects a payload with no callback-specific session comparison", () => {
  assert.throws(
    () =>
      assertAuthCallbackResult(
        { ...HANDLED_RESULT, sessionChanged: undefined },
        expected,
        "iOS",
      ),
    /no auth outcome surfaced/,
  );
});

test("RED: still enforces the delivery echo (path/state/code)", () => {
  assert.throws(
    () =>
      assertAuthCallbackResult(
        { ...HANDLED_RESULT, state: "tampered" },
        expected,
        "iOS",
      ),
    /query mismatch/,
  );
});

test("Android Preferences XML round-trips the auth-callback result key", () => {
  // The Android leg seeds/reads the same handshake through
  // shared_prefs/CapacitorStorage.xml; the poll only classifies what it can parse
  // back out, so the serialize→parse round-trip must be lossless.
  const xml = buildAndroidPreferenceXml({
    [AUTH_CALLBACK_RESULT_KEY]: JSON.stringify(HANDLED_RESULT),
  });
  const raw = readAndroidPreferenceFromXml(xml, AUTH_CALLBACK_RESULT_KEY);
  assert.ok(raw, "expected the result key to round-trip out of the XML");
  assert.deepEqual(
    assertAuthCallbackResult(JSON.parse(raw), expected, "Android"),
    {
      ...HANDLED_RESULT,
    },
  );
});

// When a simulator is booted with the app installed, prove the assertion runs
// against the REAL `xcrun simctl defaults` store the in-app verifier writes into
// — not just an in-memory fixture. Skipped (never failed) when no booted device,
// no `xcrun`, or the app is not installed, so this file stays green in headless CI.
test("live iOS defaults store round-trips the auth end-state assertion", (t) => {
  const device = bootedIosDevice();
  if (!device) {
    t.skip("no booted iOS simulator with the app installed");
    return;
  }
  const appId = "ai.elizaos.app";
  const nativeKey = `CapacitorStorage.${AUTH_CALLBACK_RESULT_KEY}`;
  simctl(device, ["defaults", "delete", appId, nativeKey]);
  try {
    simctl(device, [
      "defaults",
      "write",
      appId,
      nativeKey,
      "-string",
      JSON.stringify(HANDLED_RESULT),
    ]);
    const readback = simctl(device, ["defaults", "read", appId, nativeKey]);
    assert.ok(readback, "expected a readback from the real simulator store");
    const result = assertAuthCallbackResult(
      JSON.parse(readback),
      expected,
      "iOS auth callback (live-sim readback)",
    );
    assert.equal(result.classification, "synthetic_callback_rejected");
    assert.equal(result.sessionChanged, false);
  } finally {
    simctl(device, ["defaults", "delete", appId, nativeKey]);
  }
});

function simctl(device, args) {
  try {
    return execFileSync("xcrun", ["simctl", "spawn", device, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // error-policy:J3 optional simulator probes convert unavailable tools/domains into a typed empty readback.
    return "";
  }
}

function bootedIosDevice() {
  let listed = "";
  try {
    listed = execFileSync(
      "xcrun",
      ["simctl", "list", "devices", "booted", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // error-policy:J3 absent xcrun or no booted simulator means the live-only assertion is invalid for this host.
    return null;
  }
  let udid = null;
  try {
    const parsed = JSON.parse(listed);
    for (const devices of Object.values(parsed.devices ?? {})) {
      for (const device of devices) {
        if (device.state === "Booted" && device.udid) {
          udid = device.udid;
          break;
        }
      }
      if (udid) break;
    }
  } catch {
    // error-policy:J3 malformed simctl output is an invalid optional live-probe result, not a contract-test failure.
    return null;
  }
  if (!udid) return null;
  // Only claim the device when the app is actually installed — the live
  // round-trip reads/writes that app's Preferences domain.
  return tryAppContainer(udid, "ai.elizaos.app") ? udid : null;
}

function tryAppContainer(device, appId) {
  try {
    return execFileSync(
      "xcrun",
      ["simctl", "get_app_container", device, appId, "app"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    // error-policy:J3 missing installed app makes the live simulator store probe inapplicable on this host.
    return "";
  }
}
