/**
 * Unit tests for the public prompt-batcher entrypoint in
 * packages/core/src/utils/prompt-batcher.ts.
 *
 * The file is a re-export barrel; these tests import through that path (the
 * same specifier production uses) and drive the real classes: re-export
 * wiring against the implementation modules, the BatcherDisposedError
 * contract, pickFields selection, dispatcher packing / de-namespacing of a
 * pooled model response, and one composed askNow round trip through the real
 * PromptDispatcher with only the model boundary mocked. Sibling suites under
 * ./prompt-batcher/ cover the layers in isolation.
 */
import { describe, expect, test } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import * as typesModule from "../types/prompt-batcher";
import type { IAgentRuntime } from "../types/runtime";
import {
	BatcherDisposedError,
	PromptBatcher,
	PromptDispatcher,
	pickFields,
} from "./prompt-batcher";
import * as batcherImplementation from "./prompt-batcher/batcher";
import * as dispatcherImplementation from "./prompt-batcher/dispatcher";
import * as sharedImplementation from "./prompt-batcher/shared";

const DISPATCHER_SETTINGS = {
	packingDensity: 1,
	maxTokensPerCall: 8_000,
	maxParallelCalls: 1,
	modelSeparation: 1,
	maxSectionsPerCall: 8,
};

const BATCHER_SETTINGS = {
	batchSize: 4,
	maxDrainIntervalMs: 60_000,
	maxSectionsPerCall: 8,
	packingDensity: 1,
	maxTokensPerCall: 8_000,
	maxParallelCalls: 1,
	modelSeparation: 1,
};

type SeenModelArgs = {
	params?: { prompt?: string; temperature?: number; maxTokens?: number };
	schema?: Array<{ field: string }>;
	options?: { modelSize?: string };
};

function makeResolvedSection(
	id: string,
	overrides: Partial<typesModule.ResolvedSection> = {},
): typesModule.ResolvedSection {
	return {
		section: {
			id,
			frequency: "recurring",
			preamble: `Preamble for ${id}`,
			schema: [{ field: "answer", description: "The answer", required: true }],
		},
		resolvedContext: `context for ${id}`,
		contextCharCount: 20,
		schemaFieldCount: 1,
		estimatedTokens: 10,
		priority: "background",
		preferredModel: "small",
		isolated: false,
		affinityKey: "default",
		...overrides,
	};
}

/**
 * Hand-rolled runtime in the shape batcher.test.ts uses (single audited
 * downcast): PromptBatcher touches initPromise, logger, cache, task, and
 * provider surfaces that createMockRuntime does not default.
 */
function makeBatcherRuntime(modelResponse: Record<string, unknown>) {
	const seen: SeenModelArgs[] = [];
	const tasks: Array<Record<string, unknown>> = [];
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		character: { name: "Barrel Test", bio: [], style: [], topics: [] },
		providers: [],
		initPromise: Promise.resolve(),
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		reportError: () => undefined,
		getCache: async <T>(_key: string): Promise<T | null> => null,
		setCache: async (_key: string, _value: unknown): Promise<void> => {},
		deleteCache: async (_key: string): Promise<void> => {},
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
		updateTask: async (): Promise<void> => {},
		deleteTask: async (): Promise<void> => {},
		dynamicPromptExecFromState: async (args: unknown) => {
			seen.push(args as SeenModelArgs);
			return modelResponse;
		},
	} as unknown as IAgentRuntime;
	return { runtime, seen };
}

