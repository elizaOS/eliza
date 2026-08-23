/** Unit coverage for the deliberately small, native macOS tray surface. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_TRAY_CLICK_AUDIT, DESKTOP_TRAY_MENU_ITEMS } from "./tray-menu";

const trayRuntimePath = fileURLToPath(
  new URL("./DesktopTrayRuntime.tsx", import.meta.url),
);

describe("desktop tray menu", () => {
  it("contains only the product-level destinations and Quit", () => {
    expect(DESKTOP_TRAY_MENU_ITEMS).toEqual([
      {
        id: "tray-show-window",
        label: "Open Eliza",
        labelKey: "desktop.tray.openEliza",
      },
      { id: "tray-open-desktop-workspace", label: "Open Workspace" },
      { id: "tray-open-settings", label: "Settings…" },
      { id: "tray-sep-0", type: "separator" },
      { id: "quit", label: "Quit Eliza" },
    ]);
  });

  it("every audited tray id is a real tray item (drift guard)", () => {
    const menuIds = new Set(DESKTOP_TRAY_MENU_ITEMS.map((item) => item.id));
    for (const audit of DESKTOP_TRAY_CLICK_AUDIT) {
      expect(
        menuIds.has(audit.id),
        `audit id ${audit.id} has no tray item`,
      ).toBe(true);
    }
  });

  it("routes Workspace and Settings through their distinct canonical window helpers", () => {
    const source = readFileSync(trayRuntimePath, "utf8");
    expect(source).toContain('case "tray-open-desktop-workspace"');
    expect(source).toContain("openDesktopWorkspaceWindow()");
    expect(source).not.toContain('openDesktopSettingsWindow("desktop")');
    expect(source).toContain('case "tray-open-settings"');
    expect(source).toContain("openDesktopSettingsWindow()");
  });

  it("expands the shared ChatOverlay when Open Eliza is selected", () => {
    const source = readFileSync(trayRuntimePath, "utf8");
    expect(source).toContain('case "tray-show-window"');
    expect(source).toContain("dispatchAppEvent(CHAT_OVERLAY_OPEN_EVENT)");
  });

  // The runtime routing itself is exercised behaviorally in
  // DesktopTrayRuntime.workspace.test.tsx; this only pins the audit row that
  // the click-audit report renders.
  it("audits the Desktop Workspace click as the complete managed shell", () => {
    const audit = DESKTOP_TRAY_CLICK_AUDIT.find(
      (entry) => entry.id === "tray-open-desktop-workspace",
    );
    expect(audit?.expectedAction).toBe(
      "Open and focus the singleton Eliza Workspace without duplicating the detached assistant.",
    );
    expect(audit?.coverage).toBe("automated");
  });
});
