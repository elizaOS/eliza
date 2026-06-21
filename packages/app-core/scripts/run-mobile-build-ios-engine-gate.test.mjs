import assert from "node:assert/strict";
import test from "node:test";

import {
  isIosAppStoreBuild,
  shouldIncludeIosFullBunEngine,
} from "./run-mobile-build.mjs";

// Regression coverage for the prod iOS local-agent failure: an App Store /
// TestFlight build that ships without the on-device Bun engine leaves the
// in-app "start local agent" path with no runtime, and (being a non-dev build)
// the JSContext compatibility fallback is disabled — so it hard-fails with
// "the JSContext compatibility transport is disabled outside iOS development
// builds". The fix is to flag the release build as a store build so the engine
// is embedded; these tests lock that contract on the build script's own gate.

test("default/empty env does NOT embed the engine (the prod-regression default)", () => {
  // This is exactly the state the apple-store-release.yml build job shipped
  // before the fix: no variant, no engine flag → a cloud-only thin client.
  assert.equal(isIosAppStoreBuild({}), false);
  assert.equal(shouldIncludeIosFullBunEngine({}), false);
});

test("a plain direct build does not embed the engine", () => {
  const env = { ELIZA_BUILD_VARIANT: "direct" };
  assert.equal(isIosAppStoreBuild(env), false);
  assert.equal(shouldIncludeIosFullBunEngine(env), false);
});

test("ELIZA_BUILD_VARIANT=store embeds the engine by default", () => {
  const env = { ELIZA_BUILD_VARIANT: "store" };
  assert.equal(isIosAppStoreBuild(env), true);
  assert.equal(shouldIncludeIosFullBunEngine(env), true);
});

test("ELIZA_BUILD_VARIANT=store is case-insensitive", () => {
  assert.equal(
    shouldIncludeIosFullBunEngine({ ELIZA_BUILD_VARIANT: "STORE" }),
    true,
  );
});

test("ELIZA_RELEASE_AUTHORITY=apple-app-store embeds the engine by default", () => {
  const env = { ELIZA_RELEASE_AUTHORITY: "apple-app-store" };
  assert.equal(isIosAppStoreBuild(env), true);
  assert.equal(shouldIncludeIosFullBunEngine(env), true);
});

test("explicit ELIZA_IOS_FULL_BUN_ENGINE=1 embeds the engine even on a direct build", () => {
  const env = { ELIZA_BUILD_VARIANT: "direct", ELIZA_IOS_FULL_BUN_ENGINE: "1" };
  assert.equal(shouldIncludeIosFullBunEngine(env), true);
});

test("a store build can opt into a cloud-only thin client (no engine)", () => {
  const env = {
    ELIZA_BUILD_VARIANT: "store",
    ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
  };
  assert.equal(isIosAppStoreBuild(env), true);
  assert.equal(shouldIncludeIosFullBunEngine(env), false);
});

test("cloud-only opt-out is overridden by an explicit engine request", () => {
  // ELIZA_IOS_FULL_BUN_ENGINE is the unconditional force switch.
  const env = {
    ELIZA_BUILD_VARIANT: "store",
    ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
    ELIZA_IOS_FULL_BUN_ENGINE: "1",
  };
  assert.equal(shouldIncludeIosFullBunEngine(env), true);
});

test("the production release env (post-fix) embeds the engine", () => {
  // Mirrors the env block now set on apple-store-release.yml's build-ios job.
  const env = {
    ELIZA_BUILD_VARIANT: "store",
    ELIZA_RELEASE_AUTHORITY: "apple-app-store",
    ELIZA_IOS_FULL_BUN_ENGINE: "1",
  };
  assert.equal(isIosAppStoreBuild(env), true);
  assert.equal(shouldIncludeIosFullBunEngine(env), true);
});
