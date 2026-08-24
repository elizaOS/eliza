/**
 * Exercises the integration-test runtime factory (`createIntegrationTestRuntime`,
 * `withTestRuntime`, `DEFAULT_TEST_CHARACTER`) against a real AgentRuntime boot
 * over the in-memory database adapter. Inference detection stays skipped so the
 * suite is deterministic and touches no network.
 */

import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Plugin, UUID } from "../types";
import {
	createIntegrationTestRuntime,
	DEFAULT_TEST_CHARACTER,
	type IntegrationTestConfig,
	withTestRuntime,
} from "./integration-runtime";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ConfigOverrides = Partial<
	Omit<IntegrationTestConfig, "databaseAdapter" | "skipInferenceCheck">
>;

function baseConfig(overrides: ConfigOverrides = {}): IntegrationTestConfig {
	return {
		databaseAdapter: new InMemoryDatabaseAdapter(),
		skipInferenceCheck: true,
		...overrides,
	};
}

const markerPlugin: Plugin = {
	name: "integration-runtime-marker-plugin",
	description: "Verifies that configured plugins reach initialization",
	providers: [
		{
			name: "integration-runtime-marker-provider",
			get: async () => ({ text: "marker" }),
		},
	],
};

function countStops(runtime: AgentRuntime): () => number {
	let stops = 0;
	const realStop = runtime.stop.bind(runtime);
	runtime.stop = async () => {
		stops += 1;
		await realStop();
	};
	return () => stops;
}

describe("createIntegrationTestRuntime", () => {
	it("rejects a config without the required database adapter and explains the fix", async () => {
		await expect(
			createIntegrationTestRuntime({} as IntegrationTestConfig),
		).rejects.toThrow(/database adapter/i);
		await expect(
			createIntegrationTestRuntime({} as IntegrationTestConfig),
		).rejects.toThrow("@elizaos/plugin-sql");
		await expect(
			createIntegrationTestRuntime({} as IntegrationTestConfig),
		).rejects.toThrow("createDatabaseAdapter");
	});

	it("boots a fully initialized runtime over a real adapter and issues fresh v4 agent ids", async () => {
		const first = await createIntegrationTestRuntime(baseConfig());
		const second = await createIntegrationTestRuntime(baseConfig());

		try {
			expect(first.runtime).toBeInstanceOf(AgentRuntime);
			expect(await first.runtime.isReady()).toBe(true);
			expect(first.agentId).toMatch(UUID_V4_PATTERN);
			expect(second.agentId).toMatch(UUID_V4_PATTERN);
			expect(second.agentId).not.toBe(first.agentId);
			expect(first.runtime.agentId).toBe(first.agentId);
			expect(first.inferenceProvider).toBeNull();
			expect(first.runtime.character.name).toBe(DEFAULT_TEST_CHARACTER.name);
			expect(first.runtime.character.topics).toEqual(
				DEFAULT_TEST_CHARACTER.topics,
			);
		} finally {
			await first.cleanup();
			await second.cleanup();
		}
	});

	it("applies character overrides while forcing the generated agent id", async () => {
		const callerSuppliedId = "00000000-0000-4000-8000-000000000001" as UUID;

		const result = await createIntegrationTestRuntime(
			baseConfig({
				character: {
					name: "CustomNamedAgent",
					topics: ["override-topic"],
					id: callerSuppliedId,
				},
			}),
		);

		try {
			expect(result.runtime.character.name).toBe("CustomNamedAgent");
			expect(result.runtime.character.topics).toEqual(["override-topic"]);
			expect(result.runtime.character.system).toBe(
				DEFAULT_TEST_CHARACTER.system,
			);
			expect(result.agentId).not.toBe(callerSuppliedId);
			expect(result.runtime.character.id).toBe(result.agentId);
		} finally {
			await result.cleanup();
		}
	});

	it("registers configured plugins during initialization", async () => {
		const result = await createIntegrationTestRuntime(
			baseConfig({ plugins: [markerPlugin] }),
		);

		try {
			const providerNames = result.runtime.providers.map(
				(provider) => provider.name,
			);
			expect(providerNames).toContain("integration-runtime-marker-provider");
		} finally {
			await result.cleanup();
		}
	});

	it("cleanup stops the initialized runtime exactly once", async () => {
		const result = await createIntegrationTestRuntime(baseConfig());
		const stopCount = countStops(result.runtime);

		await result.cleanup();

		expect(stopCount()).toBe(1);
	});

	it("surfaces a stalled initialization through the configured timeout message", async () => {
		const stalledAdapter = new InMemoryDatabaseAdapter();
		stalledAdapter.isReady = async () => false;
		stalledAdapter.initialize = () => new Promise<void>(() => {});

		await expect(
			createIntegrationTestRuntime({
				databaseAdapter: stalledAdapter,
				skipInferenceCheck: true,
				initTimeout: 50,
			}),
		).rejects.toThrow("Runtime initialization timed out after 50ms");
	});
});

describe("withTestRuntime", () => {
	it("hands the initialized runtime and agent id to the body and cleans up on success", async () => {
		let stopCount: () => number = () => 0;

		const observed = await withTestRuntime(
			async (runtime, agentId) => {
				stopCount = countStops(runtime);
				return {
					matchingIds: runtime.agentId === agentId,
					characterName: runtime.character.name,
				};
			},
			baseConfig({ character: { name: "WithTestRuntimeAgent" } }),
		);

		expect(observed.matchingIds).toBe(true);
		expect(observed.characterName).toBe("WithTestRuntimeAgent");
		expect(stopCount()).toBe(1);
	});

	it("cleans up even when the test body throws, then rethrows the original failure", async () => {
		let stopCount: () => number = () => 0;

		await expect(
			withTestRuntime(async (runtime) => {
				stopCount = countStops(runtime);
				throw new Error("test body exploded");
			}, baseConfig()),
		).rejects.toThrow("test body exploded");

		expect(stopCount()).toBe(1);
	});
});
