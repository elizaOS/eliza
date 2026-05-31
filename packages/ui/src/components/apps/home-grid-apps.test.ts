import { describe, expect, it } from "vitest";
import { getHomeGridApps } from "./home-grid-apps";

describe("getHomeGridApps", () => {
  const apps = getHomeGridApps();

  it("returns a full 4×6 launcher grid (24 tiles)", () => {
    expect(apps).toHaveLength(24);
  });

  it("gives every tile a display name and a navigable target tab", () => {
    for (const app of apps) {
      expect(app.displayName?.length).toBeGreaterThan(0);
      expect(typeof app.targetTab).toBe("string");
      expect((app.targetTab as string).length).toBeGreaterThan(0);
    }
  });

  it("uses unique tile identities", () => {
    const names = apps.map((app) => app.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leads with the featured internal-tool apps that ship hero art", () => {
    // The first tiles are the curated internal tools; each carries real artwork.
    const featured = apps.slice(0, 13);
    for (const app of featured) {
      expect(app.heroImage).toBeTruthy();
    }
  });
});
