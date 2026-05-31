import { describe, expect, it } from "vitest";
import { getHomeGridApps, PINNABLE_INTERNAL_APPS } from "./home-grid-apps";

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

  it("PINNABLE_INTERNAL_APPS lists the apps available to pin but not shown by default", () => {
    const defaultNames = new Set(getHomeGridApps().map((a) => a.name));
    for (const name of PINNABLE_INTERNAL_APPS) {
      expect(defaultNames.has(name)).toBe(false);
    }
  });
});
