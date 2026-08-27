/**
 * Exercises the fixture-driven model provider directly, including strict call
 * matching, consumption accounting, explicit fallback resolution, and streaming.
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerateTextParams } from "../types/model";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { createDeterministicModelPlugin } from "./deterministic-model-plugin";

const runtime = {} as IAgentRuntime;

function textHandler(
	plugin: ReturnType<typeof createDeterministicModelPlugin>,
	type: ModelType.TEXT_SMALL | ModelType.ACTION_PLANNER = ModelType.TEXT_SMALL,
) {
	const handler = plugin.models?.[type];
	if (!handler) throw new Error(`missing deterministic handler for ${type}`);
	return handler;
}

describe("createDeterministicModelPlugin", () => {
	it("returns the exact declared response and accounts for its fixture", async () => {
		const plugin = createDeterministicModelPlugin({
			fixtures: [
				{
					name: "expected-answer",
					match: { modelType: ModelType.TEXT_SMALL, input: "right question" },
					response: "right answer",
					times: 1,
				},
			],
		});

		await expect(
			textHandler(plugin)(runtime, {
				messages: [{ role: "user", content: "right question" }],
			} as GenerateTextParams),
		).resolves.toBe("right answer");
		expect(() => plugin.assertFixturesConsumed()).not.toThrow();
		expect(plugin.getFixtureDiagnostics().fixtures[0]?.consumed).toBe(1);
	});

	it("fails unmatched and ambiguous calls instead of inventing a response", async () => {
		const unmatched = createDeterministicModelPlugin();
		await expect(
			textHandler(unmatched)(runtime, {
				prompt: "unknown",
			} as GenerateTextParams),
		).rejects.toThrow("no fixture matched");

		const ambiguous = createDeterministicModelPlugin({
			fixtures: [
				{ name: "first", response: "one", times: "any" },
				{ name: "second", response: "two", times: "any" },
			],
		});
		await expect(
			textHandler(ambiguous)(runtime, {
				prompt: "anything",
			} as GenerateTextParams),
		).rejects.toThrow("multiple fixtures matched");

		expect(() => unmatched.assertFixturesConsumed()).toThrow(
			"deterministic model calls were unexpected",
		);
		expect(() => ambiguous.assertFixturesConsumed()).toThrow(
			"deterministic model calls were unexpected",
		);
	});

	it("distinguishes over-consumption and exposes only sanitized diagnostics", async () => {
		const plugin = createDeterministicModelPlugin({
			fixtures: [{ name: "once", response: "secret answer", times: 1 }],
		});
		const params = { prompt: "secret prompt" } as GenerateTextParams;
		await textHandler(plugin)(runtime, params);
		await expect(textHandler(plugin)(runtime, params)).rejects.toThrow(
			"over-consumed",
		);
		const diagnostic = plugin.getFixtureDiagnostics().calls[0];
		expect(diagnostic).toMatchObject({
			promptLength: 13,
			latestUserTextLength: 13,
			matchingReason: "exactly one eligible fixture matched",
		});
		expect(JSON.stringify(diagnostic)).not.toContain("secret prompt");
		expect(diagnostic?.promptFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(() => plugin.assertFixturesConsumed()).toThrow(
			"all matching fixtures were over-consumed",
		);
	});

	it("fails final validation when a matched fixture returns no response", async () => {
		const plugin = createDeterministicModelPlugin({
			fixtures: [
				{
					name: "empty-resolver",
					resolve: () => undefined,
				},
			],
		});

		await expect(
			textHandler(plugin)(runtime, {
				prompt: "sensitive prompt",
			} as GenerateTextParams),
		).rejects.toThrow('fixture "empty-resolver" did not return a response');
		expect(() => plugin.assertFixturesConsumed()).toThrow(
			"matched fixture did not return a response",
		);
		const serialized = JSON.stringify(plugin.getFixtureDiagnostics());
		expect(serialized).not.toContain("sensitive prompt");
		expect(serialized).toContain("empty-resolver");
	});

	it("resets stateful regular-expression matchers between calls", async () => {
		const plugin = createDeterministicModelPlugin({
			fixtures: [
				{
					name: "global-regexp",
					match: { input: /repeat/g },
					response: "matched",
					times: 2,
				},
			],
		});
		const params = { prompt: "repeat" } as GenerateTextParams;
		await expect(textHandler(plugin)(runtime, params)).resolves.toBe("matched");
		await expect(textHandler(plugin)(runtime, params)).resolves.toBe("matched");
		expect(() => plugin.assertFixturesConsumed()).not.toThrow();
	});

	it("uses an explicit resolver only when no fixture matches", async () => {
		const plugin = createDeterministicModelPlugin({
			fixtures: [
				{
					name: "fixture-wins",
					match: { input: "fixture" },
					response: "fixture response",
				},
			],
			resolve: (call) =>
				call.latestUserText === "fallback" ? "resolved response" : null,
		});

		await expect(
			textHandler(plugin)(runtime, { prompt: "fixture" } as GenerateTextParams),
		).resolves.toBe("fixture response");
		await expect(
			textHandler(plugin)(runtime, {
				prompt: "fallback",
			} as GenerateTextParams),
		).resolves.toBe("resolved response");
		expect(plugin.getFixtureDiagnostics().unexpectedCalls).toEqual([]);
		expect(() => plugin.assertFixturesConsumed()).not.toThrow();
	});

	it("preserves malformed output and streams the same bytes", async () => {
		const onStreamChunk = vi.fn(async () => undefined);
		const plugin = createDeterministicModelPlugin({
			fixtures: [{ name: "malformed", response: "{wrong", times: 1 }],
			stream: { chunkSize: 2, intervalMs: 0 },
		});

		await expect(
			textHandler(plugin)(runtime, {
				prompt: "anything",
				onStreamChunk,
			} as GenerateTextParams),
		).resolves.toBe("{wrong");
		expect(onStreamChunk.mock.calls.map(([chunk]) => chunk)).toEqual([
			"{w",
			"ro",
			"ng",
		]);
	});

	it("supports fixture-scoped errors, latency, and cancellation", async () => {
		const failed = createDeterministicModelPlugin({
			fixtures: [
				{
					name: "rate-limit",
					behavior: {
						latencyMs: 1,
						error: { message: "fixture rate limited", code: "RATE_LIMITED" },
					},
				},
			],
		});
		await expect(
			textHandler(failed)(runtime, { prompt: "fail" } as GenerateTextParams),
		).rejects.toMatchObject({
			message: "fixture rate limited",
			code: "RATE_LIMITED",
		});

		const cancelled = createDeterministicModelPlugin({
			fixtures: [{ name: "cancel", behavior: { waitForAbort: true } }],
		});
		const controller = new AbortController();
		const pending = textHandler(cancelled)(runtime, {
			prompt: "cancel",
			signal: controller.signal,
		} as GenerateTextParams);
		controller.abort(new Error("cancelled by test"));
		await expect(pending).rejects.toThrow("cancelled by test");
	});

	it("registers only text-generation models", () => {
		const plugin = createDeterministicModelPlugin();
		expect(plugin.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
		expect(plugin.models?.[ModelType.TEXT_EMBEDDING_BATCH]).toBeUndefined();
	});
});

function embeddingHandler(
	plugin: ReturnType<typeof createDeterministicModelPlugin>,
	type:
		| typeof ModelType.TEXT_EMBEDDING
		| typeof ModelType.TEXT_EMBEDDING_BATCH = ModelType.TEXT_EMBEDDING,
) {
	const handler = plugin.models?.[type];
	if (!handler) throw new Error(`missing deterministic handler for ${type}`);
	return handler;
}

function bytesOf(vector: number[]): Buffer {
	return Buffer.from(new Float64Array(vector).buffer);
}

describe("createDeterministicModelPlugin embeddings", () => {
	it("registers a fixed-dimension TEXT_EMBEDDING contract when enabled", () => {
		const plugin = createDeterministicModelPlugin({ embeddings: true });
		expect(plugin.models?.[ModelType.TEXT_EMBEDDING]).toEqual(
			expect.any(Function),
		);
		expect(plugin.models?.[ModelType.TEXT_EMBEDDING_BATCH]).toEqual(
			expect.any(Function),
		);
	});

	it("returns identical vectors for identical normalized inputs across reset", async () => {
		const plugin = createDeterministicModelPlugin({ embeddings: true });
		const first = await embeddingHandler(plugin)(runtime, {
			text: "  Solar  Panel  Yield  ",
		});
		plugin.fixtures.resetConsumption();
		const second = await embeddingHandler(plugin)(runtime, {
			text: "solar panel yield",
		});
		const third = await embeddingHandler(plugin)(runtime, "solar panel yield");

		expect(Array.isArray(first)).toBe(true);
		expect(first).toHaveLength(384);
		expect(first.every((value) => Number.isFinite(value))).toBe(true);
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expect(bytesOf(second).equals(bytesOf(first))).toBe(true);
		expect(bytesOf(third).equals(bytesOf(first))).toBe(true);
	});

	it("maps distinct inputs to distinct vectors and honors purpose-built fixtures", async () => {
		const purposeBuilt = new Array(384).fill(0);
		purposeBuilt[0] = 1;
		const plugin = createDeterministicModelPlugin({
			embeddings: true,
			fixtures: [
				{
					name: "arid-solar",
					match: {
						modelType: ModelType.TEXT_EMBEDDING,
						input: "photovoltaic yield under arid conditions",
					},
					response: purposeBuilt,
					times: "any",
				},
			],
		});

		const mapped = await embeddingHandler(plugin)(runtime, {
			text: "photovoltaic yield under arid conditions",
		});
		const hashed = await embeddingHandler(plugin)(runtime, {
			text: "weekly grocery list milk eggs bread",
		});

		expect(mapped).toEqual(purposeBuilt);
		expect(hashed).not.toEqual(purposeBuilt);
		expect(hashed).toHaveLength(384);
	});

	it("answers the null dimension probe with a zero vector of the declared width", async () => {
		const plugin = createDeterministicModelPlugin({
			embeddings: { dimension: 8 },
		});
		await expect(embeddingHandler(plugin)(runtime, null)).resolves.toEqual(
			new Array(8).fill(0),
		);
		expect(plugin.getFixtureDiagnostics().calls).toEqual([]);
	});

	it("fails visibly for unmatched strict fixtures and invalid vectors", async () => {
		const strict = createDeterministicModelPlugin({
			embeddings: { strict: true, dimension: 4 },
		});
		await expect(
			embeddingHandler(strict)(runtime, { text: "unregistered" }),
		).rejects.toThrow("no fixture matched");

		const invalid = createDeterministicModelPlugin({
			embeddings: { dimension: 4 },
			fixtures: [
				{
					name: "wrong-width",
					match: { modelType: ModelType.TEXT_EMBEDDING, input: "bad" },
					response: [1, 2],
				},
			],
		});
		await expect(
			embeddingHandler(invalid)(runtime, { text: "bad" }),
		).rejects.toThrow("invalid embedding vector");

		const nonFinite = createDeterministicModelPlugin({
			embeddings: { dimension: 2 },
			fixtures: [
				{
					name: "nan-vector",
					match: { modelType: ModelType.TEXT_EMBEDDING, input: "nan" },
					response: [Number.NaN, 1],
				},
			],
		});
		await expect(
			embeddingHandler(nonFinite)(runtime, { text: "nan" }),
		).rejects.toThrow("invalid embedding vector");
	});

	it("embeds a batch with the same per-text contract", async () => {
		const plugin = createDeterministicModelPlugin({
			embeddings: { dimension: 8 },
		});
		const [first] = (await embeddingHandler(
			plugin,
			ModelType.TEXT_EMBEDDING_BATCH,
		)(runtime, { texts: ["alpha"] })) as number[][];
		plugin.fixtures.resetConsumption();
		const [again, other] = (await embeddingHandler(
			plugin,
			ModelType.TEXT_EMBEDDING_BATCH,
		)(runtime, { texts: ["alpha", "beta"] })) as number[][];

		expect(again).toEqual(first);
		expect(other).not.toEqual(first);
		expect(again).toHaveLength(8);
		expect(other).toHaveLength(8);
	});
});
