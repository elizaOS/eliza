/** Exercises run mobile build ios engine gate behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isIosAppStoreBuild,
  removeIosLocalExecutionAssets,
  resolveIosBuildEnvironment,
  resolveIosBuildTargetPolicy,
  resolveIosCapacitorSyncEnv,
  resolveIosCustomPods,
  resolveIosLocalPayloadDecision,
  resolveMobileBuildPolicy,
  shouldIncludeIosFullBunEngine,
  shouldIncludeIosMobileAgentBridge,
} from "./run-mobile-build.mjs";

// Regression coverage for the prod iOS local-agent failure: an App Store /
// TestFlight build that ships without the on-device Bun engine leaves the
// in-app "start local agent" path with no runtime, and (being a non-dev build)
// the JSContext compatibility fallback is disabled — so it hard-fails with
// "the JSContext compatibility transport is disabled outside iOS development
// builds". The fix is to flag the release build as a store build so the engine
// is embedded; these tests lock that contract on the build script's own gate.

describe("iOS full-Bun engine embed gate", () => {
  it("makes the named pure-cloud target authoritative over a contaminated parent environment", () => {
    const env = resolveIosBuildEnvironment("ios-cloud", {
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "1",
    });
    const targetPolicy = resolveIosBuildTargetPolicy("ios-cloud");
    const payload = resolveIosLocalPayloadDecision(targetPolicy, env);

    expect(resolveMobileBuildPolicy("ios-cloud")).toMatchObject({
      capacitorTarget: "ios",
      buildVariant: "store",
      iosRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "apple-app-store",
    });
    expect(env).toMatchObject({
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "0",
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
    });
    expect(isIosAppStoreBuild(env)).toBe(true);
    expect(shouldIncludeIosFullBunEngine(env)).toBe(false);
    expect(shouldIncludeIosMobileAgentBridge(env)).toBe(false);
    expect(payload).toEqual({
      includesFullBunRuntime: false,
      includesLocalAgentPayload: false,
      removeStaleLocalExecutionAssets: true,
    });
    expect(
      new Map(
        resolveIosCustomPods({
          appStoreBuild: isIosAppStoreBuild(env),
          includeFullBunEngine: payload.includesFullBunRuntime,
          includeMobileAgentBridge: shouldIncludeIosMobileAgentBridge(env),
        }),
      ).has("ElizaosCapacitorMobileAgentBridge"),
    ).toBe(false);
  });

  it("removes every stale local payload path from a dirty pure-cloud tree", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-ios-cloud-assets-"),
    );
    const publicDir = path.join(fixtureRoot, "public");
    const agentDir = path.join(publicDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "agent-bundle.js"), "stale");
    fs.writeFileSync(path.join(publicDir, "vector.tar.gz"), "stale");
    fs.writeFileSync(path.join(publicDir, "fuzzystrmatch.tar.gz"), "stale");

    try {
      const payload = resolveIosLocalPayloadDecision(
        resolveIosBuildTargetPolicy("ios-cloud"),
        {
          ELIZA_BUILD_VARIANT: "direct",
          ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
          ELIZA_IOS_FULL_BUN_ENGINE: "1",
        },
      );
      expect(payload.removeStaleLocalExecutionAssets).toBe(true);
      expect(removeIosLocalExecutionAssets(publicDir)).toBe(3);
      expect(fs.readdirSync(publicDir)).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("retains the supported hybrid engine and local compatibility payloads", () => {
    expect(
      resolveIosLocalPayloadDecision(
        resolveIosBuildTargetPolicy("ios"),
        resolveIosBuildEnvironment("ios"),
      ),
    ).toEqual({
      includesFullBunRuntime: true,
      includesLocalAgentPayload: true,
      removeStaleLocalExecutionAssets: false,
    });
    expect(
      resolveIosLocalPayloadDecision(
        resolveIosBuildTargetPolicy("ios-local"),
        resolveIosBuildEnvironment("ios-local", {
          ELIZA_IOS_FULL_BUN_ENGINE: "0",
        }),
      ),
    ).toEqual({
      includesFullBunRuntime: false,
      includesLocalAgentPayload: true,
      removeStaleLocalExecutionAssets: false,
    });
    expect(
      resolveIosLocalPayloadDecision(
        resolveIosBuildTargetPolicy("ios"),
        resolveIosBuildEnvironment("ios", {
          ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
        }),
      ),
    ).toEqual({
      includesFullBunRuntime: false,
      includesLocalAgentPayload: false,
      removeStaleLocalExecutionAssets: true,
    });
  });

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

  it("defers the full engine dependency until the repository Podfile is generated", () => {
    const env = {
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
    };

    expect(resolveIosCapacitorSyncEnv(env)).toEqual({
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
    });
    expect(env.ELIZA_IOS_FULL_BUN_ENGINE).toBe("1");
  });

  it("preserves compatibility-only Capacitor sync environments", () => {
    expect(
      resolveIosCapacitorSyncEnv({ ELIZA_IOS_RUNTIME_MODE: "local" }),
    ).toEqual({ ELIZA_IOS_RUNTIME_MODE: "local" });
  });
});
