/**
 * Verifies PromptDispatcher threads each section's retry budget into structured
 * model calls and tags call-plan priority (background vs interactive, #11914),
 * against a mock runtime whose dynamicPromptExecFromState is stubbed.
 */
import { describe, expect, test } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { ResolvedSection } from "../../types/prompt-batcher";
import { PromptDispatcher } from "./dispatcher";

function makeResolvedSection(id: string, maxRetries: number): ResolvedSection {
	return {
		section: {
			id,
			frequency: "recurring",
			preamble: `Preamble for ${id}`,
			schema: [{ field: "value", required: true }],
			maxRetries,
		},
		resolvedContext: `context for ${id}`,
		contextCharCount: 20,
		schemaFieldCount: 1,
		estimatedTokens: 10,
		priority: "background",
		preferredModel: "small",
		isolated: false,
		affinityKey: "default",
	};
}

describe("PromptDispatcher", () => {
	test("passes section retry budget into structured model calls", async () => {
		const seen: unknown[] = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args);
				return {
					first__value: "one",
					second__value: "two",
				};
			},
		});
		const dispatcher = new PromptDispatcher({
			packingDensity: 1,
			maxTokensPerCall: 8_000,
			maxParallelCalls: 1,
			modelSeparation: 1,
			maxSectionsPerCall: 8,
		});

		await dispatcher.dispatch(
			[makeResolvedSection("first", 0), makeResolvedSection("second", 2)],
			runtime,
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			options: {
				modelSize: "small",
				maxRetries: 2,
			},
		});
	});

	test("marks non-immediate call plans background so single-lane local backends deprioritize them (#11914)", async () => {
		const seen: Array<{ params?: { priority?: string } }> = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args as { params?: { priority?: string } });
				return { first__value: "one" };
			},
		});
		const dispatcher = new PromptDispatcher({
			packingDensity: 1,
			maxTokensPerCall: 8_000,
			maxParallelCalls: 1,
			modelSeparation: 1,
			maxSectionsPerCall: 8,
		});

		await dispatcher.dispatch([makeResolvedSection("first", 0)], runtime);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.params?.priority).toBe("background");
	});

	test("keeps immediate call plans interactive (#11914)", async () => {
		const seen: Array<{ params?: { priority?: string } }> = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args as { params?: { priority?: string } });
				return { first__value: "one" };
			},
		});
		const dispatcher = new PromptDispatcher({
			packingDensity: 1,
			maxTokensPerCall: 8_000,
			maxParallelCalls: 1,
			modelSeparation: 1,
			maxSectionsPerCall: 8,
		});

		const immediate: ResolvedSection = {
			...makeResolvedSection("first", 0),
			priority: "immediate",
		};
		await dispatcher.dispatch([immediate], runtime);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.params?.priority).toBe("interactive");
	});
});
