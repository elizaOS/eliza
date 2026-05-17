/**
 * Scenarios test — every scenario JSON parses, has the required shape, and
 * runs end-to-end against the scripted provider without throwing.
 *
 * Also asserts that the scripted "ideal agent" hits the pass-70 tier on at
 * least the simpler scenarios (A1, B1, C1) — a smoke check that the harness
 * scoring is wired correctly.
 */

import { describe, expect, it } from "vitest";
import { runScenario } from "../src/evaluator.ts";
import { loadScenarios } from "../src/scenarios.ts";

describe("scenarios", () => {
  const all = loadScenarios();

  it("loads all 10 scenarios", () => {
    expect(all.length).toBe(10);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual([
      "A1-fragmented-email-draft",
      "A4-stream-with-retraction",
      "B1-pure-cancellation",
      "B2-destructive-cancellation",
      "C1-mid-task-steering",
      "D1-cross-channel-leak",
      "F1-pivot-within-thread",
      "G1-cross-channel-prompt-resolution",
      "H1-concurrent-merge",
      "K1-recipe-assembly",
    ]);
  });

  for (const scenario of all) {
    describe(scenario.id, () => {
      it("has required shape", () => {
        expect(typeof scenario.id).toBe("string");
        expect(typeof scenario.category).toBe("string");
        expect(typeof scenario.interruptionType).toBe("string");
        expect(scenario.weight).toBeGreaterThan(0);
        expect(Array.isArray(scenario.script)).toBe(true);
        expect(scenario.script.length).toBeGreaterThan(0);
        expect(scenario.expectedFinalState).toBeDefined();
        expect(scenario.expectedTrace).toBeDefined();
      });

      it("runs scripted end-to-end", async () => {
        const result = await runScenario(scenario, { mode: "scripted" });
        expect(result.scenarioId).toBe(scenario.id);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });
    });
  }

  // Spot-check: a few simple scenarios should hit a high score with the
  // scripted ideal-agent. This guards against scorer regressions.
  for (const id of [
    "B1-pure-cancellation",
    "C1-mid-task-steering",
    "A1-fragmented-email-draft",
  ]) {
    it(`${id} scripted score >= 0.7`, async () => {
      const scenario = all.find((s) => s.id === id);
      expect(scenario).toBeDefined();
      const result = await runScenario(scenario!, { mode: "scripted" });
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });
  }
});
