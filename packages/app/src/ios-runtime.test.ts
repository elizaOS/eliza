import { describe, expect, it } from "vitest";
import { resolveIosRuntimeConfig } from "./ios-runtime";

describe("resolveIosRuntimeConfig", () => {
  it("prefers iOS runtime env over Android env", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_ANDROID_RUNTIME_MODE: "local",
      VITE_ELIZA_ANDROID_API_BASE: "https://android.example/",
      VITE_ELIZA_ANDROID_API_TOKEN: "android-token",
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
      VITE_ELIZA_IOS_API_BASE: "https://ios.example/",
      VITE_ELIZA_IOS_API_TOKEN: "ios-token",
    });

    expect(config).toMatchObject({
      mode: "cloud-hybrid",
      apiBase: "https://ios.example",
      apiToken: "ios-token",
      deviceBridgeUrl: "wss://ios.example/api/local-inference/device-bridge",
    });
  });

  it("uses mobile fallback env before Android env for iOS", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_ANDROID_RUNTIME_MODE: "local",
      VITE_ELIZA_ANDROID_API_BASE: "https://android.example",
      VITE_ELIZA_ANDROID_API_TOKEN: "android-token",
      VITE_ELIZA_MOBILE_RUNTIME_MODE: "remote-mac",
      VITE_ELIZA_MOBILE_API_BASE: "https://mobile.example",
      VITE_ELIZA_MOBILE_API_TOKEN: "mobile-token",
    });

    expect(config).toMatchObject({
      mode: "remote-mac",
      apiBase: "https://mobile.example",
      apiToken: "mobile-token",
    });
  });

  it("keeps Android env as a last-resort iOS fallback", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_ANDROID_RUNTIME_MODE: "local",
      VITE_ELIZA_ANDROID_API_BASE: "https://android.example/",
      VITE_ELIZA_ANDROID_API_TOKEN: "android-token",
    });

    expect(config).toMatchObject({
      mode: "local",
      apiBase: "https://android.example",
      apiToken: "android-token",
    });
  });

  it("marks the App Store-safe full Bun runtime as available", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
    });

    expect(config).toMatchObject({
      mode: "cloud",
      fullBun: true,
    });
  });
});