async function ready(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("prompt-batcher entrypoint", () => {
	test("re-exports the same runtime symbols as the implementation modules", () => {
		expect(PromptBatcher).toBe(batcherImplementation.PromptBatcher);
		expect(PromptDispatcher).toBe(dispatcherImplementation.PromptDispatcher);
		expect(pickFields).toBe(sharedImplementation.pickFields);
		expect(BatcherDisposedError).toBe(typesModule.BatcherDisposedError);
	});

	test("exposes class constructors (not namespace objects) through the barrel", () => {
		expect(typeof PromptBatcher).toBe("function");
		expect(typeof PromptDispatcher).toBe("function");
		expect(typeof pickFields).toBe("function");
		expect(typeof BatcherDisposedError).toBe("function");
	});
});

describe("BatcherDisposedError (via public entrypoint)", () => {
	test("is an Error named BatcherDisposedError with its disposal message", () => {
		const error = new BatcherDisposedError();
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("BatcherDisposedError");
		expect(error.message).toBe("PromptBatcher has been disposed");
	});
});

describe("pickFields (via public entrypoint)", () => {
	test("picks exactly the schema fields present in the input, preserving values", () => {
		const fields = pickFields({ keep: 1, drop: 2 }, [
			{ field: "keep" },
			{ field: "missing" },
		]);
		expect(fields).toEqual({ keep: 1 });
	});

	test("returns an empty object for null input or an empty schema", () => {
		expect(pickFields(null, [{ field: "any" }])).toEqual({});
		expect(pickFields(undefined, [{ field: "any" }])).toEqual({});
		expect(pickFields({ any: "value" }, [])).toEqual({});
	});
});

describe("PromptDispatcher (via public entrypoint)", () => {
	test("packs same-affinity sections into one call and de-namespaces the pooled response per section", async () => {
		const seen: SeenModelArgs[] = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args as SeenModelArgs);
				return { alpha__answer: "a1", beta__answer: "b2" };
			},
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		const outcome = await dispatcher.dispatch(
			[makeResolvedSection("alpha"), makeResolvedSection("beta")],
			runtime,
		);

		expect(seen).toHaveLength(1);
		expect(outcome.results.get("alpha")).toEqual({ answer: "a1" });
		expect(outcome.results.get("beta")).toEqual({ answer: "b2" });
		expect(outcome.calls).toHaveLength(1);
		expect(outcome.calls[0]?.success).toBe(true);
		expect(outcome.calls[0]?.model).toBe("small");
		expect([...(outcome.calls[0]?.sectionIds ?? [])].sort()).toEqual([
			"alpha",
			"beta",
		]);
	});

	test("gives isolated sections their own calls even when they could pack", async () => {
		const seen: SeenModelArgs[] = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args as SeenModelArgs);
				if (seen.length === 1) return { alpha__answer: "a1" };
				return { beta__answer: "b2" };
			},
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		const outcome = await dispatcher.dispatch(
			[
				makeResolvedSection("alpha", { isolated: true }),
				makeResolvedSection("beta"),
			],
			runtime,
		);

		expect(seen).toHaveLength(2);
		expect(outcome.results.get("alpha")).toEqual({ answer: "a1" });
		expect(outcome.results.get("beta")).toEqual({ answer: "b2" });
		for (const call of outcome.calls) {
			expect(call.sectionIds).toHaveLength(1);
		}
	});

	test("dispatches immediate-priority plans before background plans under serial parallelism", async () => {
		const order: string[] = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				const prompt = (args as SeenModelArgs).params?.prompt ?? "";
				order.push(prompt.includes("SECTION 1: urgent") ? "urgent" : "bg");
				return {};
			},
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		await dispatcher.dispatch(
			[
				makeResolvedSection("bg", { priority: "background" }),
				makeResolvedSection("urgent", { priority: "immediate" }),
			],
			runtime,
		);

		expect(order).toEqual(["urgent", "bg"]);
	});

	test("separates small- and large-model preferences into distinct calls under full separation", async () => {
		const models: Array<string | undefined> = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				models.push((args as SeenModelArgs).options?.modelSize);
				return {};
			},
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		const outcome = await dispatcher.dispatch(
			[
				makeResolvedSection("smallpref", { preferredModel: "small" }),
				makeResolvedSection("largepref", { preferredModel: "large" }),
			],
			runtime,
		);

		expect(models.sort()).toEqual(["large", "small"]);
		expect(outcome.calls).toHaveLength(2);
	});

	test("merges packed exec options by taking the minimum temperature and maximum token budget", async () => {
		const seen: SeenModelArgs[] = [];
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async (args: unknown) => {
				seen.push(args as SeenModelArgs);
				return { alpha__answer: "a1", beta__answer: "b2" };
			},
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		await dispatcher.dispatch(
			[
				makeResolvedSection("alpha", {
					execOptions: { temperature: 0.9, maxTokens: 100 },
				}),
				makeResolvedSection("beta", {
					execOptions: { temperature: 0.2, maxTokens: 500 },
				}),
			],
			runtime,
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.params?.temperature).toBe(0.2);
		expect(seen[0]?.params?.maxTokens).toBe(500);
	});

	test("records a failed call with fallbackUsed naming every section when the model returns nothing", async () => {
		const runtime = createMockRuntime({
			dynamicPromptExecFromState: async () => null,
		});
		const dispatcher = new PromptDispatcher(DISPATCHER_SETTINGS);

		const outcome = await dispatcher.dispatch(
			[makeResolvedSection("alpha"), makeResolvedSection("beta")],
			runtime,
		);

		expect(outcome.calls).toHaveLength(1);
		expect(outcome.calls[0]?.success).toBe(false);
		expect([...(outcome.calls[0]?.fallbackUsed ?? [])].sort()).toEqual([
			"alpha",
			"beta",
		]);
		expect(outcome.results.size).toBe(0);
	});
});

