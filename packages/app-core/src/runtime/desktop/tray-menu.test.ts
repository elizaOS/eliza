/**
 * Unit coverage for the desktop tray Notifications entry (#10706): asserts the
 * static tray catalog and click-audit table in tray-menu.ts expose the
 * `tray-open-notifications` item, and grep-guards DesktopTrayRuntime.tsx source
 * so the tray id actually routes to dispatchOpenNotificationCenter(). Reads the
 * real module + runtime source — no runtime boot.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_TRAY_CLICK_AUDIT, DESKTOP_TRAY_MENU_ITEMS } from "./tray-menu";

const trayRuntimePath = fileURLToPath(
  new URL("./DesktopTrayRuntime.tsx", import.meta.url),
);

describe("desktop tray menu — Notifications entry (#10706)", () => {
  it("carries a tray-open-notifications item (tray counterpart of Desktop → Notifications)", () => {
    const item = DESKTOP_TRAY_MENU_ITEMS.find(
      (entry) => entry.id === "tray-open-notifications",
    );
    expect(item).toBeDefined();
    expect(item?.label).toBe("Notifications");
    expect(item?.labelKey).toBe("desktop.tray.notifications");
    // A direct action item, not a submenu container.
    expect(item?.submenu).toBeUndefined();
    expect(item?.type).not.toBe("separator");
  });

  it("audits the Notifications tray click", () => {
    const audit = DESKTOP_TRAY_CLICK_AUDIT.find(
      (entry) => entry.id === "tray-open-notifications",
    );
    expect(audit).toBeDefined();
    expect(audit?.entryPoint).toBe("tray");
    expect(audit?.coverage).toBe("automated");
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

  it("DesktopTrayRuntime handles the click by opening the notification center", () => {
    // Same source-level guard style as browser-entry-tray-exports.test.ts:
    // the runtime switch must route the tray id to the surface-agnostic open
    // dispatch (the headless NotificationCenter is the listener).
    const source = readFileSync(trayRuntimePath, "utf8");
    expect(source).toContain('case "tray-open-notifications"');
    expect(source).toContain("dispatchOpenNotificationCenter()");
  });
});
