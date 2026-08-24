/**
 * Coverage for cloud-only.
 */
import { describe, expect, it } from "vitest";
import { shouldUseCloudOnlyBranding } from "./cloud-only.js";

describe("cloud-only", () => {
  it("forces cloud when desktop mode cloud", () => {
    expect(
      shouldUseCloudOnlyBranding({ isDev: true, desktopRuntimeMode: "cloud" }),
    ).toBe(true);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        desktopRuntimeMode: "elizacloud",
      }),
    ).toBe(true);
  });
  it("respects dev", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: true })).toBe(false);
  });
  it("respects injected backend", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "https://api.example.com",
      }),
    ).toBe(false);
  });
  it("defaults to cloud when no overrides", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: false })).toBe(true);
  });
});
