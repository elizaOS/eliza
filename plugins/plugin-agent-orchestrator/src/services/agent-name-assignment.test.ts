/**
 * Unit tests for agent-name-assignment: validates explicit label precedence and pool uniqueness.
 */
import { describe, expect, it } from "vitest";
import { assignAgentName, pickSubAgentName } from "./agent-name-assignment.ts";

describe("agent-name-assignment", () => {
  it("honors explicit label when provided", () => {
    const name = assignAgentName({
      explicitLabel: "CustomWorker",
      activeNames: ["Reimu"],
    });
    expect(name).toBe("CustomWorker");
  });

  it("picks non-empty sub agent name avoiding active names", () => {
    const name = pickSubAgentName(["Reimu", "Marisa"]);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    expect(["Reimu", "Marisa"]).not.toContain(name);
  });

  it("assigns pooled name when no explicit label is given", () => {
    const name = assignAgentName({
      activeNames: [],
      mainAgentName: "Eliza",
    });
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    expect(name).not.toBe("Eliza");
  });
});
