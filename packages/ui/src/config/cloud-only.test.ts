/**
 * Unit coverage for the @elizaos/ui/config cloud-only seam: the barrel must
 * hand out the canonical shared predicate (not a forked copy), and the
 * predicate's branch table must hold when driven through this package's
 * import path.
 */

import { shouldUseCloudOnlyBranding as sharedShouldUseCloudOnlyBranding } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

import { shouldUseCloudOnlyBranding } from "./cloud-only";

describe("shouldUseCloudOnlyBranding re-export", () => {
  it("exposes a callable predicate", () => {
    expect(typeof shouldUseCloudOnlyBranding).toBe("function");
  });

  it("re-exports the canonical shared implementation rather than a local copy", () => {
    expect(shouldUseCloudOnlyBranding).toBe(sharedShouldUseCloudOnlyBranding);
  });
});

describe("shouldUseCloudOnlyBranding", () => {
  it("returns true for plain production web with no overrides", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: false })).toBe(true);
  });

  it("treats every optional field as absent when undefined or null", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: null,
        nativeRuntimeMode: null,
        desktopRuntimeMode: null,
      }),
    ).toBe(true);
  });

  it("returns false in dev so the loopback agent keeps its own branding", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: true })).toBe(false);
  });

  it("lets an explicit desktop cloud runtime mode win over dev mode and an injected backend", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:3000",
        desktopRuntimeMode: "cloud",
      }),
    ).toBe(true);
  });

  it("normalizes the desktop runtime mode across casing and surrounding whitespace", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        desktopRuntimeMode: "  ELIZACloud ",
      }),
    ).toBe(true);
  });

  it("does not let a non-cloud desktop runtime mode force the override on its own", () => {
    // "local" matches neither cloud keyword, so the decision falls through
    // the remaining gates; on a plain production web build that means the
    // default cloud-only answer.
    expect(
      shouldUseCloudOnlyBranding({ isDev: false, desktopRuntimeMode: "local" }),
    ).toBe(true);
  });

  it("ignores a desktop runtime mode made only of whitespace", () => {
    // A blank mode trims to "" and matches neither cloud keyword, so the
    // decision falls through to the normal gates instead of forcing cloud.
    expect(
      shouldUseCloudOnlyBranding({ isDev: false, desktopRuntimeMode: "   " }),
    ).toBe(true);
  });

  it("returns false when a host injects a backend base URL outside dev", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "http://127.0.0.1:3000",
      }),
    ).toBe(false);
  });

  it("treats a whitespace-only injected API base as no injected backend", () => {
    expect(
      shouldUseCloudOnlyBranding({ isDev: false, injectedApiBase: "   " }),
    ).toBe(true);
  });

  it("checks dev before the injected backend so a dev build stays on its loopback agent", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "https://api.example.com",
      }),
    ).toBe(false);
  });

  it("follows a native platform whose runtime mode selects cloud", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud",
      }),
    ).toBe(true);
  });

  it("accepts elizacloud as the native cloud runtime mode in any casing", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: " ElizaCloud ",
      }),
    ).toBe(true);
  });

  it("returns false for a native platform running a local runtime mode", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "local",
      }),
    ).toBe(false);
  });

  it("returns false for a native platform with no runtime mode selected", () => {
    expect(
      shouldUseCloudOnlyBranding({ isDev: false, isNativePlatform: true }),
    ).toBe(false);
  });

  it("ignores the native runtime mode when the build is not a native platform", () => {
    // The native branch only runs once isNativePlatform holds, so a stray
    // mode value on a web build cannot flip the production default.
    expect(
      shouldUseCloudOnlyBranding({ isDev: false, nativeRuntimeMode: "local" }),
    ).toBe(true);
  });
});
