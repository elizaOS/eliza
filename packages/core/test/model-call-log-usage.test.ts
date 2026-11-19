/**
 * The model-call log row is the only per-call record a release phone keeps. It
 * held the messages but no token counts and no tools, so neither the cache hit
 * rate nor the real request size could be read from a device.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

async function logged(result: unknown, params: Record<string, unknown>) {
	const runtime = createSQLiteTestRuntime({
		character: { name: "UsageAgent", bio: "test", settings: {} } as Character,
		logLevel: "fatal",
	});
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		async () => result as never,
		"usage-provider",
	);
	await runtime.useModel(ModelType.ACTION_PLANNER, params as never);
	await runtime.stop();
	const row = (await runtime.getLogs({ type: "useModel:ACTION_PLANNER" }))[0];
	if (!row) throw new Error("model call was not logged");
	return row.body as Record<string, unknown>;
}

const request = {
	messages: [{ role: "user", content: "text mom" }],
	tools: [
		{ name: "REPLY", description: "Reply", parameters: { type: "object" } },
		{
			type: "function",
			function: { name: "SEND", description: "x".repeat(400) },
		},
	],
	maxTokens: 2048,
};

it("records provider usage, tool sizes and the output cap", async () => {
	const body = await logged(
		{
			text: "",
			toolCalls: [],
			usage: {
				promptTokens: 9000,
				completionTokens: 40,
				totalTokens: 9040,
				cacheReadInputTokens: 8192,
			},
		},
		request,
	);
	expect(body.usage).toEqual({
		promptTokens: 9000,
		completionTokens: 40,
		cacheReadInputTokens: 8192,
	});
	expect(body.maxTokens).toBe(2048);
	// The size a provider is sent: compact JSON, not an indented rendering. The
	// digest shows when a definition's bytes changed between two calls.
	expect(body.tools).toEqual(
		request.tools.map((tool) => ({
			name: "name" in tool ? tool.name : tool.function.name,
			chars: JSON.stringify(tool).length,
			hash: expect.stringMatching(/^[0-9a-f]{12}$/),
		})),
	);
	const [first, second] = body.tools as { hash: string }[];
	expect(first.hash).not.toBe(second.hash);
});

it("keeps a missing cache report missing, logs no usage for a result without one, and records that no tools were sent", async () => {
	const uncounted = await logged(
		{
			text: "",
			toolCalls: [],
			usage: { promptTokens: 10, completionTokens: 1 },
		},
		{ ...request, omitMaxTokens: true },
	);
	expect(uncounted.usage).toEqual({ promptTokens: 10, completionTokens: 1 });
	expect(uncounted).not.toHaveProperty("maxTokens");
	const plain = await logged("ok", { prompt: "hello" });
	expect(plain.usage).toBeUndefined();
	// A request that sent no tools says so: a reader can tell it from a row
	// written before tools were recorded.
	expect(plain.tools).toEqual([]);
});
