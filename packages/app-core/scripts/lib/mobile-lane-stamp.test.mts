/**
 * Unit tests for the mobile build-lane guard decisions (issue #11030).
 *
 * These are the pure functions behind:
 *  - the dist-reuse / pre-Capacitor-sync lane assert in run-mobile-build.mjs,
 *  - the sideload staged-bundle preflight rule in
 *    packages/app/scripts/mobile-release-preflight.mjs.
 *
 * Runs in the packages/app-core vitest suite (`bun run --cwd packages/app-core
 * test`), i.e. the root `test:server` lane in CI.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateIosLocalLaneRuntime,
  evaluateStagedIosSideloadBundle,
  isLocalAgentRuntimeMode,
  rendererLaneStampMismatches,
  resolveExpectedRendererStamp,
} from "./mobile-lane-stamp.mjs";

/** Mirrors resolveMobileBuildPolicy() output for the lanes under test. */
const POLICIES = {
  "ios-local": {
    buildVariant: "direct",
    capacitorTarget: "ios",
    iosRuntimeMode: "local",
    androidRuntimeMode: null,
    runtimeExecutionMode: "local-safe",
  },
  ios: {
    buildVariant: "store",
    capacitorTarget: "ios",
    iosRuntimeMode: "cloud-hybrid",
    androidRuntimeMode: null,
    runtimeExecutionMode: "local-safe",
  },
  android: {
    buildVariant: "direct",
    capacitorTarget: "android",
    iosRuntimeMode: null,
    androidRuntimeMode: "local",
    runtimeExecutionMode: "local-yolo",
  },
  "android-cloud": {
    buildVariant: "store",
    capacitorTarget: "android",
    iosRuntimeMode: null,
    androidRuntimeMode: "cloud",
    runtimeExecutionMode: "cloud",
  },
} as const;

