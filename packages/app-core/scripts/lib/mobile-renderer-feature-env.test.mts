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

  it("enables realtime without forced eligibility for both Android Cloud lanes", () => {
    for (const platform of ["android-cloud", "android-cloud-debug"]) {
      expect(resolveMobileRendererFeatureEnv({ platform })).toEqual({
        VITE_VOICE_REALTIME_WS: "1",
        VITE_VOICE_REALTIME_FORCE: "0",
      });
    }

    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud-debug",
        env: { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" },
      }),
    ).toEqual({
      VITE_VOICE_REALTIME_WS: "1",
      VITE_VOICE_REALTIME_FORCE: "0",
    });
  });

  it("overrides an ambient force flag in Android Cloud artifacts", () => {
    for (const platform of ["android-cloud", "android-cloud-debug"]) {
      expect(
        resolveMobileRendererFeatureEnv({
          platform,
          env: { VITE_VOICE_REALTIME_FORCE: "1" },
        }),
      ).toEqual({
        VITE_VOICE_REALTIME_WS: "1",
        VITE_VOICE_REALTIME_FORCE: "0",
      });
    }
  });

  it("permanently hides Stream only in the dedicated LP3 VPS fallback", () => {
    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud-debug",
        env: {
          ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1",
          ELIZA_ANDROID_LP3_REMOTE_FALLBACK_REQUIRED: "yes",
        },
      }),
    ).toEqual({
      VITE_VOICE_REALTIME_WS: "1",
      VITE_VOICE_REALTIME_FORCE: "0",
      VITE_ENABLE_STREAM: "false",
      VITE_ELIZA_ANDROID_LP3_SHARED_BROWSER_STORAGE: "1",
    });
  });

  it("stamps the launcher-only in-app auth renderer contract", () => {
    expect(
      resolveMobileRendererFeatureEnv({ platform: "android-launcher" }),
    ).toEqual({ VITE_ELIZA_ANDROID_LAUNCHER_BUILD: "1" });
  });

  it("does not leak LP3-only fallback flags into the Android Cloud release lane", () => {
    expect(
      resolveMobileRendererFeatureEnv({
        platform: "android-cloud",
        env: { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" },
      }),
    ).toEqual({
      VITE_VOICE_REALTIME_WS: "1",
      VITE_VOICE_REALTIME_FORCE: "0",
    });
  });

  it("requires an explicit platform", () => {
    expect(() => resolveMobileRendererFeatureEnv()).toThrow(
      /platform is required/,
    );
  });
});

describe("mobileRendererRequiresFreshBuild", () => {
  it("rebuilds renderers whose optional flags are not stamped", () => {
    for (const platform of [
      "android-cloud",
      "android-cloud-debug",
      "android-launcher",
      "ios",
      "ios-local",
    ]) {
      expect(mobileRendererRequiresFreshBuild({ platform })).toBe(true);
    }
    for (const platform of ["android", "ios-overlay"]) {
      expect(mobileRendererRequiresFreshBuild({ platform })).toBe(false);
    }
  });
});

describe("mobileRendererUnstampedFeatureProblem", () => {
  it("requires explicit risk acknowledgement only for features absent from the stamp", () => {
    expect(
      mobileRendererUnstampedFeatureProblem({ platform: "ios-local" }),
    ).toContain("runtime chooser");
    expect(
      mobileRendererUnstampedFeatureProblem({
        platform: "android-cloud-debug",
      }),
    ).toContain("realtime voice flags");
    expect(
      mobileRendererUnstampedFeatureProblem({ platform: "android-cloud" }),
    ).toContain("realtime voice flags");
    expect(
      mobileRendererUnstampedFeatureProblem({ platform: "android-launcher" }),
    ).toContain("in-app auth contract");
    for (const platform of ["ios", "ios-overlay", "android"]) {
      expect(mobileRendererUnstampedFeatureProblem({ platform })).toBeNull();
    }
  });

  it("rejects a missing platform", () => {
    expect(() => mobileRendererUnstampedFeatureProblem()).toThrow(
      /platform is required/,
    );
  });
});
