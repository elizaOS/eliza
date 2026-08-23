/**
 * Coverage for agent-flavors.
 */
import { describe, expect, it } from "vitest";
import { getAgentFlavorsForEnv, getDefaultFlavor, getFlavorById } from "./agent-flavors.js";

describe("agent-flavors", () => {
  it("returns flavors", () => {
    const flavors = getAgentFlavorsForEnv();
    expect(flavors.length).toBeGreaterThan(0);
    expect(flavors[0].id).toBeTruthy();
  });
  it("gets default flavor", () => {
    const d = getDefaultFlavor();
    expect(d.id).toBeTruthy();
  });
  it("gets by id", () => {
    expect(getFlavorById("custom")?.id).toBe("custom");
    expect(getFlavorById("unknown")).toBeUndefined();
  });
});
