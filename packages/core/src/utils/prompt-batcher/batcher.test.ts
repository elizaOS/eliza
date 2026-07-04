/**
 * Exercises PromptBatcher's recurring drain loop, minCycleMs throttling, and
 * once-section cache reuse / stale-while-revalidate against an in-memory runtime
 * and a fake dispatcher (no real model calls).
 */
import { describe, expect, test } from "vitest";
import type {
	BatcherResult,
	ResolvedSection,
} from "../../types/prompt-batcher";
import type { IAgentRuntime } from "../../types/runtime";
import { PromptBatcher } from "./batcher";
import type { DispatchOutcome } from "./shared";

function makeRuntime() {
	const cache = new Map<string, unknown>();
	const tasks: Array<Record<string, unknown>> = [];
	return {
		runtime: {
			agentId: "00000000-0000-0000-0000-000000000001",
			character: { name: "Batcher Test", bio: [], style: [], topics: [] },
			providers: [],
			initPromise: Promise.resolve(),
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			getCache: async <T>(key: string): Promise<T | null> =>
				(cache.get(key) as T | undefined) ?? null,
			setCache: async (key: string, value: unknown): Promise<void> => {
				cache.set(key, value);
			},
			deleteCache: async (key: string): Promise<void> => {
				cache.delete(key);
			},
			getTasksByName: async () => tasks,
			createTask: async (task: Record<string, unknown>) => {
				const id = `00000000-0000-0000-0000-${String(tasks.length + 1).padStart(
					12,
					"0",
				)}`;
				tasks.push({ ...task, id });
				return id;
			},
			getTask: async (id: string) =>
				(tasks.find((task) => task.id === id) as never) ?? null,
			updateTask: async (
				id: string,
				patch: { metadata?: Record<string, unknown> },
			) => {
				const task = tasks.find((item) => item.id === id);
				if (task) {
					task.metadata = {
						...((task.metadata as Record<string, unknown>) ?? {}),
						...(patch.metadata ?? {}),
					};
				}
			},
			deleteTask: async (id: string) => {
				const index = tasks.findIndex((item) => item.id === id);
				if (index >= 0) tasks.splice(index, 1);
			},
		} as unknown as IAgentRuntime,
		tasks,
	};
}

function makeDispatcher() {
	const calls: ResolvedSection[][] = [];
	return {
		calls,
		dispatch: async (sections: ResolvedSection[]): Promise<DispatchOutcome> => {
			calls.push(sections);
			return {
				results: new Map(
					sections.map((section) => [
						section.section.id,
						{
							value: `generated:${section.section.id}:${section.resolvedContext}`,
						},
					]),
				),
				calls: [
					{
						model: "small",
						sectionIds: sections.map((section) => section.section.id),
						estimatedTokens: sections.reduce(
							(sum, section) => sum + section.estimatedTokens,
							0,
						),
						durationMs: 1,
						success: true,
						retried: false,
						fallbackUsed: [],
					},
				],
			};
		},
	};
}

const SETTINGS = {
	batchSize: 4,
	maxDrainIntervalMs: 60_000,
	maxSectionsPerCall: 8,
	packingDensity: 1,
	maxTokensPerCall: 8_000,
	maxParallelCalls: 1,
	modelSeparation: 1,
};

async function ready(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PromptBatcher recurring loop and cache behavior", () => {
	test("recurring autonomy-affinity sections run on repeated drain tasks and keep context stateful", async () => {
		const { runtime, tasks } = makeRuntime();
		const dispatcher = makeDispatcher();
		const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
		await ready();

		const delivered: Array<BatcherResult> = [];
		let loop = 0;
		batcher.think("autonomy", {
			minCycleMs: 25,
			contextBuilder: () => `loop=${++loop}`,
			preamble: "Think autonomously.",
			schema: [{ field: "value", type: "string", required: true }],
			onResult: (fields, meta) => {
				delivered.push({ fields, meta });
			},
		});
		await ready();

		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.metadata).toMatchObject({
			affinityKey: "autonomy",
			updateInterval: 25,
		});

		await batcher.drainAffinityGroup("autonomy");
		await wait(30);
		await batcher.drainAffinityGroup("autonomy");

		expect(dispatcher.calls).toHaveLength(2);
		expect(delivered.map((item) => item.fields.value)).toEqual([
			"generated:autonomy:Agent Name: Batcher Test\n\nloop=1",
			"generated:autonomy:Agent Name: Batcher Test\n\nloop=2",
		]);
		expect(delivered.every((item) => item.meta.cacheHit === false)).toBe(true);
	});

	test("recurring sections are throttled by minCycleMs even when drains fire early", async () => {
		const { runtime } = makeRuntime();
		const dispatcher = makeDispatcher();
		const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
		await ready();

		const delivered: Array<BatcherResult> = [];
		let loop = 0;
		batcher.think("autonomy", {
			minCycleMs: 60_000,
			contextBuilder: () => `loop=${++loop}`,
			preamble: "Think autonomously.",
			schema: [{ field: "value", type: "string", required: true }],
			onResult: (fields, meta) => {
				delivered.push({ fields, meta });
			},
		});
		await ready();

		await batcher.drainAffinityGroup("autonomy");
		await batcher.drainAffinityGroup("autonomy");

		expect(dispatcher.calls).toHaveLength(1);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.fields.value).toBe(
			"generated:autonomy:Agent Name: Batcher Test\n\nloop=1",
		);
	});

	test("once sections reuse fresh cache without another model dispatch", async () => {
		const { runtime } = makeRuntime();
		const dispatcher = makeDispatcher();
		const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
		await ready();

		const first = await batcher.addSection({
			id: "cached-section",
			frequency: "once",
			affinityKey: "init",
			priority: "background",
			preamble: "Cache me.",
			contextBuilder: () => "first context",
			schema: [{ field: "value", type: "string", required: true }],
			cacheTtlMs: 60_000,
		});
		const second = await batcher.addSection({
			id: "cached-section",
			frequency: "once",
			affinityKey: "init",
			priority: "background",
			preamble: "Cache me.",
			contextBuilder: () => "changed context",
			schema: [{ field: "value", type: "string", required: true }],
			cacheTtlMs: 60_000,
		});

		expect(first?.fields.value).toContain("first context");
		expect(second?.fields).toEqual(first?.fields);
		expect(dispatcher.calls).toHaveLength(1);
		expect(batcher.getStats().totalCacheHits).toBe(1);
	});

	test("stale-while-revalidate returns cached fields and refreshes in the background drain", async () => {
		const { runtime } = makeRuntime();
		const dispatcher = makeDispatcher();
		const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
		await ready();

		await batcher.addSection({
			id: "stale-section",
			frequency: "once",
			affinityKey: "init",
			priority: "background",
			preamble: "Cache me.",
			contextBuilder: () => "old context",
			schema: [{ field: "value", type: "string", required: true }],
			cacheTtlMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		const stale = await batcher.addSection({
			id: "stale-section",
			frequency: "once",
			affinityKey: "init",
			priority: "background",
			preamble: "Cache me.",
			contextBuilder: () => "new context",
			schema: [{ field: "value", type: "string", required: true }],
			cacheTtlMs: 60_000,
			staleWhileRevalidate: true,
		});
		await ready();

		expect(stale?.fields.value).toContain("old context");
		expect(dispatcher.calls).toHaveLength(2);
		expect(batcher.getStats().totalCacheHits).toBe(1);
	});
});
