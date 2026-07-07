import { describe, expect, it } from "vitest";
import { birdclawPlugin } from "./plugin.ts";

/**
 * Structural guard for the plugin registration surface: the view descriptor
 * is what the agent's view registry and the app launcher consume, so drift
 * here (renamed export, moved bundle, dropped modality) breaks the tile at
 * runtime without a type error.
 */
describe("birdclawPlugin registration surface", () => {
  it("registers the service, action, and routes", () => {
    expect(birdclawPlugin.name).toBe("birdclaw");
    expect(birdclawPlugin.services?.map((svc) => svc.serviceType)).toContain(
      "BIRDCLAW_SERVICE",
    );
    expect(birdclawPlugin.actions?.map((action) => action.name)).toEqual([
      "BIRDCLAW",
    ]);
    expect(birdclawPlugin.routes?.map((route) => route.name)).toEqual([
      "birdclaw-status",
      "birdclaw-tweets",
      "birdclaw-inbox",
      "birdclaw-sync",
      "birdclaw-digest",
    ]);
  });

  it("declares the birdclaw view exactly as the bundle build emits it", () => {
    const views = birdclawPlugin.views ?? [];
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "birdclaw",
      label: "Birdclaw",
      path: "/birdclaw",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "BirdclawView",
      visibleInManager: true,
    });
  });
});
