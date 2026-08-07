/**
 * Locks the mobile renderer feature boundary that keeps LP3 realtime voice in
 * the packaged APK and prevents cross-feature reuse of debug renderer output.
 */
import { describe, expect, it } from "vitest";
import {
  mobileRendererRequiresFreshBuild,
  resolveMobileRendererFeatureEnv,
} from "./mobile-renderer-feature-env.mjs";

describe("resolveMobileRendererFeatureEnv", () => {
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
});

describe("mobileRendererRequiresFreshBuild", () => {
  it("rebuilds cloud-debug renderers because their optional flags are not stamped", () => {
    expect(
      mobileRendererRequiresFreshBuild({ platform: "android-cloud-debug" }),
    ).toBe(true);
    for (const platform of ["android", "android-cloud", "ios", "ios-local"]) {
      expect(mobileRendererRequiresFreshBuild({ platform })).toBe(false);
    }
  });
});
