import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { type Character, ModelType } from "../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "dynamic-prompt-json-mode-test",
			bio: "test",
			settings: {},
		} as Character,
		logLevel: "fatal",
	});
}

describe("AgentRuntime.dynamicPromptExecFromState", () => {
	it("requests JSON-object mode for structured model calls", async () => {
		const runtime = makeRuntime();
		let seenParams: unknown;
		const handler = vi.fn(async (_runtime, params: unknown) => {
			seenParams = params;
			return '{"answer":"ok"}';
		});
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: { prompt: "Return an answer." },
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 0 },
		});

		expect(seenParams).toMatchObject({
			responseFormat: { type: "json_object" },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("preserves an explicit caller response format", async () => {
		const runtime = makeRuntime();
		let seenParams: unknown;
		const handler = vi.fn(async (_runtime, params: unknown) => {
			seenParams = params;
			return '{"answer":"ok"}';
		});
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: {
				prompt: "Return an answer.",
				responseFormat: { type: "text" },
			},
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 0 },
		});

		expect(seenParams).toMatchObject({
			responseFormat: { type: "text" },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
