/**
 * Real test runtime with a fixture-driven model provider injected as a plugin.
 *
 * This keeps runtime construction canonical while giving provider and connector
 * tests a concise way to declare exact model responses and inspect consumption.
 */
import type { Plugin } from "@elizaos/core";
import {
  createDeterministicModelPlugin,
  type DeterministicModelDiagnostics,
  type DeterministicModelFixture,
  type DeterministicModelFixtureRegistry,
  type DeterministicModelPlugin,
  type DeterministicModelPluginOptions,
} from "./deterministic-model-plugin.ts";
import {
  createTestRuntime,
  type TestRuntimeOptions,
  type TestRuntimeResult,
} from "./pglite-runtime.ts";

export interface ModelProviderTestRuntime extends TestRuntimeResult {
  modelProvider: DeterministicModelPlugin;
  fixtures: DeterministicModelFixtureRegistry;
  assertFixturesConsumed(): void;
  getFixtureDiagnostics(): DeterministicModelDiagnostics;
}

export interface ModelProviderTestRuntimeOptions
  extends Omit<TestRuntimeOptions, "plugins"> {
  plugins?: Plugin[];
  fixtures?: DeterministicModelFixture[];
  modelTypes?: DeterministicModelPluginOptions["modelTypes"];
  priority?: number;
  resolve?: DeterministicModelPluginOptions["resolve"];
  stream?: DeterministicModelPluginOptions["stream"];
}

export async function createTestRuntimeWithModelProvider(
  options: ModelProviderTestRuntimeOptions = {},
): Promise<ModelProviderTestRuntime> {
  const embeddingDimensions = options.embeddingDimensions ?? 384;
  const modelProvider = createDeterministicModelPlugin({
    fixtures: options.fixtures,
    modelTypes: options.modelTypes,
    priority: options.priority,
    resolve: options.resolve,
    stream: options.stream,
  });
  const runtime = await createTestRuntime({
    characterName: options.characterName ?? "ModelProviderTestAgent",
    settings: options.settings,
    embeddingDimensions,
    plugins: [modelProvider, ...(options.plugins ?? [])],
    pgliteDir: options.pgliteDir,
    removePgliteDirOnCleanup: options.removePgliteDirOnCleanup,
    flushTrajectoryWrites: options.flushTrajectoryWrites,
  });
  return {
    ...runtime,
    cleanup: async () => {
      const failures: unknown[] = [];
      for (const finish of [
        runtime.cleanup,
        () => modelProvider.assertFixturesConsumed(),
      ]) {
        try {
          await finish();
        } catch (error) {
          // error-policy:J6 Preserve teardown and fixture failures after all owned work drains.
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Model runtime cleanup failed");
    },
    modelProvider,
    fixtures: modelProvider.fixtures,
    assertFixturesConsumed: modelProvider.assertFixturesConsumed,
    getFixtureDiagnostics: modelProvider.getFixtureDiagnostics,
  };
}
