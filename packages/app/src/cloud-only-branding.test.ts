/**
 * Covers the composition-root policy matrix so native Cloud stamps cannot be
 * dropped while web, desktop, and explicit compatibility modes stay unchanged.
 */

import { describe, expect, it } from "vitest";
import { resolveAppCloudOnlyBranding } from "./cloud-only-branding";

const releaseBase = {
  env: {},
  injectedApiBase: undefined,
  isDev: false,
} as const;

describe("resolveAppCloudOnlyBranding", () => {
  it.each([
    ["iOS cloud", "ios", { VITE_ELIZA_IOS_RUNTIME_MODE: "cloud" }],
    [
      "iOS elizacloud alias",
      "ios",
      { VITE_ELIZA_IOS_RUNTIME_MODE: "elizacloud" },
    ],
    ["Android cloud", "android", { VITE_ELIZA_ANDROID_RUNTIME_MODE: "cloud" }],
  ])("locks a release %s build to Cloud", (_label, platform, env) => {
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        env,
        isNativePlatform: true,
        platform,
      }),
    ).toBe(true);
  });

  it.each([
    ["iOS local", "ios", { VITE_ELIZA_IOS_RUNTIME_MODE: "local" }],
    ["iOS remote", "ios", { VITE_ELIZA_IOS_RUNTIME_MODE: "remote-mac" }],
    ["iOS hybrid", "ios", { VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid" }],
    ["Android local", "android", { VITE_ELIZA_ANDROID_RUNTIME_MODE: "local" }],
  ])("keeps explicit %s developer capabilities available", (_label, platform, env) => {
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        env,
        isNativePlatform: true,
        platform,
      }),
    ).toBe(false);
  });

  it("preserves production web and injected-host behavior", () => {
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        isNativePlatform: false,
        platform: "web",
      }),
    ).toBe(true);
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        injectedApiBase: "http://127.0.0.1:31337",
        isNativePlatform: false,
        platform: "web",
      }),
    ).toBe(false);
  });

  it("preserves desktop Cloud and local/remote runtime decisions", () => {
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        desktopRuntimeMode: "cloud",
        injectedApiBase: "http://127.0.0.1:31337",
        isNativePlatform: false,
        platform: "web",
      }),
    ).toBe(true);
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        desktopRuntimeMode: "local",
        injectedApiBase: "http://127.0.0.1:31337",
        isNativePlatform: false,
        platform: "web",
      }),
    ).toBe(false);
    expect(
      resolveAppCloudOnlyBranding({
        ...releaseBase,
        desktopRuntimeMode: "external",
        injectedApiBase: "https://remote.example.test",
        isNativePlatform: false,
        platform: "web",
      }),
    ).toBe(false);
  });
});
