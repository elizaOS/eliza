/**
 * Verifies semantic endpoint prompt selection against the paired special-token
 * contracts used by current Gemma 4 and older Gemma bundles.
 */

import { describe, expect, it } from "vitest";
import { formatEotPrompt, resolveEotTokenContract } from "./eot-token-contract";

describe("resolveEotTokenContract", () => {
	it("selects the current Gemma 4 paired markers", () => {
		const contract = resolveEotTokenContract((text) => {
			if (text === "<|turn>") return [106];
			if (text === "<turn|>") return [107];
			return [1, 2];
		});
		expect(contract).toMatchObject({
			family: "gemma4",
			openingTokenId: 106,
			closingTokenId: 107,
		});
		expect(formatEotPrompt(" hello ", contract)).toBe("<|turn>user\nhello");
	});

	it("keeps older Gemma bundles compatible", () => {
		const contract = resolveEotTokenContract((text) => {
			if (text === "<start_of_turn>") return [206];
			if (text === "<end_of_turn>") return [207];
			return [1, 2];
		});
		expect(contract).toMatchObject({
			family: "gemma-legacy",
			openingTokenId: 206,
			closingTokenId: 207,
		});
		expect(formatEotPrompt("hello", contract)).toBe(
			"<start_of_turn>user\nhello",
		);
	});

	it("rejects a half-matched marker pair", () => {
		expect(() =>
			resolveEotTokenContract((text) => (text === "<turn|>" ? [107] : [1, 2])),
		).toThrow(/paired turn-token/);
	});
});
