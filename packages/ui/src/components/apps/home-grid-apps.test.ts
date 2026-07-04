/**
 * Covers `getHomeGridApps` / `getPinnableInternalApps`: the four default tiles,
 * their order, and how user-pinned internal-tool apps append and resolve to
 * navigation tabs. Pure functions over in-memory view fixtures.
 */

import { describe, expect, it } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { getHomeGridApps, getPinnableInternalApps } from "./home-grid-apps";
import { getInternalToolAppTargetTab } from "./internal-tool-apps";

describe("getHomeGridApps", () => {
  it("returns exactly the 4 default-pinned tiles when no pins are supplied", () => {
    const apps = getHomeGridApps();
    expect(apps).toHaveLength(4);
  });

  it("default tiles are Messages, Documents, Views, Settings in order", () => {
    const apps = getHomeGridApps();
    expect(apps.map((a) => a.displayName)).toEqual([
      "Messages",
      "Documents",
      "Views",
      "Settings",
    ]);
  });

  it("gives every tile a display name and a navigable target tab", () => {
    for (const app of getHomeGridApps()) {
      expect(app.displayName?.length).toBeGreaterThan(0);
      expect(typeof app.targetTab).toBe("string");
      expect((app.targetTab as string).length).toBeGreaterThan(0);
    }
  });

  it("uses unique tile identities", () => {
    const apps = getHomeGridApps();
    const names = apps.map((app) => app.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pinnable internal apps are available to pin but not shown by default", () => {
    const defaultNames = new Set(getHomeGridApps().map((a) => a.name));
    const pinnable = getPinnableInternalApps();
    expect(pinnable.length).toBeGreaterThan(0);
    for (const name of pinnable) {
      expect(defaultNames.has(name)).toBe(false);
    }
  });

  it("derives the pinnable list from the declared pinnable flag", () => {
    // Every pinnable name resolves to a real internal-tool app (navigable tab).
    for (const name of getPinnableInternalApps()) {
      expect(getInternalToolAppTargetTab(name)).not.toBeNull();
    }
  });

  it("overlays a plugin's live ViewDeclaration displayName onto the pinned tile", () => {
    const view: ViewRegistryEntry = {
      id: "training",
      label: "Model Studio",
      path: "/apps/fine-tuning",
      available: true,
      pluginName: "@elizaos/plugin-training",
    };
    // DEFAULT_PINNED_APPS (4) precede the single pinned internal-tool tile.
    const tile = getHomeGridApps(["@elizaos/plugin-training"], [view]).at(-1);
    expect(tile?.name).toBe("@elizaos/plugin-training");
    expect(tile?.displayName).toBe("Model Studio");
  });
});
