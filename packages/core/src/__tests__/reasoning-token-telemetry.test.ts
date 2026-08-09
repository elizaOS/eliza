/**
 * Covers reasoning-token surfacing for inference telemetry (#16394):
 * `readReasoningTokensFromResponse` extracts the hidden reasoning-token count
 * from a model response's usage object and provider metadata so a reasoning
 * burst is attributable per model call. Deterministic — no live model.
 */
import { describe, expect, it } from "vitest";
import { readReasoningTokensFromResponse } from "../runtime";

describe("readReasoningTokensFromResponse", () => {
	it("reads reasoningTokens from a native result usage object", () => {
		const response = {
			text: "pong",
			usage: {
				promptTokens: 10,
				completionTokens: 407,
				totalTokens: 417,
				reasoningTokens: 400,
			},
		};
		expect(readReasoningTokensFromResponse(response)).toBe(400);
	});

	it("falls back to providerMetadata.completion_tokens_details.reasoning_tokens", () => {
		// Some OpenAI-compatible paths expose the field only under provider
		// metadata when the adapter did not normalize it into usage.
		const response = {
			text: "pong",
			usage: {
				promptTokens: 10,
				completionTokens: 407,
				totalTokens: 417,
			},
			providerMetadata: {
				completion_tokens_details: { reasoning_tokens: 350 },
			},
		};
		expect(readReasoningTokensFromResponse(response)).toBe(350);
	});

	it("falls back to camelCase completionTokenDetails.reasoningTokens", () => {
		const response = {
			text: "pong",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			providerMetadata: {
				completionTokensDetails: { reasoningTokens: 22 },
			},
		};
		expect(readReasoningTokensFromResponse(response)).toBe(22);
	});

	it("prefers the usage.reasoningTokens value over provider metadata", () => {
		const response = {
			text: "pong",
			usage: {
				promptTokens: 10,
				completionTokens: 407,
				totalTokens: 417,
				reasoningTokens: 400,
			},
			providerMetadata: {
				completion_tokens_details: { reasoning_tokens: 1 },
			},
		};
		expect(readReasoningTokensFromResponse(response)).toBe(400);
	});

	it("returns undefined when no reasoning tokens are reported (missing stays missing)", () => {
		// A confirmed-none call (thinking=off) and an unattributed call must
		// both surface as undefined here; the caller distinguishes them by the
		// presence of a usage object, never by coercing missing to zero.
		const response = {
			text: "pong",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		};
		expect(readReasoningTokensFromResponse(response)).toBeUndefined();
	});

	it("returns undefined for a plain-text string result (no usage object)", () => {
		// Stage-1 plain-text responses collapse to a string and carry no usage;
		// the span meta omits the field entirely rather than inventing zero.
		expect(readReasoningTokensFromResponse("pong")).toBeUndefined();
	});

	it("returns undefined for null/undefined/non-object responses", () => {
		expect(readReasoningTokensFromResponse(null)).toBeUndefined();
		expect(readReasoningTokensFromResponse(undefined)).toBeUndefined();
		expect(readReasoningTokensFromResponse(42)).toBeUndefined();
	});

	it("rejects non-finite and negative values (keeps missing as missing)", () => {
		const withNaN = {
			text: "x",
			usage: { reasoningTokens: Number.NaN },
		};
		const withNegative = {
			text: "x",
			usage: { reasoningTokens: -5 },
		};
		expect(readReasoningTokensFromResponse(withNaN)).toBeUndefined();
		expect(readReasoningTokensFromResponse(withNegative)).toBeUndefined();
	});

	it("accepts a confirmed-zero reasoning-token count (thinking=off proof)", () => {
		// reasoning_effort "none" returns 0 reasoning tokens — that is a real,
		// attributable zero, distinct from an unattributed missing field.
		const response = {
			text: "pong",
			usage: {
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				reasoningTokens: 0,
			},
		};
		expect(readReasoningTokensFromResponse(response)).toBe(0);
	});
});
