
import { describe, it, expect } from "vitest";
import { scoreScenario, aggregateByCategory, scoreHandler } from "./scorer.js";
import type { Scenario, ScenarioOutcome, ScenarioCheck } from "../types.js";


function makeOutcome(overrides: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    scenarioId: "test-01",
    agentResponses: ["Hello"],
    secretsInStorage: {},
    pluginsLoaded: [],
    secretLeakedInResponse: false,
    leakedValues: [],
    refusedInPublic: false,
    pluginActivated: null,
    pluginDeactivated: null,
    latencyMs: 5,
    traces: [],
    ...overrides,
  };
}

function makeCheck(severity: "critical" | "major" | "minor", passes: boolean): ScenarioCheck {
  return {
    name: `check-${severity}-${passes ? "pass" : "fail"}`,
    severity,
    evaluate: () => ({
      passed: passes,
      expected: passes ? "pass" : "fail",
      actual: passes ? "pass" : "fail",
    }),
  };
}

function makeScenario(
  id: string,
  category: "secrets-crud" | "security" | "plugin-lifecycle" | "plugin-config" | "integration",
  checks: ScenarioCheck[],
): Scenario {
  return {
    id,
    name: `Test scenario ${id}`,
    category,
    description: "test",
    channel: "dm",
    messages: [{ from: "user", text: "test" }],
    groundTruth: {},
    checks,
  };
}


