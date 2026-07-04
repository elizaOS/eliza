// Exercises configbench benchmark configbench tests scenario library.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  countConfigBenchScenarios,
  validateConfigBenchScenarios,
} from "../src/scenarios/index.js";

describe("ConfigBench scenario library", () => {
  it("expands the authored base set by exactly 10x", () => {
    expect(countConfigBenchScenarios()).toEqual({
      suite: "configbench",
      existing: 62,
      added: 620,
      total: 682,
      multiplierAdded: 10,
    });
  });

  it("keeps expanded scenarios structurally valid", () => {
    expect(validateConfigBenchScenarios()).toEqual({
      valid: true,
      total: 682,
      uniqueIds: 682,
      duplicateIds: [],
      emptyMessages: [],
      expansionMatches: true,
    });
  });
});
