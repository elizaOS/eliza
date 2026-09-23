/**
 * Checks mobile auth callback results after Android XML serialization and an
 * optional real iOS simulator preferences-store round trip using node:test.
 * Callback rejection, session integrity, URL parsing and target selection are
 * covered by test/scripts/mobile-auth-simulator-smoke.test.ts. The iOS check
 * writes a fixture to native preferences; it does not exercise deep-link delivery.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  assertAuthCallbackResult,
  buildAndroidPreferenceXml,
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
