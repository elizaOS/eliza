
import { describe, it, expect } from "vitest";
import { runBenchmark } from "./runner.js";
import type { Handler, Scenario, ScenarioOutcome, BenchmarkResults } from "./types.js";
import { checkAgentResponded, checkNoSecretLeak } from "./scenarios/checks.js";

function makeScenario(id: string): Scenario {
  return {
    id,
    name: `Scenario ${id}`,
    category: "secrets-crud",
    description: "test",
    channel: "dm",
    messages: [{ from: "user", text: "test" }],
    groundTruth: {},
    checks: [checkAgentResponded(), checkNoSecretLeak()],
  };
}

function makePassingOutcome(scenarioId: string): ScenarioOutcome {
  return {
    scenarioId,
    agentResponses: ["OK"],
    secretsInStorage: {},
    pluginsLoaded: [],
    secretLeakedInResponse: false,
    leakedValues: [],
    refusedInPublic: false,
    pluginActivated: null,
    pluginDeactivated: null,
    latencyMs: 1,
    traces: [],
  };
}

describe("runBenchmark", () => {
  it("runs all scenarios through all handlers and returns results", async () => {
    const scenarios = [makeScenario("r1"), makeScenario("r2")];

    let setupCalled = false;
    let teardownCalled = false;
    const handler: Handler = {
      name: "Test Handler",
      async setup() { setupCalled = true; },
      async teardown() { teardownCalled = true; },
      async run(scenario) { return makePassingOutcome(scenario.id); },
    };

    const results = await runBenchmark([handler], scenarios);

    expect(setupCalled).toBe(true);
    expect(teardownCalled).toBe(true);
    expect(results.totalScenarios).toBe(2);
    expect(results.handlers).toHaveLength(1);
    expect(results.handlers[0].handlerName).toBe("Test Handler");
    expect(results.handlers[0].overallScore).toBe(100);
    expect(results.handlers[0].scenarios).toHaveLength(2);
  });

  it("calls progress callback with correct arguments", async () => {
    const scenarios = [makeScenario("p1"), makeScenario("p2")];
    const handler: Handler = {
      name: "Prog",
      async run(s) { return makePassingOutcome(s.id); },
    };

    const calls: Array<[string, string, number, number]> = [];
    await runBenchmark([handler], scenarios, {
      progressCallback: (h, s, i, t) => { calls.push([h, s, i, t]); },
    });

    expect(calls).toEqual([
      ["Prog", "p1", 1, 2],
      ["Prog", "p2", 2, 2],
    ]);
  });

  it("sets validationPassed=true when handler named 'Perfect' scores 100%", async () => {
    const scenarios = [makeScenario("v1")];
    const handler: Handler = {
      name: "Perfect (Oracle)",
      async run(s) { return makePassingOutcome(s.id); },
    };
    const results = await runBenchmark([handler], scenarios);
    expect(results.validationPassed).toBe(true);
  });

  it("sets validationPassed=false when no handler named 'Perfect'", async () => {
    const scenarios = [makeScenario("v2")];
    const handler: Handler = {
      name: "Other",
      async run(s) { return makePassingOutcome(s.id); },
    };
    const results = await runBenchmark([handler], scenarios);
    expect(results.validationPassed).toBe(false);
  });

  it("sets validationPassed=false when Perfect handler fails", async () => {
    const scenarios = [makeScenario("v3")];
    const handler: Handler = {
      name: "Perfect",
      async run(s) {
        return {
          ...makePassingOutcome(s.id),
          agentResponses: [], // will fail checkAgentResponded (critical)
        };
      },
    };
    const results = await runBenchmark([handler], scenarios);
    expect(results.validationPassed).toBe(false);
  });

  it("handles multiple handlers in sequence", async () => {
    const scenarios = [makeScenario("m1")];
    const h1: Handler = { name: "H1", async run(s) { return makePassingOutcome(s.id); } };
    const h2: Handler = { name: "H2", async run(s) { return makePassingOutcome(s.id); } };
    const results = await runBenchmark([h1, h2], scenarios);
    expect(results.handlers).toHaveLength(2);
    expect(results.handlers[0].handlerName).toBe("H1");
    expect(results.handlers[1].handlerName).toBe("H2");
  });

  it("handles empty scenario list gracefully", async () => {
    const handler: Handler = { name: "Empty", async run() { throw new Error("should not be called"); } };
    const results = await runBenchmark([handler], []);
    expect(results.totalScenarios).toBe(0);
    expect(results.handlers[0].scenarios).toHaveLength(0);
  });

  it("includes timestamp in results", async () => {
    const results = await runBenchmark([], []);
    expect(results.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
