import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { smartglassesPlugin } from "../index.js";

const PACKAGE_JSON_PATH = join(import.meta.dirname, "..", "..", "package.json");

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
      expect.arrayContaining([
        "connect-headset",
        "run-hardware-check",
        "guided-side-tap-audio-validation",
        "configure-wifi",
      ]),
    );
    expect(navTab).toMatchObject({
      label: "Smartglasses",
      path: "/apps/smartglasses",
      componentExport: "@elizaos/plugin-smartglasses/register#SmartglassesView",
    });
  });

  it("advertises package capabilities that match the implemented surfaces", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      elizaos?: { plugin?: { capabilities?: string[] } };
    };

    expect(packageJson.elizaos?.plugin?.capabilities).toEqual(
      expect.arrayContaining([
        "smartglasses",
        "wearable-display",
        "wearable-microphone",
        "side-tap-microphone-control",
        "wifi-provisioning",
        "whole-headset-pairing",
      ]),
    );
  });
});
