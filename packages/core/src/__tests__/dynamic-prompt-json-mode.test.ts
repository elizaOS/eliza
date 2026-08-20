/**
 * Exercises AgentRuntime.dynamicPromptExecFromState: structured model calls
 * request JSON-object response format, structured callbacks drain before a
 * retry, a validation failure feeds corrective [REPAIR] context into the
 * reroll, and exhausted retries return null while an explicit caller response
 * format is preserved. Runs against a bare
 * AgentRuntime (no DB adapter, logModelCall stubbed) with a registered vi.fn()
 * model handler — fully deterministic, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { type Character, ModelType } from "../types";

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "dynamic-prompt-json-mode-test",
			bio: "test",
			settings: {},
		} as Character,
		logLevel: "fatal",
	});
	// This minimal runtime has no DB adapter, so logModelCall's
	// `this.adapter.createLogs` would throw and route every useModel through the
	// model_error path — never reaching validation. Stub it (pure logging) so
	// useModel returns the handler output cleanly.
	(runtime as unknown as { logModelCall: () => void }).logModelCall = () => {};
	return runtime;
}

describe("AgentRuntime.dynamicPromptExecFromState", () => {
	it("drains an older structured callback before starting a retry", async () => {
		const runtime = makeRuntime();
		let attempt = 0;
		const handler = vi.fn(
			async (
				_runtime,
				params: { onStreamChunk?: (chunk: string) => Promise<void> | void },
			) => {
				attempt += 1;
				if (attempt === 1) {
					await params.onStreamChunk?.("text: old\nother: x\n");
					return '{"wrong":"retry"}';
				}
				await params.onStreamChunk?.("text: new.\n");
				return '{"text":"new."}';
			},
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			handler,
			"eliza-local-inference",
			100,
		);
		let releaseOld: (() => void) | undefined;
		const oldGate = new Promise<void>((resolve) => {
			releaseOld = resolve;
		});
		let markOldEntered: (() => void) | undefined;
		const oldEntered = new Promise<void>((resolve) => {
			markOldEntered = resolve;
		});
		const delivered: Array<{ chunk: string; revision: number | undefined }> =
			[];

		const resultPromise = runtime.dynamicPromptExecFromState({
			params: { prompt: "Return text." },
			schema: [
				{
					field: "text",
					description: "Reply",
					required: true,
					streamField: true,
				},
				{ field: "other", description: "Non-streamed metadata" },
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				maxRetries: 1,
				contextCheckLevel: 0,
				onStreamChunk: async (chunk, _messageId, _accumulated, revision) => {
					delivered.push({ chunk, revision });
					if (delivered.length === 1) {
						markOldEntered?.();
						await oldGate;
					}
				},
			},
		});

		await oldEntered;
		await Promise.resolve();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(delivered.map(({ chunk }) => chunk)).toEqual(["old"]);

		releaseOld?.();
		expect(await resultPromise).toEqual({ text: "new." });
		expect(handler).toHaveBeenCalledTimes(2);
		expect(delivered.map(({ chunk }) => chunk)).toEqual(["old", "new."]);
		expect(delivered[0]?.revision).not.toBe(delivered[1]?.revision);
	});

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

	it("feeds a corrective repair context into the reroll after a validation failure", async () => {
		const runtime = makeRuntime();
		const prompts: string[] = [];
		const handler = vi.fn(async (_runtime, params: { prompt: string }) => {
			// Always invalid (missing the required `answer`) so every reroll's
			// prompt is captured; we assert the reroll became corrective.
			prompts.push(params.prompt);
			return '{"wrong":"nope-value"}';
		});
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: { prompt: "Return an answer." },
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 1 },
		});

		// maxRetries:1 → 2 attempts. The first carries no repair context; the
		// reroll feeds back the concrete failure + the (echoed) prior output, so
		// it is corrective rather than a blind re-roll of the same prompt.
		expect(handler).toHaveBeenCalledTimes(2);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toContain("[REPAIR]");
		expect(prompts[1]).toContain("[REPAIR]");
		expect(prompts[1]).toContain("Your previous (invalid) output was:");
		expect(prompts[1]).toContain("nope-value");
	});

	it("still returns null after exhausting retries (behavior preserved)", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => '{"wrong":"always-invalid"}');
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		const result = await runtime.dynamicPromptExecFromState({
			params: { prompt: "Return an answer." },
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 1 },
		});

		expect(handler).toHaveBeenCalledTimes(2);
		expect(result).toBeNull();
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
