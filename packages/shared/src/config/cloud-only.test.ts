/**
 * Exercises cloud-only branding decisions across web, injected hosts, native shells, and desktop runtime overrides.
 */
import { describe, expect, it } from "vitest";
import { shouldUseCloudOnlyBranding } from "./cloud-only.js";

describe("shouldUseCloudOnlyBranding", () => {
  it("keeps production web cloud-only when no host backend is injected", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: false,
      }),
    ).toBe(true);
  });

  it("lets development and injected host backends choose their capabilities", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: true })).toBe(false);
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

  it("forces cloud-only for desktop cloud modes even in development", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:31337",
        isNativePlatform: false,
        desktopRuntimeMode: "cloud",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        desktopRuntimeMode: "elizacloud",
      }),
    ).toBe(true);
  });

  it("leaves desktop behavior unchanged when the runtime mode is absent or non-cloud", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:31337",
        desktopRuntimeMode: undefined,
      }),
    ).toBe(false);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "http://127.0.0.1:31337",
        desktopRuntimeMode: "external",
      }),
    ).toBe(false);
  });
});
