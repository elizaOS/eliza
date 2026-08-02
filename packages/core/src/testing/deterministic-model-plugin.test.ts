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

	it("provides deterministic zero embeddings at the requested dimension", async () => {
		const plugin = createDeterministicModelPlugin({ embeddingDimensions: 3 });
		const handler = plugin.models?.[ModelType.TEXT_EMBEDDING];
		if (!handler) throw new Error("missing deterministic embedding handler");
		await expect(handler(runtime, { text: "hello" })).resolves.toEqual([
			0, 0, 0,
		]);
	});
});
