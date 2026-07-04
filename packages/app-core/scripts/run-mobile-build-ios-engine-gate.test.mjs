/** Exercises run mobile build ios engine gate behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

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

describe("iOS full-Bun engine embed gate", () => {
  it("default/empty env does NOT embed the engine (the prod-regression default)", () => {
    // This is exactly the state the apple-store-release.yml build job shipped
    // before the fix: no variant, no engine flag → a cloud-only thin client.
    expect(isIosAppStoreBuild({})).toBe(false);
    expect(shouldIncludeIosFullBunEngine({})).toBe(false);
  });

  it("a plain direct build does not embed the engine", () => {
    const env = { ELIZA_BUILD_VARIANT: "direct" };
    expect(isIosAppStoreBuild(env)).toBe(false);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("ELIZA_BUILD_VARIANT=store embeds the engine by default", () => {
    const env = { ELIZA_BUILD_VARIANT: "store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("ELIZA_BUILD_VARIANT=store is case-insensitive", () => {
    expect(
      shouldIncludeIosFullBunEngine({ ELIZA_BUILD_VARIANT: "STORE" }),
    ).toBe(true);
  });

  it("ELIZA_RELEASE_AUTHORITY=apple-app-store embeds the engine by default", () => {
    const env = { ELIZA_RELEASE_AUTHORITY: "apple-app-store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("explicit ELIZA_IOS_FULL_BUN_ENGINE=1 embeds the engine even on a direct build", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("a store build can opt into a cloud-only thin client (no engine)", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("cloud-only opt-out is overridden by an explicit engine request", () => {
    // ELIZA_IOS_FULL_BUN_ENGINE is the unconditional force switch.
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("the production release env (post-fix) embeds the engine", () => {
    // Mirrors the env block now set on apple-store-release.yml's build-ios job.
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });
});
