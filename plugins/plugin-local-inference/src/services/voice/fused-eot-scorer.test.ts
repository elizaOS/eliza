/**
 * Exercises fused semantic endpoint scoring through a deterministic FFI seam,
 * including the current Gemma 4 turn-token contract used by shipped bundles.
 */

import { describe, expect, it } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings";
import { FfiEotScorer } from "./fused-eot-scorer";

describe("FfiEotScorer", () => {
	it("scores the Gemma 4 closing token from a Gemma 4 partial-turn prompt", async () => {
		const tokenized: string[] = [];
		let scoredTarget: number | null = null;
		const ffi = {
			eotSupported: () => true,
			tokenize: ({ text }: { text: string }) => {
				tokenized.push(text);
				if (text === "<turn|>") return new Int32Array([107]);
				if (text === "<|turn>") return new Int32Array([106]);
				return new Int32Array([501, 502]);
			},
			eotScore: ({ targetTokenId }: { targetTokenId: number }) => {
				scoredTarget = targetTokenId;
				return { targetProb: 0.84, topToken: 107, topProb: 0.84 };
			},
		} as unknown as ElizaInferenceFfi;
		const scorer = new FfiEotScorer({
			ffi,
			getContext: () => 1n as ElizaInferenceContextHandle,
		});

		const result = await scorer.score(" hello ");

		expect(result.probability).toBeCloseTo(0.84);
		expect(scoredTarget).toBe(107);
		expect(tokenized).toEqual(["<turn|>", "<|turn>", "<|turn>user\nhello"]);
	});
});
