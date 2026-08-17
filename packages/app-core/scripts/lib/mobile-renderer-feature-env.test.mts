/**
 * Locks the mobile renderer feature boundaries for local iOS onboarding and
 * LP3 realtime voice while preventing cross-feature renderer reuse.
 */
import { describe, expect, it } from "vitest";
import {
  mobileRendererRequiresFreshBuild,
  mobileRendererUnstampedFeatureProblem,
  resolveMobileRendererFeatureEnv,
} from "./mobile-renderer-feature-env.mjs";

describe("resolveMobileRendererFeatureEnv", () => {
  it("enables the runtime chooser only for the local iOS lane", () => {
    expect(resolveMobileRendererFeatureEnv({ platform: "ios-local" })).toEqual({
      VITE_ELIZA_ENABLE_RUNTIME_CHOOSER: "1",
    });

    for (const platform of ["ios", "ios-overlay", "android"]) {
      expect(resolveMobileRendererFeatureEnv({ platform })).toEqual({});
    }
  });

  it("enables the realtime voice client for the LP3 cloud-debug lane", () => {
    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud-debug",
        env: { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" },
      }),
    ).toEqual({
      VITE_VOICE_REALTIME_WS: "1",
      VITE_VOICE_REALTIME_FORCE: "1",
    });
  });

  it("does not change ordinary Android cloud-debug builds", () => {
    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud-debug",
        env: {},
      }),
    ).toEqual({});
  });

  it("does not leak LP3 renderer flags into another lane", () => {
    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud",
        env: { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" },
      }),
    ).toEqual({});
  });

  it("requires an explicit platform", () => {
    expect(() => resolveMobileRendererFeatureEnv()).toThrow(
      /platform is required/,
    );
  });

  it("requires the explicit stale-risk override before reusing unstamped lanes", () => {
    for (const platform of [
      "ios",
      "ios-local",
      "ios-overlay",
      "android-cloud-debug",
    ]) {
      expect(mobileRendererUnstampedFeatureProblem({ platform })).toContain(
        "not stamped",
      );
    }
    expect(
      mobileRendererUnstampedFeatureProblem({ platform: "android" }),
    ).toBeNull();
  });
});

describe("mobileRendererRequiresFreshBuild", () => {
  it("rebuilds renderers whose optional flags are not stamped", () => {
    expect(
      mobileRendererRequiresFreshBuild({ platform: "android-cloud-debug" }),
    ).toBe(true);
    for (const platform of ["ios", "ios-local", "ios-overlay"]) {
      expect(mobileRendererRequiresFreshBuild({ platform })).toBe(true);
    }
    for (const platform of ["android", "android-cloud"]) {
      expect(mobileRendererRequiresFreshBuild({ platform })).toBe(false);
    }
  });
});
