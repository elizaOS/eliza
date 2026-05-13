import { scoreHandler } from "./scoring/scorer.js";
import type {
  BenchmarkResults,
  Handler,
  Scenario,
  ScenarioOutcome,
} from "./types.js";

async function runHandler(
  handler: Handler,
  scenarios: Scenario[],
  progressCallback?: (scenarioId: string, index: number, total: number) => void,
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  if (handler.setup) {
    try {
      await handler.setup();
    } catch (error) {
      return scenarios.map((scenario) =>
        failedOutcome(scenario, 0, `setup failed: ${errorMessage(error)}`),
      );
    }
  }

  try {
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      progressCallback?.(scenario.id, i + 1, scenarios.length);
      const started = Date.now();
      try {
        outcomes.push(await handler.run(scenario));
      } catch (error) {
        outcomes.push(
          failedOutcome(scenario, Date.now() - started, errorMessage(error)),
        );
      }
    }
  } finally {
    if (handler.teardown) {
      try {
        await handler.teardown();
      } catch (error) {
        const message = `ERROR: teardown failed: ${errorMessage(error)}`;
        for (const outcome of outcomes) outcome.traces.push(message);
      }
    }
  }
  return outcomes;
}

function failedOutcome(
  scenario: Scenario,
  latencyMs: number,
  error: string,
): ScenarioOutcome {
  return {
    scenarioId: scenario.id,
    agentResponses: [],
    secretsInStorage: {},
    pluginsLoaded: [],
    secretLeakedInResponse: false,
    leakedValues: [],
    refusedInPublic: false,
    pluginActivated: null,
    pluginDeactivated: null,
    latencyMs,
    traces: [`ERROR: ${error}`],
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBenchmark(
  handlers: Handler[],
  scenarios: Scenario[],
  options: {
    progressCallback?: (
      handler: string,
      scenarioId: string,
      index: number,
      total: number,
    ) => void;
  } = {},
): Promise<BenchmarkResults> {
  const handlerResults = [];

  for (const handler of handlers) {
    const progress = options.progressCallback
      ? (id: string, idx: number, total: number) =>
          options.progressCallback?.(handler.name, id, idx, total)
      : undefined;
    const outcomes = await runHandler(handler, scenarios, progress);
    handlerResults.push(scoreHandler(handler.name, scenarios, outcomes));
  }

  const perfectResult = handlerResults.find(
    (r) =>
      r.handlerName.includes("Perfect") || r.handlerName.includes("Oracle"),
  );

  return {
    timestamp: new Date().toISOString(),
    totalScenarios: scenarios.length,
    handlers: handlerResults,
    validationPassed: perfectResult
      ? perfectResult.overallScore >= 99.9
      : false,
  };
}
