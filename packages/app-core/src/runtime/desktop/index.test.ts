/**
 * Guards the Electrobun desktop-runtime barrel (runtime/desktop/index.ts): the
 * single desktop surface imported by the browser-safe entry, so every runtime
 * binding of its five modules must stay reachable through it by identity.
 * Also drives the barrel-exposed pure tray helpers end-to-end (item-id codec,
 * Windows-submenu builder, localized menu rebuild). Deterministic unit harness —
 * real module imports, no mocks, no rendering.
 */
import { describe, expect, it } from "vitest";
import * as appWindowRendererModule from "./AppWindowRenderer";
import * as surfaceNavigationModule from "./DesktopSurfaceNavigationRuntime";
import * as trayRuntimeModule from "./DesktopTrayRuntime";
import * as detachedShellRootModule from "./DetachedShellRoot";
import * as desktopIndex from "./index";
import {
  buildLocalizedTrayMenu,
  buildTrayViewItems,
  DESKTOP_TRAY_MENU_ITEMS,
  DESKTOP_VIEW_WINDOWS,
  parseTrayOpenViewItemId,
  trayOpenViewItemId,
} from "./index";
import * as trayMenuModule from "./tray-menu";

function namespaceBindings(module: object): Map<string, unknown> {
  return new Map(Object.entries(module));
}

describe("electrobun desktop runtime barrel", () => {
  it("re-exports every runtime binding of all five modules by identity", () => {
    const sources = [
      appWindowRendererModule,
      surfaceNavigationModule,
      trayRuntimeModule,
      detachedShellRootModule,
      trayMenuModule,
    ];
    const barrel = namespaceBindings(desktopIndex);

    const expected = new Map<string, unknown>();
    for (const source of sources) {
      for (const [name, value] of namespaceBindings(source)) {
        expect(expected.has(name), `duplicate export name ${name}`).toBe(false);
        expected.set(name, value);
      }
    }

    for (const [name, value] of expected) {
      expect(barrel.has(name), `barrel dropped export ${name}`).toBe(true);
      expect(barrel.get(name), `barrel ${name} is not the real binding`).toBe(
        value,
      );
    }

    expect(barrel.size).toBe(expected.size);
  });

  it("round-trips view-window item ids through the barrel codec", () => {
    expect(trayOpenViewItemId("vault")).toBe("tray-open-view-vault");
    expect(parseTrayOpenViewItemId(trayOpenViewItemId("browser"))).toBe(
      "browser",
    );

    // Ids outside the view-window codec parse to null rather than leaking a
    // bogus view id into the window-opener handler.
    expect(parseTrayOpenViewItemId("quit")).toBeNull();
    expect(parseTrayOpenViewItemId("tray-open-notifications")).toBeNull();
    expect(parseTrayOpenViewItemId("")).toBeNull();

    // Prefix with nothing after it is still a view-window id — an empty one.
    expect(parseTrayOpenViewItemId("tray-open-view-")).toBe("");
  });

  it("builds one unique Windows submenu item per desktop view window", () => {
    const items = buildTrayViewItems();
    expect(items).toHaveLength(DESKTOP_VIEW_WINDOWS.length);

    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const [index, view] of DESKTOP_VIEW_WINDOWS.entries()) {
      expect(items[index]).toMatchObject({
        id: trayOpenViewItemId(view.id),
        label: view.label,
        labelKey: view.labelKey,
      });
      expect(parseTrayOpenViewItemId(ids[index])).toBe(view.id);
    }
  });

  it("localizes labels through a translator and recurses into submenus", () => {
    const translations = new Map([
      ["desktop.tray.views", "Fenster"],
      ["desktop.tray.quit", "Beenden"],
      ["desktop.views.chat", "Nachrichten"],
    ]);
    const translate = (key: string, vars?: { defaultValue?: string }) =>
      translations.get(key) ?? vars?.defaultValue ?? key;

    const menu = buildLocalizedTrayMenu(translate);

    const quit = menu.find((item) => item.id === "quit");
    expect(quit?.label).toBe("Beenden");

    const windows = menu.find((item) => item.id === "tray-views");
    expect(windows?.label).toBe("Fenster");
    expect(windows?.submenu?.[0]).toMatchObject({
      id: "tray-open-view-chat",
      label: "Nachrichten",
    });

    // Untranslated keys fall back to the bundled English label.
    expect(menu.find((item) => item.id === "tray-restart")?.label).toBe(
      "Restart Agent",
    );

    // Separators carry no labelKey and pass through unchanged.
    const separators = menu.filter((item) => item.type === "separator");
    expect(separators).toHaveLength(3);
    for (const separator of separators) {
      expect(separator.label).toBeUndefined();
      expect(separator.submenu).toBeUndefined();
    }
  });

  it("rebuilds the same item tree as the static catalog when nothing translates", () => {
    const passThrough = buildLocalizedTrayMenu(
      (_key, vars) => vars?.defaultValue ?? _key,
    );

    expect(passThrough.map((item) => item.id)).toEqual(
      DESKTOP_TRAY_MENU_ITEMS.map((item) => item.id),
    );
    expect(passThrough.at(-1)?.id).toBe("quit");

    // With no translations the labels resolve to the bundled English defaults.
    expect(
      passThrough.find((item) => item.id === "tray-open-chat")?.label,
    ).toBe("Open Messages");
  });
});
