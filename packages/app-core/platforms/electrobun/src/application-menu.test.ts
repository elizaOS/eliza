/** Exercises application menu behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  buildApplicationMenu,
  buildViewsMenu,
  findViewMenuEntryById,
  getViewMenuEntries,
  NEW_VIEW_WINDOW_ACTION_PREFIX,
  parseViewWindowAction,
} from "./application-menu";
import type { ManagedWindowSnapshot } from "./surface-windows";

describe("buildViewsMenu", () => {
  it("emits one submenu entry per desktop-eligible view, keyed to new-window:view-<id>", () => {
    const menu = buildViewsMenu();
    expect(menu.label).toBe("Views");
    const entries = getViewMenuEntries();
    expect(menu.submenu).toHaveLength(entries.length);
    expect(menu.submenu).toEqual(
      entries.map((entry) => ({
        label: entry.label,
        action: `${NEW_VIEW_WINDOW_ACTION_PREFIX}${entry.id}`,
      })),
    );
  });

  it("includes the core desktop views and excludes the android-only camera", () => {
    const ids = getViewMenuEntries().map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tutorial",
        "help",
        "chat",
        "character",
        "documents",
        "settings",
        "background",
      ]),
    );
    expect(ids).not.toContain("camera");
  });

  it("maps every view entry to a real hash route", () => {
    for (const entry of getViewMenuEntries()) {
      expect(entry.path.startsWith("/")).toBe(true);
    }
    expect(findViewMenuEntryById("documents")?.path).toBe(
      "/character/documents",
    );
  });
});

describe("parseViewWindowAction", () => {
  it("extracts the view id from a new-window:view-<id> action", () => {
    expect(parseViewWindowAction("new-window:view-character")).toBe(
      "character",
    );
    expect(parseViewWindowAction("new-window:view-character/documents")).toBe(
      "character/documents",
    );
  });

  it("returns undefined for non-view actions (including plain surface windows)", () => {
    expect(parseViewWindowAction("new-window:chat")).toBeUndefined();
    expect(parseViewWindowAction("new-window:browser")).toBeUndefined();
    expect(parseViewWindowAction("open-settings")).toBeUndefined();
    expect(parseViewWindowAction(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty view id", () => {
    expect(parseViewWindowAction("new-window:view-")).toBeUndefined();
    expect(parseViewWindowAction("new-window:view-   ")).toBeUndefined();
  });

  it("does not collide with the generic new-window: surface prefix", () => {
    // Every surface entry parses back to undefined via the view parser so the
    // view branch in index.ts never intercepts a real detached surface.
    for (const surface of ["browser", "chat", "triggers", "plugins", "cloud"]) {
      expect(parseViewWindowAction(`new-window:${surface}`)).toBeUndefined();
    }
  });
});

describe("buildApplicationMenu", () => {
  const noWindows: ManagedWindowSnapshot[] = [];

  it("places the Views submenu in the menu bar with the correct actions", () => {
    const menu = buildApplicationMenu({
      isMac: true,
      browserEnabled: true,
      detachedWindows: noWindows,
    });
    const views = menu.find((item) => item.label === "Views");
    expect(views).toBeDefined();
    expect(views?.submenu?.map((item) => item.action)).toEqual(
      getViewMenuEntries().map(
        (entry) => `${NEW_VIEW_WINDOW_ACTION_PREFIX}${entry.id}`,
      ),
    );
  });

  it("keeps the Views submenu regardless of agentReady (unlike the Window new-* entries)", () => {
    const notReady = buildApplicationMenu({
      isMac: false,
      browserEnabled: false,
      detachedWindows: noWindows,
      agentReady: false,
    });
    expect(notReady.some((item) => item.label === "Views")).toBe(true);
  });

  it("exposes a Desktop → Notifications item that opens the notification center (#10706)", () => {
    const menu = buildApplicationMenu({
      isMac: true,
      browserEnabled: true,
      detachedWindows: noWindows,
    });
    const desktop = menu.find((item) => item.label === "Desktop");
    expect(desktop).toBeDefined();
    const notifications = desktop?.submenu?.find(
      (item) => item.label === "Notifications",
    );
    expect(notifications).toBeDefined();
    // Routed to the renderer as `open-notifications`
    // (DesktopSurfaceNavigationRuntime opens the center in place); distinct from
    // the "Send Test Notification" native-toast smoke item.
    expect(notifications?.action).toBe("open-notifications");
    expect(
      desktop?.submenu?.some((item) => item.action === "desktop-notify"),
    ).toBe(true);
  });
});
