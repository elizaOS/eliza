import { describe, expect, it } from "vitest";
import { readMobileRuntimeBuildTruth } from "../first-run/reconcile-mobile-runtime-mode";
import {
  resolveIosRuntimeConfig,
  resolveMobileApiConnection,
} from "./ios-runtime";

describe("mobile runtime configuration", () => {
  it.each(["ios", "android"] as const)(
    "isolates %s credentials from the other platform",
    (platform) => {
      const other = platform === "ios" ? "ANDROID" : "IOS";
      expect(
        resolveMobileApiConnection(platform, {
          [`VITE_ELIZA_${other}_API_BASE`]: "https://other.example",
          [`VITE_ELIZA_${other}_API_TOKEN`]: "other-token",
        }),
      ).toEqual({});
      expect(
        resolveMobileApiConnection(platform, {
          VITE_ELIZA_MOBILE_API_BASE: "https://shared.example/",
          VITE_ELIZA_MOBILE_API_TOKEN: "shared-token",
          [`VITE_ELIZA_${platform.toUpperCase()}_API_BASE`]:
            " https://platform.example/// ",
        }),
      ).toEqual({
        apiBase: "https://platform.example",
        apiToken: "shared-token",
      });
    },
  );

  it("does not let Android mode select iOS transport", () => {
    expect(
      resolveIosRuntimeConfig({ VITE_ELIZA_ANDROID_RUNTIME_MODE: "local" })
        .mode,
    ).toBe("cloud");
  });

  it.each(["cloud", "local", "cloud-hybrid", "remote-mac"])(
    "accepts the current %s mode",
    (mode) => {
      expect(
        resolveIosRuntimeConfig({ VITE_ELIZA_IOS_RUNTIME_MODE: mode }).mode,
      ).toBe(mode);
    },
  );

  it("rejects invalid transport configuration explicitly", () => {
    expect(() =>
      resolveIosRuntimeConfig({ VITE_ELIZA_IOS_RUNTIME_MODE: "invalid" }),
    ).toThrow("Invalid iOS runtime mode");
  });

  it("uses Android endpoint keys when reconciling an Android build", () => {
    expect(
      readMobileRuntimeBuildTruth("android", {
        VITE_ELIZA_ANDROID_RUNTIME_MODE: "cloud",
        VITE_ELIZA_ANDROID_API_BASE: "https://android.example",
        VITE_ELIZA_IOS_RUNTIME_MODE: "invalid",
      }),
    ).toEqual({
      platform: "android",
      buildMode: "cloud",
      hasBuildApiBase: true,
      hasLocalEngine: false,
    });
  });

  it("derives the hybrid device bridge from the selected endpoint", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
        VITE_ELIZA_IOS_API_BASE: "https://ios.example/path?secret=1",
      }).deviceBridgeUrl,
    ).toBe("wss://ios.example/api/local-inference/device-bridge");
  });
});
