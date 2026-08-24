/**
 * Unit tests for native-cloud-nav: validates cloud console URL resolution
 * and external url filtering.
 */
import { describe, expect, it } from "vitest";
import {
  isNativeAppsStudioRuntime,
  openExternalUrlOnNative,
  resolveCloudConsoleUrl,
} from "./native-cloud-nav.ts";

describe("native-cloud-nav", () => {
  it("reports false for native studio on standard node/web environment", () => {
    expect(isNativeAppsStudioRuntime()).toBe(false);
  });

  it("resolves cloud console URL correctly", () => {
    const url = resolveCloudConsoleUrl("apps/new");
    expect(url).toContain("/apps/new");
  });

  it("returns false on web for openExternalUrlOnNative", () => {
    expect(openExternalUrlOnNative("https://example.com")).toBe(false);
  });
});
