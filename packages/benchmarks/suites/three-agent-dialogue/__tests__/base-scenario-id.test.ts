// Exercises three-agent-dialogue benchmark three agent dialogue tests base scenario id.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import { baseScenarioId, EDGE_VARIANTS } from "../runner/scenarios";

/**
 * Scenario-id helpers. An edge-variant id is `<base>--edge-<suffix>`;
 * baseScenarioId must recover the base id so per-base rollups group correctly.
 * The edge-variant catalog must have unique, well-formed entries.
 */

describe("baseScenarioId", () => {
  it("strips the --edge-<suffix> portion, leaves plain ids untouched", () => {
    expect(baseScenarioId("debate-01--edge-interruption-recovery")).toBe(
      "debate-01",
    );
    expect(baseScenarioId("debate-01")).toBe("debate-01");
    // only the first marker splits (base never contains the marker).
    expect(baseScenarioId("x--edge-a--edge-b")).toBe("x");
  });
});

describe("EDGE_VARIANTS catalog", () => {
  it("has unique suffixes and required fields", () => {
    expect(EDGE_VARIANTS.length).toBeGreaterThan(0);
    const suffixes = EDGE_VARIANTS.map((v) => v.suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length); // unique
    for (const v of EDGE_VARIANTS) {
      expect(v.suffix.length).toBeGreaterThan(0);
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.prompt.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });
});
