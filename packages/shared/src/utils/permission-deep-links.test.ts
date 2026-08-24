/**
 * Coverage for the macOS permission deep-link helpers. `getMacPermissionDeepLink`
 * maps each permission id to its System Settings privacy-pane URL (falling back
 * to the root Privacy pane for unmapped ids), and `openPermissionSettings`
 * invokes the opener with that URL on darwin while warning and skipping on
 * win32/linux. The opener and console are injected, so no real System Settings
 * launch occurs.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getMacPermissionDeepLink,
  openPermissionSettings,
} from "./permission-deep-links.js";

describe("getMacPermissionDeepLink", () => {
  const PRIVACY_PREFIX =
    "x-apple.systempreferences:com.apple.preference.security?Privacy";

  it("maps each permission id to the documented pane", () => {
    expect(getMacPermissionDeepLink("accessibility")).toBe(
      `${PRIVACY_PREFIX}_Accessibility`,
    );
    expect(getMacPermissionDeepLink("screen-recording")).toBe(
      `${PRIVACY_PREFIX}_ScreenCapture`,
    );
    expect(getMacPermissionDeepLink("reminders")).toBe(
      `${PRIVACY_PREFIX}_Reminders`,
    );
    expect(getMacPermissionDeepLink("calendar")).toBe(
      `${PRIVACY_PREFIX}_Calendars`,
    );
    expect(getMacPermissionDeepLink("contacts")).toBe(
      `${PRIVACY_PREFIX}_Contacts`,
    );
    expect(getMacPermissionDeepLink("notes")).toBe(
      `${PRIVACY_PREFIX}_Automation`,
    );
    expect(getMacPermissionDeepLink("health")).toBe(`${PRIVACY_PREFIX}_Health`);
    expect(getMacPermissionDeepLink("microphone")).toBe(
      `${PRIVACY_PREFIX}_Microphone`,
    );
    expect(getMacPermissionDeepLink("camera")).toBe(`${PRIVACY_PREFIX}_Camera`);
    expect(getMacPermissionDeepLink("location")).toBe(
      `${PRIVACY_PREFIX}_LocationServices`,
    );
    expect(getMacPermissionDeepLink("notifications")).toBe(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
    expect(getMacPermissionDeepLink("full-disk")).toBe(
      `${PRIVACY_PREFIX}_AllFiles`,
    );
    expect(getMacPermissionDeepLink("automation")).toBe(
      `${PRIVACY_PREFIX}_Automation`,
    );
    expect(getMacPermissionDeepLink("speech-recognition")).toBe(
      `${PRIVACY_PREFIX}_SpeechRecognition`,
    );
    expect(getMacPermissionDeepLink("photos")).toBe(`${PRIVACY_PREFIX}_Photos`);
    expect(getMacPermissionDeepLink("phone")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("messages")).toBe(
      `${PRIVACY_PREFIX}_AllFiles`,
    );
    expect(getMacPermissionDeepLink("wifi")).toBe(
      `${PRIVACY_PREFIX}_LocationServices`,
    );
    expect(getMacPermissionDeepLink("bluetooth")).toBe(
      "x-apple.systempreferences:com.apple.BluetoothSettings",
    );
    expect(getMacPermissionDeepLink("app-blocking")).toBe(
      "x-apple.systempreferences:com.apple.preference.screentime",
    );
    expect(getMacPermissionDeepLink("usage-access")).toBe(
      "x-apple.systempreferences:com.apple.preference.screentime",
    );
    expect(getMacPermissionDeepLink("overlay")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("write-settings")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("local-network")).toBe(
      `${PRIVACY_PREFIX}_LocalNetwork`,
    );
    expect(getMacPermissionDeepLink("battery-optimization")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("screentime")).toBe(
      "x-apple.systempreferences:com.apple.preference.screentime",
    );
  });

  it("falls back to the root Privacy pane for unmapped ids", () => {
    expect(getMacPermissionDeepLink("shell")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("website-blocking")).toBe(PRIVACY_PREFIX);
    expect(
      getMacPermissionDeepLink("unknown-permission" as unknown as any),
    ).toBe(PRIVACY_PREFIX);
  });
});

describe("openPermissionSettings", () => {
  it("invokes the opener with the deep-link URL on darwin", async () => {
    const open = vi.fn();
    await openPermissionSettings("reminders", { platform: "darwin", open });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
    );
  });

  it("supports asynchronous opener handlers", async () => {
    let completed = false;
    const asyncOpener = vi.fn(async () => {
      await Promise.resolve();
      completed = true;
    });

    await openPermissionSettings("bluetooth", {
      platform: "darwin",
      open: asyncOpener,
    });
    expect(asyncOpener).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.BluetoothSettings",
    );
    expect(completed).toBe(true);
  });

  it("invokes window.open by default when window global is available", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const mockWindowOpen = vi.fn();
    (globalThis as { window?: { open: typeof mockWindowOpen } }).window = {
      open: mockWindowOpen,
    };

    try {
      await openPermissionSettings("photos", { platform: "darwin" });
      expect(mockWindowOpen).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
        "_self",
      );
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("logs a warning and skips opener on win32", async () => {
    const open = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openPermissionSettings("camera", { platform: "win32", open });
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a warning and skips opener on linux", async () => {
    const open = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openPermissionSettings("microphone", { platform: "linux", open });
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses detected platform by default when platform option is omitted", async () => {
    const open = vi.fn();
    await openPermissionSettings("camera", { open });
    // In macOS test environment, process.platform is "darwin"
    expect(open).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    );
  });

  it("logs a warning and skips opener on unknown platform", async () => {
    const open = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openPermissionSettings("location", { platform: "unknown", open });
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
