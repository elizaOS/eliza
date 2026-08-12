/** Exercises run mobile build ios engine gate behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExpectedRendererStamp } from "./lib/mobile-lane-stamp.mjs";
import { mobileWebDistReuseStatus } from "./lib/mobile-web-build-reuse.mjs";
import {
  IOS_BUILD_TARGETS,
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
  it("forces the Capacitor target for every named iOS lane", () => {
    for (const targetName of Object.keys(IOS_BUILD_TARGETS)) {
      const inherited = { ELIZA_CAPACITOR_BUILD_TARGET: "android" };
      expect(resolveIosBuildEnvironment(targetName, inherited)).toMatchObject({
        ELIZA_CAPACITOR_BUILD_TARGET: "ios",
      });
      expect(inherited.ELIZA_CAPACITOR_BUILD_TARGET).toBe("android");
    }
  });

  it("makes the named pure-cloud target authoritative over a contaminated parent environment", () => {
    const env = resolveIosBuildEnvironment("ios-cloud", {
      ELIZA_CAPACITOR_BUILD_TARGET: "android",
      ELIZA_BUILD_VARIANT: "direct",
      ELIZA_RELEASE_AUTHORITY: "developer-toolchain",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "1",
      ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE: "1",
      ELIZA_IOS_SKIP_CAPACITOR_SYNC: "1",
      ELIZA_IOS_SKIP_POD_INSTALL: "1",
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
      ELIZA_CAPACITOR_BUILD_TARGET: "ios",
      ELIZA_BUILD_VARIANT: "store",
      ELIZA_RELEASE_AUTHORITY: "apple-app-store",
      ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      ELIZA_IOS_FULL_BUN_ENGINE: "0",
      ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE: "0",
      ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE: "0",
      ELIZA_IOS_SKIP_CAPACITOR_SYNC: "0",
      ELIZA_IOS_SKIP_POD_INSTALL: "0",
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

  it("permits only an exact fresh store/ios/cloud renderer when cloud reuse is requested", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-ios-cloud-renderer-"),
    );
    const appDir = path.join(fixtureRoot, "app");
    fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "dist", "index.html"), "<main></main>");

    try {
      const environment = resolveIosBuildEnvironment("ios-cloud", {
        ELIZA_MOBILE_SKIP_WEB_BUILD: "1",
        ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE: "1",
      });
      const expected = resolveExpectedRendererStamp({
        policy: resolveMobileBuildPolicy("ios-cloud"),
        env: environment,
      });
      const status = (manifest, buildNeeded = () => false) =>
        mobileWebDistReuseStatus({
          appDir,
          repoRoot: fixtureRoot,
          expectedVariant: expected.variant,
          expectedTarget: expected.capacitorTarget,
          expectedRuntimeMode: expected.runtimeMode,
          readManifest: () => manifest,
          buildNeeded,
        });

      expect(environment.ELIZA_MOBILE_SKIP_WEB_BUILD).toBe("1");
      expect(environment.ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE).toBe("0");
      expect(expected).toEqual({
        variant: "store",
        capacitorTarget: "ios",
        runtimeMode: "cloud",
      });
      expect(
        status({
          buildId: "direct-local",
          variant: "direct",
          capacitorTarget: "ios",
          runtimeMode: "local",
        }).reusable,
      ).toBe(false);
      expect(
        status({
          buildId: "store-hybrid",
          variant: "store",
          capacitorTarget: "ios",
          runtimeMode: "cloud-hybrid",
        }).reusable,
      ).toBe(false);
      const exactManifest = {
        buildId: "store-cloud",
        variant: "store",
        capacitorTarget: "ios",
        runtimeMode: "cloud",
      };
      expect(status(exactManifest).reusable).toBe(true);
      expect(status(exactManifest, () => true).reusable).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves incremental-build operator controls outside the pure-cloud lane", () => {
    const operatorControls = {
      ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE: "1",
      ELIZA_IOS_SKIP_CAPACITOR_SYNC: "1",
      ELIZA_IOS_SKIP_POD_INSTALL: "1",
    };
    expect(resolveIosBuildEnvironment("ios", operatorControls)).toMatchObject(
      operatorControls,
    );
    expect(
      resolveIosBuildEnvironment("ios-local", operatorControls),
    ).toMatchObject(operatorControls);
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
