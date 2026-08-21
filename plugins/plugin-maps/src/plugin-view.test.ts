/** Verifies the routed Maps view declaration and signed app registration. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAPS_VIEW_CAPABILITIES } from "./capabilities.js";
import { mapsPlugin } from "./plugin.js";

const registerAppShellPage = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/app-shell-registry", () => ({ registerAppShellPage }));

describe("Maps routed view", () => {
  beforeEach(() => registerAppShellPage.mockClear());

  it("declares /maps with read capabilities and receipt-safe action affinity", () => {
    expect(mapsPlugin.views).toEqual([
      expect.objectContaining({
        id: "maps",
        path: "/maps",
        bundlePath: "dist/views/bundle.js",
        componentExport: "MapsView",
        modalities: ["gui"],
        capabilities: MAPS_VIEW_CAPABILITIES,
        relatedActions: [
          "MAPS_PLACE",
          "MAPS_ROUTE",
          "MAPS_SAVE",
          "MAPS_SHARE",
          "MAPS_NAVIGATE",
        ],
        visibleInManager: true,
        desktopTabEnabled: true,
      }),
    ]);
    expect(mapsPlugin.views?.[0]?.serverInteract).toBeTypeOf("function");
  });

  it("registers the signed /maps fallback with a local component loader", async () => {
    vi.resetModules();
    await import("./register.js");
    expect(registerAppShellPage).toHaveBeenCalledOnce();
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "maps",
        pluginId: "@elizaos/plugin-maps",
        path: "/maps",
        loader: expect.any(Function),
      }),
    );
  });
});
