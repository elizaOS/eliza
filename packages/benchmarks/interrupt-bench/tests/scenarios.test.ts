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
import {
  countInterruptBenchScenarios,
  loadScenarios,
  validateInterruptBenchScenarios,
} from "../src/scenarios.ts";
import { scoreScenario } from "../src/scorer.ts";
import { SimulatorState } from "../src/state.ts";
import { Trace } from "../src/trace.ts";

describe("scenarios", () => {
  const all = loadScenarios();

  function mustFindScenario(id: string) {
    const scenario = all.find((s) => s.id === id);
    expect(scenario).toBeDefined();
    if (!scenario) throw new Error(`Scenario ${id} not found`);
    return scenario;
  }

  it("expands the authored base set by exactly 10x", () => {
    expect(countInterruptBenchScenarios()).toEqual({
      suite: "interrupt-bench",
      existing: 10,
      added: 100,
      total: 110,
      multiplierAdded: 10,
    });
    expect(validateInterruptBenchScenarios()).toEqual({
      valid: true,
      total: 110,
      uniqueIds: 110,
      duplicateIds: [],
      emptyScriptSteps: [],
      expansionMatches: true,
    });
  });

  it("loads all 10 authored scenarios plus 100 edge variants", () => {
    expect(all.length).toBe(110);
    const ids = new Set(all.map((s) => s.id));
    expect([...ids].filter((id) => !id.includes("--edge-")).sort()).toEqual([
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
      const scenario = mustFindScenario(id);
      const result = await runScenario(scenario, { mode: "scripted" });
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });
  }

  it("coalesces rapid same-channel fragments before Stage-1", async () => {
    const scenario = mustFindScenario("A1-fragmented-email-draft");

    const result = await runScenario(scenario, { mode: "scripted" });
    const stage1Calls = result.trace.filter(
      (event) => event.type === "stage1_call",
    );

    expect(stage1Calls).toHaveLength(1);
    expect(result.score).toBe(1);
  });

  it("does not score live harness transport latency as behavior", async () => {
    const scenario = mustFindScenario("B1-pure-cancellation");
    const trace = new Trace(() => 0);
    trace.push("stage1_response", {
      detail: {
        shouldRespond: "RESPOND",
        llmLatencyMs: 5000,
      },
    });

    const scripted = scoreScenario({
      scenario,
      finalState: SimulatorState.fromSetup(scenario.setup),
      trace,
      durationMs: 5000,
      mode: "scripted",
    });
    const harnessLike = scoreScenario({
      scenario,
      finalState: SimulatorState.fromSetup(scenario.setup),
      trace,
      durationMs: 5000,
      mode: "harness",
    });

    expect(scripted.axes.latency.raw).toBeLessThan(1);
    // In harness mode the latency axis is excluded (not a free 1.0): it
    // contributes neither score nor weight.
    expect(harnessLike.axes.latency.excluded).toBe(true);
    expect(harnessLike.axes.latency.weighted).toBe(0);
    expect(harnessLike.axes.latency.notes[0]).toContain(
      "excluded for harness mode",
    );
  });
});
