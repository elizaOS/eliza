import { describe, expect, it } from "vitest";

import { getTabGroups, tabFromPath } from "./index";

describe("navigation", () => {
  it("routes node catalog URLs into automations", () => {
    expect(tabFromPath("/node-catalog")).toBe("automations");
    expect(tabFromPath("/automations/node-catalog")).toBe("automations");
  });

  it("does not expose a standalone node catalog tab group", () => {
    expect(getTabGroups().some((group) => group.label === "Nodes")).toBe(false);
  });
});
