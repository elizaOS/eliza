import { createSyntheticTestRuntime } from "../../src/synthetic-runtime.ts";
import type { SyntheticScenarioWorld } from "../../synthetic-world/src/scenario-world.ts";
import { createMockEffectCapture } from "./effect-observation.ts";
/** Executes a full scenario inside one owned SQL runtime and API world. */
export async function runSyntheticScenario<T>(
  options: Parameters<typeof createSyntheticTestRuntime<T>>[0] & {
    scenario:
      | import("../schema/index.ts").ScenarioDefinition
      | ((
          world: SyntheticScenarioWorld,
        ) => import("../schema/index.ts").ScenarioDefinition);
    executor: Omit<import("./executor.ts").ExecutorOptions, "worldId">;
  },
) {
  const fixture = await createSyntheticTestRuntime(options);
  const execute = async () => {
    const before = fixture.world.snapshot();
    const { runScenario } = await import("./executor.ts");
    const report = await runScenario(
      typeof options.scenario === "function"
        ? options.scenario(fixture.world)
        : options.scenario,
      fixture.runtime,
      {
        ...options.executor,
        captureActionEffects:
          options.executor.captureActionEffects ??
          createMockEffectCapture(fixture.world),
        worldId: fixture.world.namespace,
        abortSignal: options.executor.abortSignal
          ? AbortSignal.any([
              options.executor.abortSignal,
              fixture.world.signal,
            ])
          : fixture.world.signal,
      },
    );
    fixture.world.assertComplete();
    return {
      report,
      worldEvidence: {
        namespace: fixture.world.namespace,
        authority: fixture.world.authority,
        before,
        after: fixture.world.snapshot(),
        requests: fixture.world.requestLedger(),
      },
    };
  };
  let result: Awaited<ReturnType<typeof execute>>;
  try {
    result = await execute();
  } catch (error) {
    // error-policy:J6 Preserve execution failure if teardown also fails.
    try {
      await fixture.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic scenario execution and cleanup failed",
      );
    }
    throw error;
  }
  await fixture.cleanup();
  return result;
}
