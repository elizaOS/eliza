/** Exercises Cloud route registration and legacy-route compatibility. */
import { describe, expect, it } from "vitest";
import { registerAllCloudSurfaces } from "./register-all";
import { registerPublicCloudSurfaces } from "./register-public";
import { getCloudRoute, listCloudRoutes } from "./shell/cloud-route-registry";

describe("registerAllCloudSurfaces (sync public API contract)", () => {
  it("maps legacy Applications URLs to the moved Apps route", () => {
    registerAllCloudSurfaces();
    const movedAppsRoute = getCloudRoute("cloud/apps");
    expect(movedAppsRoute).toBeDefined();
    expect(getCloudRoute("cloud/apps/:id")?.element).toBe(
      movedAppsRoute?.element,
    );
    expect(getCloudRoute("cloud/applications")?.element).toBe(
      movedAppsRoute?.element,
    );
    expect(getCloudRoute("cloud/applications/:id")?.element).toBe(
      movedAppsRoute?.element,
    );
  });

  it("leaves the web Cloud Apps handoff in the tab/view app", () => {
    registerAllCloudSurfaces();
    const cloudApps = getCloudRoute("cloud-apps");
    expect(cloudApps).toBeUndefined();
  });

  it("keeps legacy-only spellings as redirects, not routes", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    for (const p of [
      "cloud/earnings",
      "cloud/affiliates",
      "cloud/security",
      "cloud/settings",
      "cloud/settings/connections",
    ]) {
      expect(paths, `unexpected standalone route ${p}`).not.toContain(p);
    }
  });
});

describe("progressive register-public (anonymous /login boot)", () => {
  it("registers public auth routes without requiring private domains", () => {
    registerPublicCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    expect(paths).toContain("login");
    expect(paths).toContain("join");
  });
});
