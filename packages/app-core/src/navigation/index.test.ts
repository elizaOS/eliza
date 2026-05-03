import { describe, expect, it } from "vitest";

import {
  canonicalPathForPath,
  getTabGroups,
  isAndroidPhoneSurfaceEnabled,
  pathForTab,
  tabFromPath,
} from "./index";

describe("navigation", () => {
  it("routes node catalog URLs into automations", () => {
    expect(tabFromPath("/node-catalog")).toBe("automations");
    expect(tabFromPath("/automations/node-catalog")).toBe("automations");
  });

  it("does not expose a standalone node catalog tab group", () => {
    expect(getTabGroups().some((group) => group.label === "Nodes")).toBe(false);
  });

  it("hides phone navigation outside Android unless the android test flag is set", () => {
    expect(
      getTabGroups(true, true, true, undefined, false).some(
        (group) => group.label === "Phone",
      ),
    ).toBe(false);
    expect(
      getTabGroups(true, true, true, undefined, true).some(
        (group) => group.label === "Phone",
      ),
    ).toBe(true);
    expect(
      isAndroidPhoneSurfaceEnabled({
        platform: "web",
        isNative: false,
        search: "?android=true",
        hash: "",
      }),
    ).toBe(true);
    expect(
      isAndroidPhoneSurfaceEnabled({
        platform: "android",
        isNative: true,
        search: "",
        hash: "",
      }),
    ).toBe(true);
    expect(
      isAndroidPhoneSurfaceEnabled({
        platform: "web",
        isNative: false,
        search: "",
        hash: "",
      }),
    ).toBe(false);
  });

  it("uses canonical app and wallet paths while keeping legacy aliases routable", () => {
    expect(pathForTab("lifeops")).toBe("/apps/lifeops");
    expect(pathForTab("inventory")).toBe("/wallet");
    expect(tabFromPath("/lifeops")).toBe("lifeops");
    expect(tabFromPath("/apps/lifeops")).toBe("lifeops");
    expect(tabFromPath("/inventory")).toBe("inventory");
    expect(tabFromPath("/wallet")).toBe("inventory");
    expect(canonicalPathForPath("/lifeops")).toBe("/apps/lifeops");
    expect(canonicalPathForPath("/inventory")).toBe("/wallet");
  });
});
