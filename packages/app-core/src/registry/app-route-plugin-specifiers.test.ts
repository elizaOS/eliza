import { describe, expect, it } from "vitest";
import { getApps, loadRegistry } from "./index";
import { appEntrySchema } from "./schema";

describe("app route plugin specifiers", () => {
  it("loads app route plugins by package specifier keyed to npmName", () => {
    const routePluginApps = getApps(loadRegistry()).filter(
      (app) => app.launch.routePlugin,
    );

    expect(routePluginApps.length).toBeGreaterThan(0);
    for (const app of routePluginApps) {
      const specifier = app.launch.routePlugin?.specifier ?? "";
      expect(app.npmName, `${app.id} must declare npmName`).toBeTruthy();
      expect(
        specifier === app.npmName || specifier.startsWith(`${app.npmName}/`),
        `${app.id} routePlugin specifier must be package-based`,
      ).toBe(true);
      expect(specifier).not.toMatch(/^(?:\.|\/)/);
      expect(specifier).not.toMatch(/(^|\/)(?:apps|plugins)\//);
    }
  });

  it("rejects filesystem paths for app route plugins", () => {
    const candidate = {
      id: "shopify-test",
      kind: "app",
      subtype: "marketplace",
      name: "Shopify Test",
      npmName: "@elizaos/app-shopify",
      render: {
        group: "Curated",
      },
      launch: {
        type: "server-launch",
        routePlugin: {
          specifier: "../../../plugins/app-shopify/src/plugin.ts",
          exportName: "shopifyPlugin",
        },
      },
    };

    expect(appEntrySchema.safeParse(candidate).success).toBe(false);
  });
});
