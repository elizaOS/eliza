import { describe, expect, it, vi } from "vitest";
import { FfiStreamingRunner } from "./ffi-streaming-runner";
import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";
import type { LlmStreamHandle } from "./voice/ffi-bindings";

describe("FfiStreamingRunner prewarm", () => {
	it("treats maxTokens: 0 as prefill-only and never calls next-token generation", async () => {
		const stream = 7n as LlmStreamHandle;
		const binding: LlmStreamingBinding = {
			llmStreamSupported: () => true,
			llmStreamOpen: vi.fn().mockReturnValue(stream),
			llmStreamPrefill: vi.fn(),
			llmStreamNext: vi.fn().mockReturnValue({
				tokens: [1],
				text: "x",
				done: true,
				drafterDrafted: 0,
				drafterAccepted: 0,
			}),
			llmStreamCancel: vi.fn(),
			llmStreamClose: vi.fn(),
		};
		const onTextChunk = vi.fn();
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		const promptTokens = new Int32Array([11, 12, 13]);

		const result = await runner.generateWithUsage({
			promptTokens,
			slotId: 0,
			maxTokens: 0,
			temperature: 0,
			topP: 1,
			topK: 0,
			repeatPenalty: 1,
			draftMin: 0,
			draftMax: 0,
			draftModelPath: null,
			onTextChunk,
		});

		expect(binding.llmStreamOpen).toHaveBeenCalledTimes(1);
		expect(binding.llmStreamPrefill).toHaveBeenCalledWith({
			stream,
			tokens: promptTokens,
		});
		expect(binding.llmStreamNext).not.toHaveBeenCalled();
		expect(onTextChunk).not.toHaveBeenCalled();
		expect(binding.llmStreamClose).toHaveBeenCalledWith(stream);
		expect(result).toEqual({
			text: "",
			slotId: 0,
			firstTokenMs: null,
			drafted: 0,
			accepted: 0,
		});
	});
});
