/**
 * Drift guard for the desktop view-window catalog. This lane can import the
 * @elizaos/agent BUILTIN_VIEWS catalog that neither the renderer bundle nor the
 * bun main process can, so it asserts that the renderer DESKTOP_VIEW_WINDOWS and
 * the menu-bar VIEW_MENU_ENTRIES both match the desktop-eligible builtin views
 * (id, label, path) and cover the same set, and that tray view-item ids
 * round-trip through parse/build.
 */
import { BUILTIN_VIEWS } from "@elizaos/agent/api/builtin-views";
import { describe, expect, it } from "vitest";
import {
  buildViewsMenu,
  getViewMenuEntries,
} from "../../../platforms/electrobun/src/application-menu";
import {
  buildTrayViewItems,
  DESKTOP_VIEW_WINDOWS,
  parseTrayOpenViewItemId,
  trayOpenViewItemId,
} from "./tray-menu";

/**
 * The tray "Views" submenu (renderer) and the menu-bar "Views" submenu (bun
 * main process) each carry a curated copy of the desktop-eligible builtin
 * views, because neither bundle can pull the `@elizaos/agent` view catalog. This
 * lane CAN import that catalog, so it is the drift guard: if `BUILTIN_VIEWS`
 * gains/loses a desktop-eligible view, this test fails until both copies match.
 */
function expectedDesktopViewIds(): string[] {
  return BUILTIN_VIEWS.filter((view) => {
    if (view.desktopTabEnabled !== true) {
      return false;
    }
    // A view with no `platforms` list is universal; otherwise it must opt into
    // desktop. (Excludes the android-only `camera` view.)
    return !view.platforms || view.platforms.includes("desktop");
  }).map((view) => view.id);
}

describe("desktop view-window catalog", () => {
  it("renderer DESKTOP_VIEW_WINDOWS matches BUILTIN_VIEWS desktop-eligible ids", () => {
    const catalogIds = [...DESKTOP_VIEW_WINDOWS].map((v) => v.id).sort();
    expect(catalogIds).toEqual(expectedDesktopViewIds().sort());
  });

  it("bun VIEW_MENU_ENTRIES matches BUILTIN_VIEWS desktop-eligible ids", () => {
    const entryIds = getViewMenuEntries()
      .map((entry) => entry.id)
      .sort();
    expect(entryIds).toEqual(expectedDesktopViewIds().sort());
  });

  it("renderer and bun catalogs agree on id, label, and path", () => {
    const bun = new Map(getViewMenuEntries().map((e) => [e.id, e]));
    for (const view of DESKTOP_VIEW_WINDOWS) {
      const entry = bun.get(view.id);
      expect(entry, `bun entry for ${view.id}`).toBeDefined();
      expect(entry?.label).toBe(view.label);
      expect(entry?.path).toBe(view.path);
    }
  });

  it("every catalog path matches the BUILTIN_VIEWS path for that id", () => {
    const byId = new Map(BUILTIN_VIEWS.map((v) => [v.id, v]));
    for (const view of DESKTOP_VIEW_WINDOWS) {
      expect(view.path).toBe(byId.get(view.id)?.path);
    }
  });
});

describe("tray view item ids", () => {
  it("round-trips a view id through the tray item id", () => {
    expect(parseTrayOpenViewItemId(trayOpenViewItemId("character"))).toBe(
      "character",
    );
  });

  it("returns null for non-view tray items", () => {
    expect(parseTrayOpenViewItemId("tray-open-chat")).toBeNull();
    expect(parseTrayOpenViewItemId("quit")).toBeNull();
  });

  it("buildTrayViewItems produces one localizable item per catalog view", () => {
    const items = buildTrayViewItems();
    expect(items).toHaveLength(DESKTOP_VIEW_WINDOWS.length);
    for (const [index, item] of items.entries()) {
      const view = DESKTOP_VIEW_WINDOWS[index];
      expect(item.id).toBe(`tray-open-view-${view?.id}`);
      expect(item.labelKey).toBe(view?.labelKey);
      expect(item.label).toBe(view?.label);
    }
  });

  it("buildViewsMenu (bun) and buildTrayViewItems (renderer) cover the same views", () => {
    const menuIds = buildViewsMenu()
      .submenu?.map((item) => item.action?.replace("new-window:view-", ""))
      .sort();
    const trayIds = buildTrayViewItems()
      .map((item) => item.id.replace("tray-open-view-", ""))
      .sort();
    expect(menuIds).toEqual(trayIds);
  });
});
