import { scoreHandler } from "./scoring/scorer.js";
import { isSetupIncompatibleError } from "./setup-incompatible.js";
import type {
  BenchmarkResults,
  Handler,
  Scenario,
  ScenarioOutcome,
  SetupIncompatibleHandler,
} from "./types.js";

type HandlerExecution =
  | { kind: "outcomes"; outcomes: ScenarioOutcome[] }
  | { kind: "setup-incompatible"; handler: SetupIncompatibleHandler };

async function runHandler(
  handler: Handler,
  scenarios: Scenario[],
  progressCallback?: (scenarioId: string, index: number, total: number) => void,
): Promise<HandlerExecution> {
  const outcomes: ScenarioOutcome[] = [];
  if (handler.setup) {
    try {
      await handler.setup();
    } catch (error) {
      const teardownTrace = await teardownAfterSetupFailure(handler);
      if (isSetupIncompatibleError(error)) {
        return {
          kind: "setup-incompatible",
          handler: {
            handlerName: handler.name,
            reason: error.message,
            traces: [
              `SETUP_INCOMPATIBLE: ${error.message}`,
              ...(teardownTrace ? [teardownTrace] : []),
            ],
          },
        };
      }
      return {
        kind: "outcomes",
        outcomes: scenarios.map((scenario) =>
          failedOutcome(scenario, 0, `setup failed: ${errorMessage(error)}`),
        ),
      };
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
  return { kind: "outcomes", outcomes };
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

async function teardownAfterSetupFailure(
  handler: Handler,
): Promise<string | null> {
  if (!handler.teardown) return null;
  try {
    await handler.teardown();
    return null;
  } catch (error) {
    return `ERROR: teardown failed after setup failure: ${errorMessage(error)}`;
  }
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
  const setupIncompatibleHandlers: SetupIncompatibleHandler[] = [];

  for (const handler of handlers) {
    const progress = options.progressCallback
      ? (id: string, idx: number, total: number) =>
          options.progressCallback?.(handler.name, id, idx, total)
      : undefined;
    const execution = await runHandler(handler, scenarios, progress);
    if (execution.kind === "setup-incompatible") {
      setupIncompatibleHandlers.push(execution.handler);
      continue;
    }
    handlerResults.push(
      scoreHandler(handler.name, scenarios, execution.outcomes),
    );
  }

  const perfectResult = handlerResults.find(
    (r) =>
      r.handlerName.includes("Perfect") || r.handlerName.includes("Oracle"),
  );

  return {
    timestamp: new Date().toISOString(),
    totalScenarios: scenarios.length,
    handlers: handlerResults,
    ...(setupIncompatibleHandlers.length > 0
      ? { setupIncompatibleHandlers }
      : {}),
    validationPassed: perfectResult
      ? perfectResult.overallScore >= 99.9
      : false,
  };
}
