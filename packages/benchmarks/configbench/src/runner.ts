import type { Handler, Scenario, ScenarioOutcome, BenchmarkResults } from "./types.js";
import { scoreHandler } from "./scoring/scorer.js";

async function runHandler(
  handler: Handler,
  scenarios: Scenario[],
  progressCallback?: (scenarioId: string, index: number, total: number) => void,
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  if (handler.setup) await handler.setup();

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    progressCallback?.(scenario.id, i + 1, scenarios.length);
    outcomes.push(await handler.run(scenario));
  }

  if (handler.teardown) await handler.teardown();
  return outcomes;
}

export async function runBenchmark(
  handlers: Handler[],
  scenarios: Scenario[],
  options: {
    progressCallback?: (handler: string, scenarioId: string, index: number, total: number) => void;
  } = {},
): Promise<BenchmarkResults> {
  const handlerResults = [];

  for (const handler of handlers) {
    const progress = options.progressCallback
      ? (id: string, idx: number, total: number) => options.progressCallback!(handler.name, id, idx, total)
      : undefined;
    const outcomes = await runHandler(handler, scenarios, progress);
    handlerResults.push(scoreHandler(handler.name, scenarios, outcomes));
  }

  const perfectResult = handlerResults.find(r => r.handlerName.includes("Perfect") || r.handlerName.includes("Oracle"));

  return {
    timestamp: new Date().toISOString(),
    totalScenarios: scenarios.length,
    handlers: handlerResults,
    validationPassed: perfectResult ? perfectResult.overallScore >= 99.9 : false,
  };
}
