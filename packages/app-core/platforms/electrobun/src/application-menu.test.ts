import { describe, expect, it } from "vitest";
import {
  buildApplicationMenu,
  findAppMenuEntryBySlug,
  getAppMenuEntries,
  parseSettingsWindowAction,
} from "./application-menu";

function build(overrides?: {
  isMac?: boolean;
  browserEnabled?: boolean;
  agentReady?: boolean;
}) {
  return buildApplicationMenu({
    isMac: overrides?.isMac ?? true,
    browserEnabled: overrides?.browserEnabled ?? false,
    detachedWindows: [],
    agentReady: overrides?.agentReady ?? true,
  });
}

function findMenu(menus: ReturnType<typeof build>, label: string) {
  return menus.find((m) => m.label === label);
}

function collectActions(item: {
  action?: string;
  submenu?: Array<{ action?: string; submenu?: unknown }>;
}): string[] {
  const actions: string[] = [];
  if (item.action) actions.push(item.action);
  for (const child of item.submenu ?? []) {
    actions.push(...collectActions(child));
  }
  return actions;
}

describe("buildApplicationMenu structure", () => {
  it("includes the expected top-level menus", () => {
    const menu = build();
    const labels = menu.map((m) => m.label);
    expect(labels).toEqual(
      expect.arrayContaining(["File", "Edit", "View", "Desktop", "Views", "Window"]),
    );
  });

  it("exposes a Views submenu with one entry per internal tool view", () => {
    const views = findMenu(build(), "Views");
    expect(views).toBeDefined();
    const entries = getAppMenuEntries();
    expect(views?.submenu).toHaveLength(entries.length);
    for (const entry of entries) {
      const item = views?.submenu?.find(
        (i) => i.action === `apps:${entry.slug}`,
      );
      expect(item, `menu item for ${entry.slug}`).toBeDefined();
      expect(item?.label).toBe(entry.displayName);
    }
  });

  it("routes every Views entry through the apps: handler (own-window open)", () => {
    const views = findMenu(build(), "Views");
    for (const item of views?.submenu ?? []) {
      expect(item.action?.startsWith("apps:")).toBe(true);
    }
  });

  it("adds a Summon Chat click path in the Desktop menu with no local accelerator", () => {
    const desktop = findMenu(build(), "Desktop");
    const summon = desktop?.submenu?.find((i) => i.action === "summon-chat");
    expect(summon).toBeDefined();
    expect(summon?.label).toBe("Summon Chat");
    // The chat hotkey is a GLOBAL shortcut (works when backgrounded); binding a
    // local menu accelerator here would double-register it.
    expect(summon?.accelerator).toBeUndefined();
  });

  it("does not surface detached-window (new-window) actions until the agent is ready", () => {
    const notReady = build({ agentReady: false });
    const windowMenu = findMenu(notReady, "Window");
    const actions = collectActions(windowMenu ?? {});
    expect(actions.some((a) => a.startsWith("new-window:"))).toBe(false);

    const ready = build({ agentReady: true });
    const readyActions = collectActions(findMenu(ready, "Window") ?? {});
    expect(readyActions).toContain("new-window:chat");
  });

  it("hides the browser window entry unless the browser is enabled", () => {
    const noBrowser = collectActions(findMenu(build(), "Window") ?? {});
    expect(noBrowser).not.toContain("new-window:browser");
    const withBrowser = collectActions(
      findMenu(build({ browserEnabled: true }), "Window") ?? {},
    );
    expect(withBrowser).toContain("new-window:browser");
  });
});

describe("app menu entry resolution", () => {
  it("resolves entries by slug and rejects unknown slugs", () => {
    const entries = getAppMenuEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(findAppMenuEntryBySlug(entry.slug)).toEqual(entry);
      expect(entry.windowPath.startsWith("/apps/")).toBe(true);
    }
    expect(findAppMenuEntryBySlug("does-not-exist")).toBeUndefined();
  });
});

describe("parseSettingsWindowAction", () => {
  it("extracts the settings tab hint or undefined", () => {
    expect(parseSettingsWindowAction("open-settings")).toBeUndefined();
    expect(parseSettingsWindowAction("open-settings-desktop")).toBe("desktop");
    expect(parseSettingsWindowAction("open-settings-voice")).toBe("voice");
    expect(parseSettingsWindowAction("summon-chat")).toBeUndefined();
    expect(parseSettingsWindowAction(undefined)).toBeUndefined();
  });
});
