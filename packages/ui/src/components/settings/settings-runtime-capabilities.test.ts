/** Verifies canonical Settings capability resolution with injected runtime probes. */
import { describe, expect, it } from "vitest";
import type { WindowShellRoute } from "../../platform/window-shell";
import {
  resolveSettingsRuntimeCapabilities,
  settingsRuntimeHasCapability,
} from "./settings-runtime-capabilities";

function resolve(args: { desktopBridge: boolean; route: WindowShellRoute }) {
  return resolveSettingsRuntimeCapabilities({
    hasDesktopBridge: () => args.desktopBridge,
    readWindowShellRoute: () => args.route,
  });
}

describe("Settings runtime capabilities", () => {
  it("keeps an embedded portable runtime free of desktop-only capabilities", () => {
    const capabilities = resolve({
      desktopBridge: false,
      route: { mode: "main" },
    });

    expect([...capabilities]).toEqual([]);
  });

  it("advertises the desktop bridge independently of window layout", () => {
    const capabilities = resolve({
      desktopBridge: true,
      route: { mode: "main" },
    });

    expect(settingsRuntimeHasCapability(capabilities, "desktop-bridge")).toBe(
      true,
    );
    expect(
      settingsRuntimeHasCapability(capabilities, "detached-settings-shell"),
    ).toBe(false);
  });

  it("recognizes only the dedicated Settings window as a detached Settings shell", () => {
    const settingsWindow = resolve({
      desktopBridge: true,
      route: { mode: "settings", tab: "voice" },
    });
    const detachedBrowser = resolve({
      desktopBridge: true,
      route: { mode: "surface", tab: "browser" },
    });

    expect(
      settingsRuntimeHasCapability(settingsWindow, "detached-settings-shell"),
    ).toBe(true);
    expect(
      settingsRuntimeHasCapability(detachedBrowser, "detached-settings-shell"),
    ).toBe(false);
  });
});
