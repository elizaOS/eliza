import { getInternalToolAppDescriptors } from "@elizaos/ui/components/apps/internal-tool-apps";
import { describe, expect, it } from "vitest";
import {
  buildDesktopTrayViewItems,
  buildLocalizedTrayMenu,
  desktopTrayAppSlug,
  DESKTOP_TRAY_MENU_ITEMS,
  TRAY_APP_ITEM_PREFIX,
} from "./tray-menu";

const identity = (key: string, vars?: { defaultValue?: string }): string =>
  vars?.defaultValue ?? key;

describe("desktopTrayAppSlug", () => {
  it("strips the @elizaos/ scope", () => {
    expect(desktopTrayAppSlug("@elizaos/app-plugin-viewer")).toBe(
      "app-plugin-viewer",
    );
    expect(desktopTrayAppSlug("plain")).toBe("plain");
  });
});

describe("buildDesktopTrayViewItems", () => {
  it("mirrors the internal tool-app catalog (one item per view with a window path)", () => {
    const descriptors = getInternalToolAppDescriptors().filter(
      (d) => d.windowPath !== null,
    );
    const items = buildDesktopTrayViewItems();
    expect(items).toHaveLength(descriptors.length);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.id.startsWith(TRAY_APP_ITEM_PREFIX)).toBe(true);
      expect(typeof item.label).toBe("string");
      expect(item.label?.length).toBeGreaterThan(0);
    }
  });

  it("orders items by catalog order", () => {
    const items = buildDesktopTrayViewItems();
    const expected = [...getInternalToolAppDescriptors()]
      .filter((d) => d.windowPath !== null)
      .sort((a, b) => a.order - b.order)
      .map((d) => `${TRAY_APP_ITEM_PREFIX}${desktopTrayAppSlug(d.name)}`);
    expect(items.map((i) => i.id)).toEqual(expected);
  });

  it("produces slugs the renderer can resolve back to a descriptor", () => {
    const bySlug = new Map(
      getInternalToolAppDescriptors().map((d) => [desktopTrayAppSlug(d.name), d]),
    );
    for (const item of buildDesktopTrayViewItems()) {
      const slug = item.id.slice(TRAY_APP_ITEM_PREFIX.length);
      expect(bySlug.has(slug)).toBe(true);
    }
  });
});

describe("buildLocalizedTrayMenu", () => {
  it("splices the Views section immediately after Open Voice Controls", () => {
    const menu = buildLocalizedTrayMenu(identity);
    const voiceIdx = menu.findIndex((i) => i.id === "tray-open-voice-controls");
    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(menu[voiceIdx + 1]?.id).toBe("tray-sep-views");
    expect(menu[voiceIdx + 2]?.id.startsWith(TRAY_APP_ITEM_PREFIX)).toBe(true);
  });

  it("keeps every fixed item and appends only the Views section", () => {
    const menu = buildLocalizedTrayMenu(identity);
    for (const fixed of DESKTOP_TRAY_MENU_ITEMS) {
      expect(menu.some((i) => i.id === fixed.id)).toBe(true);
    }
    const views = buildDesktopTrayViewItems();
    expect(menu.length).toBe(DESKTOP_TRAY_MENU_ITEMS.length + views.length + 1);
  });

  it("still ends with the quit item after the views section", () => {
    const menu = buildLocalizedTrayMenu(identity);
    expect(menu[menu.length - 1]?.id).toBe("quit");
  });

  it("resolves labels through the translator", () => {
    const menu = buildLocalizedTrayMenu((key, vars) =>
      key === "desktop.tray.openChat" ? "CHAT!" : (vars?.defaultValue ?? key),
    );
    expect(menu.find((i) => i.id === "tray-open-chat")?.label).toBe("CHAT!");
  });
});
