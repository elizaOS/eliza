import { describe, expect, it } from "vitest";

import {
  canonicalPathForPath,
  getTabGroups,
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
