import { describe, expect, it } from "vitest";
import {
  resolveDesktopBundleVersion,
  shouldResetWindowsCefProfile,
  shouldWriteWindowsCefProfileMarker,
} from "./windows-cef-profile.ts";

describe("resolveDesktopBundleVersion", () => {
  it("resolves version from the macOS app bundle resources", () => {
    const fsMock = {
      existsSync: (p: string) => p.includes("Resources/version.json"),
      readFileSync: () => '{"version": "1.2.3"}',
    };
    const version = resolveDesktopBundleVersion(
      "/opt/app",
      "/Applications/Test.app/Contents/MacOS/Test",
      "darwin",
      fsMock as never,
    );
    expect(version).toBe("1.2.3");
  });

  it("falls back to the module package.json", () => {
    const fsMock = {
      existsSync: (p: string) => p.endsWith("package.json"),
      readFileSync: () => '{"version": "9.9.9"}',
    };
    const version = resolveDesktopBundleVersion(
      "/opt/app/packages/app",
      "/usr/bin/node",
      "linux",
      fsMock as never,
    );
    expect(version).toBe("9.9.9");
  });

  it("returns null on invalid version json", () => {
    const fsMock = {
      existsSync: () => true,
      readFileSync: () => "not-json",
    };
    expect(
      resolveDesktopBundleVersion(
        "/opt/app",
        "/usr/bin/node",
        "linux",
        fsMock as never,
      ),
    ).toBeNull();
  });
});

describe("shouldResetWindowsCefProfile", () => {
  it("resets when version changed", () => {
    expect(
      shouldResetWindowsCefProfile({
        currentVersion: "2.0.0",
        previousVersion: "1.0.0",
        cefDirExists: true,
      }),
    ).toBe(true);
  });

  it("does not reset when version is same or unknown", () => {
    expect(
      shouldResetWindowsCefProfile({
        currentVersion: "1.0.0",
        previousVersion: "1.0.0",
        cefDirExists: true,
      }),
    ).toBe(false);
    expect(
      shouldResetWindowsCefProfile({
        currentVersion: "unknown",
        previousVersion: "1.0.0",
        cefDirExists: true,
      }),
    ).toBe(false);
  });

  it("does not reset when cef dir is missing", () => {
    expect(
      shouldResetWindowsCefProfile({
        currentVersion: "2.0.0",
        previousVersion: "1.0.0",
        cefDirExists: false,
      }),
    ).toBe(false);
  });
});

describe("shouldWriteWindowsCefProfileMarker", () => {
  it("writes marker for a known version", () => {
    expect(shouldWriteWindowsCefProfileMarker("1.0.0")).toBe(true);
  });

  it("does not write for unknown or missing versions", () => {
    expect(shouldWriteWindowsCefProfileMarker("unknown")).toBe(false);
    expect(shouldWriteWindowsCefProfileMarker(null)).toBe(false);
    expect(shouldWriteWindowsCefProfileMarker("  ")).toBe(false);
  });
});
