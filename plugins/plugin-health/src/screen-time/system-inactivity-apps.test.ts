/**
 * Unit test for `isSystemInactivityApp` — asserts OS lock / screen-saver
 * identities are classified as inactivity so they drop out of screen-time.
 */
import { describe, expect, it } from "vitest";
import { isSystemInactivityApp } from "./system-inactivity-apps.js";

describe("isSystemInactivityApp", () => {
  it("detects macOS lock and screen saver identities", () => {
    expect(isSystemInactivityApp({ bundleId: "com.apple.loginwindow" })).toBe(
      true,
    );
    expect(isSystemInactivityApp({ appName: "Screen Saver Engine" })).toBe(
      true,
    );
  });

  it("detects Windows and Linux lock screen executables", () => {
    expect(isSystemInactivityApp({ executableName: "LockApp.exe" })).toBe(true);
    expect(
      isSystemInactivityApp({ executableName: "kscreenlocker_greet" }),
    ).toBe(true);
  });

  it("does not classify ordinary activity as inactivity", () => {
    expect(
      isSystemInactivityApp({
        bundleId: "com.apple.Safari",
        appName: "Safari",
        executableName: "Safari",
      }),
    ).toBe(false);
  });
});
