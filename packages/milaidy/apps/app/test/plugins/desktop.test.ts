/**
 * Tests for @milaidy/capacitor-desktop plugin
 *
 * Verifies:
 * - Module exports (DesktopWeb class + definitions)
 * - Web fallback behavior (graceful degradation for browser)
 * - Window state queries return sensible defaults
 * - Clipboard operations
 * - Notification handling
 * - Event listener registration and cleanup
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DesktopWeb } from "../../plugins/desktop/src/web";

describe("@milaidy/capacitor-desktop", () => {
  let desktop: DesktopWeb;

  beforeEach(() => {
    desktop = new DesktopWeb();
  });

  describe("module exports", () => {
    it("exports DesktopWeb class", () => {
      expect(DesktopWeb).toBeDefined();
      expect(typeof DesktopWeb).toBe("function");
    });

    it("creates an instance with all expected method groups", () => {
      // System Tray
      expect(typeof desktop.createTray).toBe("function");
      expect(typeof desktop.updateTray).toBe("function");
      expect(typeof desktop.destroyTray).toBe("function");
      expect(typeof desktop.setTrayMenu).toBe("function");

      // Global Shortcuts
      expect(typeof desktop.registerShortcut).toBe("function");
      expect(typeof desktop.unregisterShortcut).toBe("function");
      expect(typeof desktop.unregisterAllShortcuts).toBe("function");
      expect(typeof desktop.isShortcutRegistered).toBe("function");

      // Auto Launch
      expect(typeof desktop.setAutoLaunch).toBe("function");
      expect(typeof desktop.getAutoLaunchStatus).toBe("function");

      // Window Management
      expect(typeof desktop.setWindowOptions).toBe("function");
      expect(typeof desktop.getWindowBounds).toBe("function");
      expect(typeof desktop.minimizeWindow).toBe("function");
      expect(typeof desktop.maximizeWindow).toBe("function");
      expect(typeof desktop.closeWindow).toBe("function");
      expect(typeof desktop.showWindow).toBe("function");
      expect(typeof desktop.hideWindow).toBe("function");
      expect(typeof desktop.focusWindow).toBe("function");

      // Notifications
      expect(typeof desktop.showNotification).toBe("function");
      expect(typeof desktop.closeNotification).toBe("function");

      // Power Monitor
      expect(typeof desktop.getPowerState).toBe("function");

      // App
      expect(typeof desktop.quit).toBe("function");
      expect(typeof desktop.relaunch).toBe("function");
      expect(typeof desktop.getVersion).toBe("function");
      expect(typeof desktop.isPackaged).toBe("function");
      expect(typeof desktop.getPath).toBe("function");

      // Clipboard
      expect(typeof desktop.writeToClipboard).toBe("function");
      expect(typeof desktop.readFromClipboard).toBe("function");
      expect(typeof desktop.clearClipboard).toBe("function");

      // Shell
      expect(typeof desktop.openExternal).toBe("function");
      expect(typeof desktop.showItemInFolder).toBe("function");
      expect(typeof desktop.beep).toBe("function");
    });
  });

  describe("web fallbacks", () => {
    it("registerShortcut returns success: false on web", async () => {
      const result = await desktop.registerShortcut({
        id: "test",
        accelerator: "CmdOrCtrl+Shift+T",
      });
      expect(result.success).toBe(false);
    });

    it("isShortcutRegistered returns false on web", async () => {
      const result = await desktop.isShortcutRegistered({ accelerator: "CmdOrCtrl+T" });
      expect(result.registered).toBe(false);
    });

    it("getAutoLaunchStatus returns disabled on web", async () => {
      const result = await desktop.getAutoLaunchStatus();
      expect(result.enabled).toBe(false);
      expect(result.openAsHidden).toBe(false);
    });

    it("isPackaged returns false on web", async () => {
      const result = await desktop.isPackaged();
      expect(result.packaged).toBe(false);
    });

    it("getPath throws on web (no filesystem access)", async () => {
      await expect(desktop.getPath({ name: "home" })).rejects.toThrow(
        "File system paths are not available in browser environment"
      );
    });

    it("getVersion returns unknown for app info on web", async () => {
      const result = await desktop.getVersion();
      expect(result.version).toBe("unknown");
      expect(result.electron).toBe("N/A");
      expect(result.node).toBe("N/A");
    });
  });

  describe("window state", () => {
    it("getWindowBounds returns window dimensions", async () => {
      const bounds = await desktop.getWindowBounds();
      expect(typeof bounds.x).toBe("number");
      expect(typeof bounds.y).toBe("number");
      expect(typeof bounds.width).toBe("number");
      expect(typeof bounds.height).toBe("number");
    });

    it("isWindowMaximized returns false on web", async () => {
      const result = await desktop.isWindowMaximized();
      expect(result.maximized).toBe(false);
    });

    it("isWindowVisible returns true when document not hidden", async () => {
      const result = await desktop.isWindowVisible();
      expect(result.visible).toBe(true);
    });

    it("isWindowFocused returns based on document.hasFocus", async () => {
      const result = await desktop.isWindowFocused();
      expect(typeof result.focused).toBe("boolean");
    });
  });

  describe("power monitor", () => {
    it("returns a valid power state", async () => {
      const state = await desktop.getPowerState();
      expect(typeof state.onBattery).toBe("boolean");
      expect(typeof state.idleTime).toBe("number");
      expect(["active", "idle", "locked", "unknown"]).toContain(state.idleState);
    });
  });

  describe("notifications", () => {
    it("showNotification returns an id", async () => {
      const result = await desktop.showNotification({ title: "Test" });
      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe("string");
    });
  });

  describe("event listeners", () => {
    it("registers and removes listeners", async () => {
      const handle = await desktop.addListener("windowFocus", vi.fn());
      expect(handle).toBeDefined();
      expect(typeof handle.remove).toBe("function");
      await handle.remove();
    });

    it("removeAllListeners clears all", async () => {
      await desktop.addListener("windowFocus", vi.fn());
      await desktop.addListener("windowBlur", vi.fn());
      await desktop.removeAllListeners();
      // No error means success
    });
  });
});
