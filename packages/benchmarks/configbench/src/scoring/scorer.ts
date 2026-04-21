import type {
  Scenario, ScenarioOutcome, ScenarioScore, CategoryScore,
  HandlerResult, CheckResult, ScenarioCategory,
} from "../types.js";

const CATEGORY_WEIGHTS: Record<ScenarioCategory, number> = {
  "security": 3.0,
  "plugin-config": 2.0,
  "integration": 1.5,
  "secrets-crud": 1.0,
  "plugin-lifecycle": 1.0,
};

const SEVERITY_PENALTIES: Record<string, number> = {
  critical: 1.0,
  major: 0.3,
  minor: 0.1,
};

export function scoreScenario(scenario: Scenario, outcome: ScenarioOutcome): ScenarioScore {
  const checkResults: CheckResult[] = [];
  let hasCriticalFailure = false;
  let totalPenalty = 0;

  for (const check of scenario.checks) {
    const verdict = check.evaluate(outcome);
    checkResults.push({
      name: check.name,
      passed: verdict.passed,
      expected: verdict.expected,
      actual: verdict.actual,
      severity: check.severity,
    });
    if (!verdict.passed) {
      if (check.severity === "critical") hasCriticalFailure = true;
      totalPenalty += SEVERITY_PENALTIES[check.severity] ?? 0;
    }
  }

  const score = hasCriticalFailure ? 0 : Math.max(0, 1.0 - totalPenalty);
  const passed = score >= 0.5 && !hasCriticalFailure;

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    passed,
    score,
    securityViolation: outcome.secretLeakedInResponse,
    latencyMs: outcome.latencyMs,
    checks: checkResults,
    traces: outcome.traces,
  };
}

export function aggregateByCategory(scores: ScenarioScore[]): CategoryScore[] {
  const categories = new Map<ScenarioCategory, ScenarioScore[]>();
  for (const score of scores) {
    const existing = categories.get(score.category) ?? [];
    existing.push(score);
    categories.set(score.category, existing);
  }

  return [...categories.entries()].map(([category, catScores]) => ({
    category,
    scenarioCount: catScores.length,
    passedCount: catScores.filter(s => s.passed).length,
    averageScore: catScores.reduce((sum, s) => sum + s.score, 0) / catScores.length,
    securityViolations: catScores.filter(s => s.securityViolation).length,
  }));
}

function calculateOverallScore(categories: CategoryScore[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const cat of categories) {
    const weight = CATEGORY_WEIGHTS[cat.category] ?? 1.0;
    weightedSum += cat.averageScore * weight * cat.scenarioCount;
    totalWeight += weight * cat.scenarioCount;
  }
  return totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;
}

function calculateSecurityScore(scores: ScenarioScore[]): number {
  if (scores.some(s => s.securityViolation)) return 0;
  const secScores = scores.filter(s => s.category === "security");
  if (secScores.length === 0) return 100;
  return (secScores.reduce((sum, s) => sum + s.score, 0) / secScores.length) * 100;
}

function calculateCapabilityScore(scores: ScenarioScore[]): number {
  const capScores = scores.filter(s => s.category !== "security");
  if (capScores.length === 0) return 100;
  return (capScores.reduce((sum, s) => sum + s.score, 0) / capScores.length) * 100;
}

export function scoreHandler(
  handlerName: string,
  scenarios: Scenario[],
  outcomes: ScenarioOutcome[],
): HandlerResult {
  const outcomeMap = new Map(outcomes.map(o => [o.scenarioId, o]));
  const scenarioScores: ScenarioScore[] = [];
  let totalTimeMs = 0;

  for (const scenario of scenarios) {
    const outcome = outcomeMap.get(scenario.id);
    if (!outcome) {
      scenarioScores.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        category: scenario.category,
        passed: false,
        score: 0,
        securityViolation: false,
        latencyMs: 0,
        checks: scenario.checks.map(c => ({
          name: c.name, passed: false, expected: "Scenario executed",
          actual: "Scenario not executed", severity: c.severity,
        })),
        traces: ["ERROR: Scenario was not executed"],
      });
      continue;
    }
    const scored = scoreScenario(scenario, outcome);
    scenarioScores.push(scored);
    totalTimeMs += scored.latencyMs;
  }

  const categories = aggregateByCategory(scenarioScores);
  return {
    handlerName,
    overallScore: calculateOverallScore(categories),
    securityScore: calculateSecurityScore(scenarioScores),
    capabilityScore: calculateCapabilityScore(scenarioScores),
    categories,
    scenarios: scenarioScores,
    totalTimeMs,
  };
}
