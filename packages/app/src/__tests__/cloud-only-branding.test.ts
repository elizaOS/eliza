/** Store builds brand cloud-only before React boots so local runtime options stay hidden (#16420). */
import { describe, expect, it } from "vitest";
import {
  resolveAppCloudOnlyBranding,
  resolveNativeCloudRuntimeMode,
} from "../cloud-only-branding";

describe("resolveNativeCloudRuntimeMode", () => {
  it("locks an App Store iOS build baked for the Cloud runtime", () => {
    const mode = resolveNativeCloudRuntimeMode({
      platform: "ios",
      buildVariant: "store",
      iosRuntimeMode: "cloud",
      androidCloudBuild: false,
    });
    expect(mode).toBe("cloud");
    expect(
      resolveAppCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: mode,
      }),
    ).toBe(true);
  });

  it("keeps explicit on-device opt-ins and developer builds unlocked", () => {
    for (const inputs of [
      { buildVariant: "store", iosRuntimeMode: "cloud-hybrid" },
      { buildVariant: "direct", iosRuntimeMode: "cloud" },
      { buildVariant: "direct", iosRuntimeMode: "local" },
      { buildVariant: undefined, iosRuntimeMode: undefined },
    ]) {
      expect(
        resolveNativeCloudRuntimeMode({
          platform: "ios",
          androidCloudBuild: false,
          ...inputs,
        }),
      ).toBeUndefined();
    }
  });

  it("preserves the cloud-locked Android contract", () => {
    expect(
      resolveNativeCloudRuntimeMode({
        platform: "android",
        buildVariant: "store",
        iosRuntimeMode: undefined,
        androidCloudBuild: true,
      }),
    ).toBe("cloud");
    expect(
      resolveNativeCloudRuntimeMode({
        platform: "android",
        buildVariant: "store",
        iosRuntimeMode: undefined,
        androidCloudBuild: true,
        androidRemoteFallbackApiBase: "https://agent.example.com",
      }),
    ).toBeUndefined();
    expect(
      resolveNativeCloudRuntimeMode({
        platform: "web",
        buildVariant: "store",
        iosRuntimeMode: "cloud",
        androidCloudBuild: false,
      }),
    ).toBeUndefined();
  });
});
