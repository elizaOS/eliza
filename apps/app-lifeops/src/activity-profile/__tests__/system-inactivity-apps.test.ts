import { describe, expect, it } from "vitest";
import { isSystemInactivityApp } from "../system-inactivity-apps.js";

describe("system inactivity app classifier", () => {
  it("recognizes macOS login and lock surfaces", () => {
    expect(
      isSystemInactivityApp({
        bundleId: "com.apple.loginwindow",
        appName: "loginwindow",
        platform: "darwin",
      }),
    ).toBe(true);
    expect(
      isSystemInactivityApp({
        bundleId: "com.apple.ScreenSaver.Engine",
        appName: "ScreenSaverEngine",
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("recognizes Windows lock and logon surfaces", () => {
    expect(
      isSystemInactivityApp({
        appName: "LockApp.exe",
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      isSystemInactivityApp({
        executableName: "LogonUI.exe",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("recognizes Linux greeter and screen-lock surfaces", () => {
    expect(
      isSystemInactivityApp({
        appName: "kscreenlocker_greet",
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      isSystemInactivityApp({
        appName: "lightdm-gtk-greeter",
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("does not classify ordinary apps as inactivity", () => {
    expect(
      isSystemInactivityApp({
        bundleId: "com.apple.Safari",
        appName: "Safari",
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      isSystemInactivityApp({
        appName: "Code.exe",
        platform: "win32",
      }),
    ).toBe(false);
  });
});
