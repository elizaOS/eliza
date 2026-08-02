/**
 * Real test runtime with a fixture-driven model provider injected as a plugin.
 *
 * This keeps runtime construction canonical while giving provider and connector
 * tests a concise way to declare exact model responses and inspect consumption.
 */
import type { Plugin } from "../types/plugin";
import {
	createDeterministicModelPlugin,
	type DeterministicModelDiagnostics,
	type DeterministicModelFixture,
	type DeterministicModelFixtureRegistry,
	type DeterministicModelPlugin,
	type DeterministicModelPluginOptions,
} from "./deterministic-model-plugin";
import {
	createTestRuntime,
	type TestRuntimeOptions,
	type TestRuntimeResult,
} from "./pglite-runtime";

export interface ModelProviderTestRuntime extends TestRuntimeResult {
	modelProvider: DeterministicModelPlugin;
	fixtures: DeterministicModelFixtureRegistry;
	assertFixturesConsumed(): void;
	getFixtureDiagnostics(): DeterministicModelDiagnostics;
}

export interface ModelProviderTestRuntimeOptions
	extends Omit<TestRuntimeOptions, "plugins" | "embeddingDimensions"> {
	plugins?: Plugin[];
	fixtures?: DeterministicModelFixture[];
	embeddingDimensions?: number;
	priority?: number;
	resolve?: DeterministicModelPluginOptions["resolve"];
	stream?: DeterministicModelPluginOptions["stream"];
}

export async function createTestRuntimeWithModelProvider(
	options: ModelProviderTestRuntimeOptions = {},
): Promise<ModelProviderTestRuntime> {
	const embeddingDimensions = options.embeddingDimensions ?? 384;
	const modelProvider = createDeterministicModelPlugin({
		embeddingDimensions,
		fixtures: options.fixtures,
		priority: options.priority,
		resolve: options.resolve,
		stream: options.stream,
	});
	const runtime = await createTestRuntime({
		characterName: options.characterName ?? "ModelProviderTestAgent",
		embeddingDimensions,
		plugins: [modelProvider, ...(options.plugins ?? [])],
		pgliteDir: options.pgliteDir,
		removePgliteDirOnCleanup: options.removePgliteDirOnCleanup,
		flushTrajectoryWrites: options.flushTrajectoryWrites,
	});
	return {
		...runtime,
		modelProvider,
		fixtures: modelProvider.fixtures,
		assertFixturesConsumed: modelProvider.assertFixturesConsumed,
		getFixtureDiagnostics: modelProvider.getFixtureDiagnostics,
	};
}
