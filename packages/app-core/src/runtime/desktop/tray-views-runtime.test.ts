/**
 * Covers the dynamic tray views layer: building the "Views" submenu from a
 * curated launcher list, runtime-catalog resolution with the static
 * DESKTOP_VIEW_WINDOWS fallback, the launcher-entry → runtime-view path rule,
 * and popover-row parity with the published catalog. Pure module state — no
 * runtime boot; the curated input is fabricated post-curation data (curation
 * itself — hidden ids, alias collapse — is covered in @elizaos/ui's
 * launcher-curation tests).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDynamicTrayViewItems,
  buildLocalizedTrayMenuWithViews,
  DESKTOP_TRAY_CLICK_AUDIT,
  DESKTOP_TRAY_MENU_ITEMS,
  DESKTOP_VIEW_WINDOWS,
  parseTrayOpenViewItemId,
  trayOpenViewItemId,
} from "./tray-menu";
import {
  getRuntimeTrayViews,
  launcherEntryToRuntimeTrayView,
  resolveTrayViewWindow,
  setRuntimeTrayViews,
} from "./tray-views-runtime";

const identityT = (_key: string, vars?: { defaultValue?: string }) =>
  vars?.defaultValue ?? _key;

const CURATED = [
  { id: "settings", label: "Settings", path: "/settings" },
  { id: "wallet", label: "Wallet", path: "/apps/wallet" },
  { id: "tasks", label: "Tasks", path: "/apps/tasks" },
  { id: "my-plugin-view", label: "My Plugin View", path: "/apps/my-plugin" },
];

afterEach(() => {
  setRuntimeTrayViews([]);
});

describe("buildDynamicTrayViewItems", () => {
  it("maps a curated list to tray-open-view-<id> items with entry labels", () => {
    const items = buildDynamicTrayViewItems(CURATED);
    expect(items).toEqual([
      { id: "tray-open-view-settings", label: "Settings" },
      { id: "tray-open-view-wallet", label: "Wallet" },
      { id: "tray-open-view-tasks", label: "Tasks" },
      { id: "tray-open-view-my-plugin-view", label: "My Plugin View" },
    ]);
    // Dynamic labels come from the entries themselves — never localized.
    for (const item of items) {
      expect(item).not.toHaveProperty("labelKey");
    }
  });

  it("round-trips every dynamic item id through the tray codec", () => {
    for (const item of buildDynamicTrayViewItems(CURATED)) {
      const viewId = parseTrayOpenViewItemId(item.id);
      expect(viewId).not.toBeNull();
      expect(trayOpenViewItemId(viewId as string)).toBe(item.id);
    }
  });
});

describe("buildLocalizedTrayMenuWithViews", () => {
  it("replaces only the Views submenu, keeping the rest of the tray intact", () => {
    const viewItems = buildDynamicTrayViewItems(CURATED);
    const menu = buildLocalizedTrayMenuWithViews(identityT, viewItems);
    expect(menu.map((item) => item.id)).toEqual(
      DESKTOP_TRAY_MENU_ITEMS.map((item) => item.id),
    );
    const views = menu.find((item) => item.id === "tray-views");
    expect(views?.submenu).toEqual(viewItems);
    // No other item gained or lost a submenu.
    for (const item of menu) {
      if (item.id === "tray-views") continue;
      const staticItem = DESKTOP_TRAY_MENU_ITEMS.find((s) => s.id === item.id);
      expect(Boolean(item.submenu)).toBe(Boolean(staticItem?.submenu));
    }
  });
});

describe("resolveTrayViewWindow", () => {
  it("resolves dynamic ids from the published runtime catalog", () => {
    setRuntimeTrayViews(CURATED.map(launcherEntryToRuntimeTrayView));
    expect(resolveTrayViewWindow("my-plugin-view")).toEqual({
      id: "my-plugin-view",
      label: "My Plugin View",
      path: "/apps/my-plugin",
    });
    expect(getRuntimeTrayViews()).toHaveLength(CURATED.length);
  });

  it("prefers the runtime entry over the static mirror for the same id", () => {
    setRuntimeTrayViews([
      { id: "settings", label: "Runtime Settings", path: "/settings" },
    ]);
    expect(resolveTrayViewWindow("settings")?.label).toBe("Runtime Settings");
  });

  it("falls back to the static DESKTOP_VIEW_WINDOWS mirror before the registry loads", () => {
    setRuntimeTrayViews([]);
    for (const view of DESKTOP_VIEW_WINDOWS) {
      expect(resolveTrayViewWindow(view.id)).toEqual({
        id: view.id,
        label: view.label,
        path: view.path,
      });
    }
  });

  it("returns null for an unknown view id", () => {
    setRuntimeTrayViews(CURATED.map(launcherEntryToRuntimeTrayView));
    expect(resolveTrayViewWindow("not-a-view")).toBeNull();
  });
});

describe("launcherEntryToRuntimeTrayView", () => {
  it("keeps a declared path and applies the launcher /apps/<id> fallback", () => {
    expect(
      launcherEntryToRuntimeTrayView({
        id: "wallet",
        label: "Wallet",
        path: "/apps/wallet",
      }),
    ).toEqual({ id: "wallet", label: "Wallet", path: "/apps/wallet" });
    // Same rule as LauncherSurface.handleLaunch: no path → /apps/<id>.
    expect(
      launcherEntryToRuntimeTrayView({ id: "feed", label: "Feed" }),
    ).toEqual({ id: "feed", label: "Feed", path: "/apps/feed" });
  });
});

describe("popover row parity", () => {
  it("published catalog rows mirror the curated list one-to-one", () => {
    const views = CURATED.map(launcherEntryToRuntimeTrayView);
    setRuntimeTrayViews(views);
    // The popover rows DesktopTrayRuntime publishes are one row per catalog
    // view (plus the fixed "Open Eliza" row) with tray-open-view item ids —
    // assert the id/label projection the rows are built from.
    const rows = views.map((view) => ({
      itemId: trayOpenViewItemId(view.id),
      label: view.label,
    }));
    expect(rows.map((row) => parseTrayOpenViewItemId(row.itemId))).toEqual(
      CURATED.map((entry) => entry.id),
    );
    expect(rows.map((row) => row.label)).toEqual(
      CURATED.map((entry) => entry.label),
    );
  });
});

describe("click-audit coverage for the dynamic family", () => {
  it("one audit row covers the tray-views dynamic submenu", () => {
    const audit = DESKTOP_TRAY_CLICK_AUDIT.find(
      (entry) => entry.id === "tray-views",
    );
    expect(audit).toBeDefined();
    expect(audit?.expectedAction).toContain("tray-open-view-");
    expect(audit?.expectedAction).toContain("DESKTOP_VIEW_WINDOWS");
  });
});
