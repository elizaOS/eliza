/** Exercises run mobile build ios engine gate behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

import {
  isIosAppStoreBuild,
  resolveIosDeploymentTarget,
  resolveMobileBuildPolicy,
  shouldIncludeIosFullBunEngine,
} from "./run-mobile-build.mjs";

// Launch builds intentionally omit the local runtime. The gate still guarantees
// that an explicitly local-enabled custom store build embeds the engine instead
// of advertising a runtime that the IPA cannot start.

describe("iOS full-Bun engine embed gate", () => {
  it("does not embed the engine without an explicit local-runtime request", () => {
    expect(isIosAppStoreBuild({})).toBe(false);
    expect(shouldIncludeIosFullBunEngine({})).toBe(false);
  });

  it("a plain direct build does not embed the engine", () => {
    const env = { ELIZA_BUILD_VARIANT: "direct" };
    expect(isIosAppStoreBuild(env)).toBe(false);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("ELIZA_BUILD_VARIANT=store is Cloud-only by default", () => {
    const env = { ELIZA_BUILD_VARIANT: "store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("ELIZA_BUILD_VARIANT=store is case-insensitive", () => {
    expect(
      shouldIncludeIosFullBunEngine({ ELIZA_BUILD_VARIANT: "STORE" }),
    ).toBe(false);
  });

  it("ELIZA_RELEASE_AUTHORITY=apple-app-store remains Cloud-only by default", () => {
    const env = { ELIZA_RELEASE_AUTHORITY: "apple-app-store" };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });

  it("explicit ELIZA_IOS_FULL_BUN_ENGINE=1 embeds the engine even on a direct build", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
    };
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
  });

  it("a store build can opt into the local runtime", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(true);
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

  it("the production release env remains Cloud-only", () => {
    const env = {
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
    };
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
  });
});

describe("iOS renderer build policy", () => {
  it("makes the tracked iOS lane Cloud-only", () => {
    expect(resolveMobileBuildPolicy("ios")).toMatchObject({
      buildVariant: "store",
      capacitorTarget: "ios",
      iosRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "apple-app-store",
    });
  });

  it("retains local execution as an explicit lane", () => {
    expect(resolveMobileBuildPolicy("ios-local")).toMatchObject({
      buildVariant: "direct",
      capacitorTarget: "ios",
      iosRuntimeMode: "local",
      runtimeExecutionMode: "local-safe",
      releaseAuthority: "developer-toolchain",
    });
  });
});

describe("iOS deployment target", () => {
  it("keeps Cloud launch and explicit local builds on the HTTPS callback floor", () => {
    expect(resolveIosDeploymentTarget({})).toBe("17.4");
    expect(resolveIosDeploymentTarget({ ELIZA_IOS_FULL_BUN_ENGINE: "1" })).toBe(
      "17.4",
    );
  });
});
