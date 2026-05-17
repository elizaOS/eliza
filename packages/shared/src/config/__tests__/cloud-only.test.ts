import { describe, expect, it } from "vitest";
import { shouldUseCloudOnlyBranding } from "../cloud-only.js";

describe("shouldUseCloudOnlyBranding", () => {
  it("keeps production web cloud-only when no host backend is injected", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: false,
      }),
    ).toBe(true);
  });

  it("lets injected host backends choose local, remote, or hybrid capabilities", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "http://127.0.0.1:31337",
        isNativePlatform: false,
      }),
    ).toBe(false);
  });

  it("does not cloud-lock native shells by default", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
      }),
    ).toBe(false);
  });

  it("keeps cloud-hybrid native shells eligible for on-device agents", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud-hybrid",
      }),
    ).toBe(false);
  });

  it("cloud-locks native shells only when the runtime mode is explicitly cloud", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud",
      }),
    ).toBe(true);
  });
});