describe("resolveExpectedRendererStamp", () => {
  it("throws without a policy", () => {
    expect(() =>
      resolveExpectedRendererStamp({ policy: undefined as never }),
    ).toThrow(/policy is required/);
  });

  it("ios-local defaults bake variant=direct target=ios runtimeMode=local", () => {
    expect(
      resolveExpectedRendererStamp({ policy: POLICIES["ios-local"], env: {} }),
    ).toEqual({
      variant: "direct",
      capacitorTarget: "ios",
      runtimeMode: "local",
    });
  });

  it("ios (store) lane bakes variant=store runtimeMode=cloud-hybrid", () => {
    expect(
      resolveExpectedRendererStamp({ policy: POLICIES.ios, env: {} }),
    ).toEqual({
      variant: "store",
      capacitorTarget: "ios",
      runtimeMode: "cloud-hybrid",
    });
  });

  it("a pre-set VITE_ELIZA_IOS_RUNTIME_MODE wins over the iOS policy default (mirrors buildWeb)", () => {
    expect(
      resolveExpectedRendererStamp({
        policy: POLICIES["ios-local"],
        env: { VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid" },
      }).runtimeMode,
    ).toBe("cloud-hybrid");
  });

  it("a pre-set ELIZA_BUILD_VARIANT wins over the policy variant (mirrors buildWeb)", () => {
    expect(
      resolveExpectedRendererStamp({
        policy: POLICIES["ios-local"],
        env: { ELIZA_BUILD_VARIANT: "store" },
      }).variant,
    ).toBe("store");
  });

  it("android lanes take the policy android runtime mode unconditionally", () => {
    expect(
      resolveExpectedRendererStamp({
        policy: POLICIES["android-cloud"],
        env: { VITE_ELIZA_ANDROID_RUNTIME_MODE: "local" },
      }).runtimeMode,
    ).toBe("cloud");
  });

  it("a leaked iOS VITE mode shadows the android mode on android lanes (vite plugin ?? precedence)", () => {
    // The renderer-build-manifest vite plugin reads
    // VITE_ELIZA_IOS_RUNTIME_MODE ?? VITE_ELIZA_ANDROID_RUNTIME_MODE ?? ELIZA_RUNTIME_MODE;
    // the expectation must model the same precedence or the guard would flag
    // every android build run from a shell with leftover iOS env.
    expect(
      resolveExpectedRendererStamp({
        policy: POLICIES.android,
        env: { VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid" },
      }).runtimeMode,
    ).toBe("cloud-hybrid");
  });

  it("falls back to ELIZA_RUNTIME_MODE only when the policy has no execution mode", () => {
    const noModes = {
      buildVariant: "direct",
      capacitorTarget: null,
      iosRuntimeMode: null,
      androidRuntimeMode: null,
      runtimeExecutionMode: null,
    };
    expect(
      resolveExpectedRendererStamp({
        policy: noModes,
        env: { ELIZA_RUNTIME_MODE: "cloud" },
      }).runtimeMode,
    ).toBe("cloud");
    expect(
      resolveExpectedRendererStamp({ policy: noModes, env: {} }).runtimeMode,
    ).toBeNull();
  });
});

describe("rendererLaneStampMismatches", () => {
  const expected = {
    variant: "direct",
    capacitorTarget: "ios",
    runtimeMode: "local",
  };

  it("returns no mismatches for an exact match", () => {
    expect(
      rendererLaneStampMismatches(
        { variant: "direct", capacitorTarget: "ios", runtimeMode: "local" },
        expected,
      ),
    ).toEqual([]);
  });

  it("flags a missing manifest", () => {
    const mismatches = rendererLaneStampMismatches(null, expected);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/no renderer build manifest/);
  });

  it("flags the exact #11030 leak: a store/cloud dist under a local lane", () => {
    const mismatches = rendererLaneStampMismatches(
      {
        variant: "store",
        capacitorTarget: "ios",
        runtimeMode: "cloud-hybrid",
      },
      expected,
    );
    expect(mismatches).toEqual([
      "dist variant is 'store' but this lane bakes 'direct'",
      "dist runtime mode is 'cloud-hybrid' but this lane bakes 'local'",
    ]);
  });

  it("flags a manifest with no runtime mode when the lane bakes one", () => {
    const mismatches = rendererLaneStampMismatches(
      { variant: "direct", capacitorTarget: "ios" },
      expected,
    );
    expect(mismatches).toEqual([
      "dist runtime mode is (unset) but this lane bakes 'local'",
    ]);
  });

  it("treats null and missing as equal when the lane bakes no mode", () => {
    expect(
      rendererLaneStampMismatches(
        { variant: "direct", capacitorTarget: null },
        { variant: "direct", capacitorTarget: null, runtimeMode: null },
      ),
    ).toEqual([]);
  });

  it("flags a wrong capacitor target", () => {
    expect(
      rendererLaneStampMismatches(
        { variant: "direct", capacitorTarget: "android", runtimeMode: "local" },
        expected,
      ),
    ).toEqual(["dist capacitor target is 'android' but this lane bakes 'ios'"]);
  });
});

describe("isLocalAgentRuntimeMode", () => {
  it("mirrors the native AgentPlugin.swift local-mode aliases", () => {
    for (const mode of ["local", "ios-local", "sideload-local", "dev-local"]) {
      expect(isLocalAgentRuntimeMode(mode)).toBe(true);
    }
    expect(isLocalAgentRuntimeMode(" Local ")).toBe(true);
    for (const mode of ["cloud", "cloud-hybrid", "", null, undefined]) {
      expect(isLocalAgentRuntimeMode(mode)).toBe(false);
    }
  });
});

describe("evaluateIosLocalLaneRuntime", () => {
  it("only the ios-local lane has a rule", () => {
    for (const platform of ["ios", "android", "android-cloud", "ios-overlay"]) {
      expect(
        evaluateIosLocalLaneRuntime({
          platform,
          runtimeMode: "cloud-hybrid",
          env: {},
        }).ok,
      ).toBe(true);
    }
  });

  it("passes when the lane bakes local mode", () => {
    expect(
      evaluateIosLocalLaneRuntime({
        platform: "ios-local",
        runtimeMode: "local",
        env: {},
      }).ok,
    ).toBe(true);
  });

  it("fails the #11030 hang combination: cloud mode with no Agent.apiBase", () => {
    const verdict = evaluateIosLocalLaneRuntime({
      platform: "ios-local",
      runtimeMode: "cloud-hybrid",
      env: {},
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/Booting up/);
    expect(verdict.reason).toMatch(/#11030/);
    expect(verdict.reason).toMatch(/VITE_ELIZA_IOS_API_BASE/);
  });

  it("fails a dist with NO runtime mode at all (null) without an apiBase", () => {
    expect(
      evaluateIosLocalLaneRuntime({
        platform: "ios-local",
        runtimeMode: null,
        env: {},
      }).ok,
    ).toBe(false);
  });

  it("allows an intentional cloud sideload with an explicit apiBase", () => {
    for (const env of [
      { VITE_ELIZA_IOS_API_BASE: "https://agent.example.com" },
      { VITE_ELIZA_MOBILE_API_BASE: "https://agent.example.com" },
    ]) {
      const verdict = evaluateIosLocalLaneRuntime({
        platform: "ios-local",
        runtimeMode: "cloud-hybrid",
        env,
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.reason).toContain("https://agent.example.com");
    }
  });

  it("a whitespace-only apiBase does not count", () => {
    expect(
      evaluateIosLocalLaneRuntime({
        platform: "ios-local",
        runtimeMode: "cloud",
        env: { VITE_ELIZA_IOS_API_BASE: "   " },
      }).ok,
    ).toBe(false);
  });
});

describe("evaluateStagedIosSideloadBundle", () => {
  it("passes with staged: false when nothing is staged yet", () => {
    const verdict = evaluateStagedIosSideloadBundle({
      agentConfig: null,
      rendererManifest: null,
    });
    expect(verdict).toMatchObject({ ok: true, staged: false });
  });

  it("passes when both staged halves are local-mode", () => {
    expect(
      evaluateStagedIosSideloadBundle({
        agentConfig: { runtimeMode: "local", apiBase: "" },
        rendererManifest: { runtimeMode: "local" },
      }),
    ).toMatchObject({ ok: true, staged: true });
  });

  it("accepts native local-mode aliases", () => {
    expect(
      evaluateStagedIosSideloadBundle({
        agentConfig: { runtimeMode: "dev-local", apiBase: "" },
        rendererManifest: null,
      }).ok,
    ).toBe(true);
  });

  it("fails the exact #11030 combination: staged cloud mode, no apiBase", () => {
    const verdict = evaluateStagedIosSideloadBundle({
      agentConfig: { runtimeMode: "cloud", apiBase: "" },
      rendererManifest: { runtimeMode: "cloud" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.staged).toBe(true);
    expect(verdict.reason).toMatch(/Booting up/);
    expect(verdict.reason).toMatch(/build:ios:local/);
    expect(verdict.reason).toMatch(/VITE_ELIZA_IOS_API_BASE/);
  });

  it("fails a torn bake: local native config but a cloud renderer stamp", () => {
    // A cloud renderer never selects the local IPC transport, so a local
    // native agent alone cannot save the boot — both halves must be local.
    expect(
      evaluateStagedIosSideloadBundle({
        agentConfig: { runtimeMode: "local", apiBase: "" },
        rendererManifest: { runtimeMode: "cloud-hybrid" },
      }).ok,
    ).toBe(false);
  });

  it("fails when a staged bundle carries no runtime mode anywhere", () => {
    const verdict = evaluateStagedIosSideloadBundle({
      agentConfig: { runtimeMode: "", apiBase: "" },
      rendererManifest: { runtimeMode: null },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/no runtime mode staged at all/);
  });

  it("passes any staged mode when Agent.apiBase is configured", () => {
    const verdict = evaluateStagedIosSideloadBundle({
      agentConfig: {
        runtimeMode: "cloud-hybrid",
        apiBase: "https://agent.example.com",
      },
      rendererManifest: { runtimeMode: "cloud-hybrid" },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("https://agent.example.com");
  });

  it("a whitespace-only apiBase does not count", () => {
    expect(
      evaluateStagedIosSideloadBundle({
        agentConfig: { runtimeMode: "cloud", apiBase: "  " },
        rendererManifest: null,
      }).ok,
    ).toBe(false);
  });
});
