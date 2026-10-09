// Measures ConfigBench plugin configuration and secret-handling benchmark behavior.
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
      // error-policy:J4 setup incompatibility is an explicit non-publishable state.
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
      throw error;
    }
  }

  try {
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      progressCallback?.(scenario.id, i + 1, scenarios.length);
      outcomes.push(await handler.run(scenario));
    }
  } finally {
    if (handler.teardown) {
      await handler.teardown();
    }
  }
  return { kind: "outcomes", outcomes };
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
    // error-policy:J6 teardown after a known setup failure is best-effort.
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
