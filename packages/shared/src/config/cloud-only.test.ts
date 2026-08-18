/**
 * Tests for cloud-only branding selection logic in shouldUseCloudOnlyBranding.
 */
import { describe, expect, it } from "vitest";
import { shouldUseCloudOnlyBranding } from "./cloud-only.ts";

describe("shouldUseCloudOnlyBranding", () => {
  it("prioritizes explicit desktop cloud runtime mode over dev and injected backend", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:3000",
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

  it("returns false in dev mode when desktop cloud mode is not set", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
      }),
    ).toBe(false);

    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        desktopRuntimeMode: "local",
      }),
    ).toBe(false);
  });

  it("returns false when an injected API base is present in production", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "http://localhost:3000",
      }),
    ).toBe(false);
  });

  it("evaluates native platform runtime mode correctly", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud",
      }),
    ).toBe(true);

    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "local",
      }),
    ).toBe(false);
  });

  it("defaults to true for production web builds", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
      }),
    ).toBe(true);
  });

  it("handles nullish or empty options safely", () => {
    expect(shouldUseCloudOnlyBranding(null)).toBe(true);
    expect(shouldUseCloudOnlyBranding(undefined)).toBe(true);
    expect(shouldUseCloudOnlyBranding({})).toBe(true);
  });
});
