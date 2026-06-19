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
      "x-apple.systempreferences:com.apple.preference.notifications",
    );
    expect(getMacPermissionDeepLink("full-disk")).toBe(
      `${PRIVACY_PREFIX}_AllFiles`,
    );
    expect(getMacPermissionDeepLink("automation")).toBe(
      `${PRIVACY_PREFIX}_Automation`,
    );
    expect(getMacPermissionDeepLink("screentime")).toBe(
      "x-apple.systempreferences:com.apple.preference.screentime",
    );
  });

  it("falls back to the root Privacy pane for unmapped ids", () => {
    expect(getMacPermissionDeepLink("shell")).toBe(PRIVACY_PREFIX);
    expect(getMacPermissionDeepLink("website-blocking")).toBe(PRIVACY_PREFIX);
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
    warn.mockRestore();
  });
});
