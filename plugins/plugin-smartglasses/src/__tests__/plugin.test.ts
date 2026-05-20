import { describe, expect, it } from "vitest";
import { smartglassesPlugin } from "../index.js";

describe("smartglasses plugin declaration", () => {
  it("registers the Smartglasses View Manager page and app nav tab", () => {
    const view = smartglassesPlugin.views?.find(
      (candidate) => candidate.id === "smartglasses",
    );
    const navTab = smartglassesPlugin.app?.navTabs?.find(
      (candidate) => candidate.id === "smartglasses",
    );

    expect(view).toMatchObject({
      label: "Smartglasses",
      path: "/apps/smartglasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SmartglassesView",
      visibleInManager: true,
      desktopTabEnabled: true,
    });
    expect(view?.tags).toEqual(
      expect.arrayContaining([
        "smartglasses",
        "bluetooth",
        "wifi",
        "hardware",
        "even-realities",
      ]),
    );
    expect(view?.capabilities?.map((capability) => capability.id)).toEqual(
      expect.arrayContaining(["connect-headset", "run-hardware-check"]),
    );
    expect(navTab).toMatchObject({
      label: "Smartglasses",
      path: "/apps/smartglasses",
      componentExport: "@elizaos/plugin-smartglasses/register#SmartglassesView",
    });
  });
});