describe("PromptBatcher (via public entrypoint)", () => {
	test("askNow resolves with de-namespaced model fields end-to-end through the real dispatcher", async () => {
		const { runtime, seen } = makeBatcherRuntime({ mysection__answer: "42" });
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);
		await ready();

		const fields = await batcher.askNow("mysection", {
			preamble: "Answer the question.",
			schema: [{ field: "answer", description: "The answer", required: true }],
			fallback: { answer: "unknown" },
		});

		expect(fields).toEqual({ answer: "42" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.options?.modelSize).toBe("small");
		expect(seen[0]?.schema?.map((row) => row.field)).toEqual([
			"mysection__answer",
		]);
	});

	test("duplicate section registration resolves null while the first registration still delivers", async () => {
		const { runtime } = makeBatcherRuntime({ dup__v: "first-wins" });
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);
		await ready();

		const first: Promise<typesModule.BatcherResult | null> = batcher.addSection(
			{
				id: "dup",
				frequency: "once",
				priority: "immediate",
				preamble: "First registration.",
				schema: [{ field: "v", type: "string", required: true }],
			},
		);
		const second = await batcher.addSection({
			id: "dup",
			frequency: "once",
			priority: "immediate",
			preamble: "Duplicate registration.",
			schema: [{ field: "v", type: "string", required: true }],
		});
		expect(second).toBeNull();

		await batcher.drainAffinityGroup("default");
		const result = await first;
		expect(result?.fields).toEqual({ v: "first-wins" });
		expect(result?.meta.sectionId).toBe("dup");
		expect(result?.meta.fallbackUsed).toBe(false);
	});

	test("dispose rejects a pending section promise with BatcherDisposedError", async () => {
		const { runtime } = makeBatcherRuntime({});
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);
		await ready();

		const pending = batcher.addSection({
			id: "slow",
			frequency: "recurring",
			preamble: "Waits for a drain that never comes.",
			schema: [{ field: "v", type: "string", required: true }],
		});
		batcher.dispose();

		const reason: unknown = await pending.catch((error: unknown) => error);
		expect(reason).toBeInstanceOf(BatcherDisposedError);
		expect((reason as Error).message).toBe("PromptBatcher has been disposed");
	});

	test("addSection after dispose rejects with BatcherDisposedError", async () => {
		const { runtime } = makeBatcherRuntime({});
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);
		batcher.dispose();

		await expect(
			batcher.addSection({
				id: "late",
				frequency: "recurring",
				preamble: "Too late.",
				schema: [{ field: "v", type: "string", required: true }],
			}),
		).rejects.toBeInstanceOf(BatcherDisposedError);
	});

	test("removeSection of a missing id is a no-op and affinity counts start empty", () => {
		const { runtime } = makeBatcherRuntime({});
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);

		expect(batcher.getSectionCountForAffinity("default")).toBe(0);
		expect(() => batcher.removeSection("ghost")).not.toThrow();
		expect(batcher.getSectionCountForAffinity("default")).toBe(0);
	});

	test("getIdealTickInterval honors recurring minCycleMs but stays capped by maxDrainIntervalMs", () => {
		const { runtime } = makeBatcherRuntime({});
		const batcher = new PromptBatcher(
			runtime,
			new PromptDispatcher(DISPATCHER_SETTINGS),
			BATCHER_SETTINGS,
		);
		void batcher
			.addSection({
				id: "cycle-small",
				frequency: "recurring",
				minCycleMs: 1_000,
				preamble: "Small cycle.",
				schema: [{ field: "v", type: "string", required: true }],
			})
			.catch(() => {});
		void batcher
			.addSection({
				id: "cycle-huge",
				frequency: "recurring",
				minCycleMs: 500_000,
				preamble: "Huge cycle.",
				schema: [{ field: "v", type: "string", required: true }],
			})
			.catch(() => {});

		expect(batcher.getIdealTickInterval("default")).toBe(1_000);
		expect(batcher.getIdealTickInterval("missing-affinity")).toBe(60_000);
	});
});