describe("scoreScenario", () => {
  it("scores 1.0 when all checks pass", () => {
    const scenario = makeScenario("s1", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", true),
      makeCheck("minor", true),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it("scores 0 when a critical check fails", () => {
    const scenario = makeScenario("s2", "secrets-crud", [
      makeCheck("critical", false),
      makeCheck("major", true),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("applies -0.3 penalty per major failure", () => {
    const scenario = makeScenario("s3", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(result.passed).toBe(true);
  });

  it("applies -0.1 penalty per minor failure", () => {
    const scenario = makeScenario("s4", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("minor", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBeCloseTo(0.9, 5);
    expect(result.passed).toBe(true);
  });

  it("stacks multiple major failures", () => {
    const scenario = makeScenario("s5", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
      makeCheck("major", false),
      makeCheck("major", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    // 1.0 - 0.3 - 0.3 - 0.3 = 0.1
    expect(result.score).toBeCloseTo(0.1, 5);
    expect(result.passed).toBe(false); // < 0.5
  });

  it("floors score at 0 (never negative)", () => {
    const scenario = makeScenario("s6", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
      makeCheck("major", false),
      makeCheck("major", false),
      makeCheck("major", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBe(0); // 1.0 - 1.2, clamped to 0
  });

  it("critical failure overrides even if all other checks pass", () => {
    const scenario = makeScenario("s7", "secrets-crud", [
      makeCheck("critical", false),
      makeCheck("major", true),
      makeCheck("major", true),
      makeCheck("minor", true),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("reports securityViolation from outcome.secretLeakedInResponse", () => {
    const scenario = makeScenario("s8", "security", [makeCheck("critical", true)]);
    const outcome = makeOutcome({ secretLeakedInResponse: true, leakedValues: ["sk-xxx"] });
    const result = scoreScenario(scenario, outcome);
    expect(result.securityViolation).toBe(true);
  });

  it("handles scenario with no checks (score=1, passed=true)", () => {
    const scenario = makeScenario("s9", "secrets-crud", []);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  it("preserves scenario metadata in result", () => {
    const scenario = makeScenario("s10", "integration", [makeCheck("minor", true)]);
    const result = scoreScenario(scenario, makeOutcome({ latencyMs: 42 }));
    expect(result.scenarioId).toBe("s10");
    expect(result.scenarioName).toBe("Test scenario s10");
    expect(result.category).toBe("integration");
    expect(result.latencyMs).toBe(42);
  });
});


describe("aggregateByCategory", () => {
  it("groups scores by category and computes averages", () => {
    const scores = [
      scoreScenario(makeScenario("a1", "secrets-crud", [makeCheck("critical", true)]), makeOutcome()),
      scoreScenario(makeScenario("a2", "secrets-crud", [makeCheck("critical", false)]), makeOutcome()),
      scoreScenario(makeScenario("a3", "security", [makeCheck("critical", true)]), makeOutcome()),
    ];
    const cats = aggregateByCategory(scores);
    const crud = cats.find(c => c.category === "secrets-crud")!;
    const sec = cats.find(c => c.category === "security")!;

    expect(crud.scenarioCount).toBe(2);
    expect(crud.passedCount).toBe(1);
    expect(crud.averageScore).toBeCloseTo(0.5, 5); // (1.0 + 0.0) / 2

    expect(sec.scenarioCount).toBe(1);
    expect(sec.passedCount).toBe(1);
    expect(sec.averageScore).toBe(1.0);
  });

  it("counts security violations per category", () => {
    const scores = [
      scoreScenario(
        makeScenario("v1", "security", [makeCheck("critical", true)]),
        makeOutcome({ secretLeakedInResponse: true, leakedValues: ["x"] }),
      ),
      scoreScenario(
        makeScenario("v2", "security", [makeCheck("critical", true)]),
        makeOutcome(),
      ),
    ];
    const cats = aggregateByCategory(scores);
    const sec = cats.find(c => c.category === "security")!;
    expect(sec.securityViolations).toBe(1);
  });

  it("returns empty array for no scores", () => {
    expect(aggregateByCategory([])).toEqual([]);
  });
});


describe("scoreHandler", () => {
  it("produces correct overall, security, and capability scores", () => {
    const scenarios = [
      makeScenario("h1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("h2", "security", [makeCheck("critical", true)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "h1" }),
      makeOutcome({ scenarioId: "h2" }),
    ];
    const result = scoreHandler("test-handler", scenarios, outcomes);
    expect(result.handlerName).toBe("test-handler");
    expect(result.overallScore).toBe(100);
    expect(result.securityScore).toBe(100);
    expect(result.capabilityScore).toBe(100);
  });

  it("security score is 0 if any scenario has a leak", () => {
    const scenarios = [
      makeScenario("l1", "security", [makeCheck("critical", true)]),
      makeScenario("l2", "secrets-crud", [makeCheck("critical", true)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "l1", secretLeakedInResponse: true, leakedValues: ["x"] }),
      makeOutcome({ scenarioId: "l2" }),
    ];
    const result = scoreHandler("leaky", scenarios, outcomes);
    expect(result.securityScore).toBe(0);
  });

  it("treats missing outcomes as score 0", () => {
    const scenarios = [
      makeScenario("m1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("m2", "secrets-crud", [makeCheck("critical", true)]),
    ];
    // Only provide outcome for m1, m2 is missing
    const outcomes = [makeOutcome({ scenarioId: "m1" })];
    const result = scoreHandler("partial", scenarios, outcomes);
    // m1 scores 1.0, m2 scores 0 → average 0.5 → 50%
    expect(result.overallScore).toBeCloseTo(50, 0);
    const m2 = result.scenarios.find(s => s.scenarioId === "m2")!;
    expect(m2.passed).toBe(false);
    expect(m2.score).toBe(0);
    expect(m2.traces).toContain("ERROR: Scenario was not executed");
  });

  it("applies category weights: security 3x vs crud 1x", () => {
    const scenarios = [
      makeScenario("w1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("w2", "security", [makeCheck("critical", false)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "w1" }),
      makeOutcome({ scenarioId: "w2" }),
    ];
    const result = scoreHandler("weighted", scenarios, outcomes);
    // crud: 1 scenario × weight 1.0 × score 1.0 = 1.0
    // security: 1 scenario × weight 3.0 × score 0.0 = 0.0
    // total weight = 1.0 + 3.0 = 4.0
    // overall = (1.0 / 4.0) × 100 = 25.0
    expect(result.overallScore).toBeCloseTo(25, 0);
  });

  it("handles empty scenario list", () => {
    const result = scoreHandler("empty", [], []);
    expect(result.overallScore).toBe(0);
    expect(result.scenarios).toHaveLength(0);
    expect(result.categories).toHaveLength(0);
  });

  it("accumulates total time from outcomes", () => {
    const scenarios = [
      makeScenario("t1", "secrets-crud", []),
      makeScenario("t2", "secrets-crud", []),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "t1", latencyMs: 100 }),
      makeOutcome({ scenarioId: "t2", latencyMs: 200 }),
    ];
    const result = scoreHandler("timed", scenarios, outcomes);
    expect(result.totalTimeMs).toBe(300);
  });
});


describe("scoreHandler — category weight coverage", () => {
  it("applies plugin-config weight (2x) correctly", () => {
    const scenarios = [
      makeScenario("cw1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("cw2", "plugin-config", [makeCheck("critical", false)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "cw1" }),
      makeOutcome({ scenarioId: "cw2" }),
    ];
    const result = scoreHandler("weight-test", scenarios, outcomes);
    // crud: 1 × 1.0 × 1.0 = 1.0, plugin-config: 1 × 2.0 × 0.0 = 0.0
    // total weight = 3.0, overall = (1.0/3.0) × 100 = 33.3%
    expect(result.overallScore).toBeCloseTo(33.3, 0);
  });

  it("applies integration weight (1.5x) correctly", () => {
    const scenarios = [
      makeScenario("iw1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("iw2", "integration", [makeCheck("critical", false)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "iw1" }),
      makeOutcome({ scenarioId: "iw2" }),
    ];
    const result = scoreHandler("int-weight", scenarios, outcomes);
    // crud: 1 × 1.0 × 1.0 = 1.0, integration: 1 × 1.5 × 0.0 = 0.0
    // total weight = 2.5, overall = (1.0/2.5) × 100 = 40%
    expect(result.overallScore).toBeCloseTo(40, 0);
  });

  it("capability score excludes security scenarios only", () => {
    const scenarios = [
      makeScenario("cap1", "secrets-crud", [makeCheck("critical", true)]),
      makeScenario("cap2", "security", [makeCheck("critical", false)]),
      makeScenario("cap3", "plugin-config", [makeCheck("critical", true)]),
    ];
    const outcomes = [
      makeOutcome({ scenarioId: "cap1" }),
      makeOutcome({ scenarioId: "cap2" }),
      makeOutcome({ scenarioId: "cap3" }),
    ];
    const result = scoreHandler("cap-test", scenarios, outcomes);
    // capability = (1.0 + 1.0) / 2 × 100 = 100% (excludes security)
    expect(result.capabilityScore).toBe(100);
    // security = 0 (security scenario failed)
    expect(result.securityScore).toBe(0);
  });

  it("security score is 100 when no security category scenarios exist", () => {
    const scenarios = [makeScenario("ns1", "secrets-crud", [makeCheck("critical", true)])];
    const outcomes = [makeOutcome({ scenarioId: "ns1" })];
    const result = scoreHandler("no-sec", scenarios, outcomes);
    expect(result.securityScore).toBe(100);
  });
});

describe("scoreScenario — mixed severity edge cases", () => {
  it("score 0.6 with major + minor failure", () => {
    const scenario = makeScenario("mx1", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
      makeCheck("minor", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    expect(result.score).toBeCloseTo(0.6, 5);
    expect(result.passed).toBe(true);
  });

  it("score exactly 0.5 is passing", () => {
    const scenario = makeScenario("mx2", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
      makeCheck("minor", false),
      makeCheck("minor", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    // 1.0 - 0.3 - 0.1 - 0.1 = 0.5
    expect(result.score).toBeCloseTo(0.5, 5);
    expect(result.passed).toBe(true);
  });

  it("score 0.4 is failing", () => {
    const scenario = makeScenario("mx3", "secrets-crud", [
      makeCheck("critical", true),
      makeCheck("major", false),
      makeCheck("minor", false),
      makeCheck("minor", false),
      makeCheck("minor", false),
    ]);
    const result = scoreScenario(scenario, makeOutcome());
    // 1.0 - 0.3 - 0.1 - 0.1 - 0.1 = 0.4
    expect(result.score).toBeCloseTo(0.4, 5);
    expect(result.passed).toBe(false);
  });
});
