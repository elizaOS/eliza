/** Composes a real SQL-backed runtime with one leased world and exact model fixtures. */
import { ElizaError } from "@elizaos/core";
import type {
  SyntheticScenarioWorld,
  SyntheticScenarioWorldOptions,
} from "../synthetic-world/src/scenario-world.ts";
import { startSyntheticScenarioWorld } from "../synthetic-world/src/scenario-world.ts";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
  type ModelProviderTestRuntimeOptions,
} from "./model-provider-runtime.ts";

export interface SyntheticTestRuntime extends ModelProviderTestRuntime {
  world: SyntheticScenarioWorld;
}

export async function createSyntheticTestRuntime<T>(options: {
  world: SyntheticScenarioWorldOptions<T>;
  runtime?:
    | ModelProviderTestRuntimeOptions
    | ((
        world: SyntheticScenarioWorld,
      ) =>
        | ModelProviderTestRuntimeOptions
        | Promise<ModelProviderTestRuntimeOptions>);
}): Promise<SyntheticTestRuntime> {
  const world = await startSyntheticScenarioWorld(options.world);
  let fixture: ModelProviderTestRuntime;
  try {
    const runtimeOptions =
      typeof options.runtime === "function"
        ? await options.runtime(world)
        : options.runtime;
    const settings = runtimeOptions?.settings;
    for (const [name, expected] of Object.entries(world.settings)) {
      const actual = settings?.[name] ?? settings?.values?.[name];
      if (actual !== undefined && actual !== expected) {
        throw new ElizaError(
          `Runtime setting ${name} conflicts with its synthetic world`,
          { code: "SYNTHETIC_RUNTIME_SETTING_CONFLICT" },
        );
      }
    }
    fixture = await createTestRuntimeWithModelProvider({
      ...runtimeOptions,
      settings: { ...settings, ...world.settings },
    });
  } catch (error) {
    // error-policy:J6 Initialization failure still closes the leased API world.
    try {
      await world.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic runtime initialization and rollback failed",
      );
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...fixture,
    world,
    cleanup: () =>
      (closing ??= (async () => {
        const failures: unknown[] = [];
        for (const finish of [
          fixture.cleanup,
          () => world.assertComplete(),
          world.close,
        ]) {
          try {
            await finish();
          } catch (error) {
            // error-policy:J6 Retain runtime, model consumption and world proof failures after cleanup.
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            "Synthetic runtime cleanup failed",
          );
      })()),
  };
}
