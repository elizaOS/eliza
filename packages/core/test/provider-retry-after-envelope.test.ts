/**
 * `generateText` throws the AI SDK `RetryError` after its own retries. That
 * envelope has no HTTP headers. The 429 and its Retry-After live on
 * `errors[]` / `lastError` / `cause`. The OpenAI backoff seam calls
 * `providerRetryAfterMs` on that thrown value, so a miss here waits a short
 * local delay instead of the provider's window.
 */

import { describe, expect, it } from "vitest";
import { providerRetryAfterMs } from "../src/utils/model-retry";

function rateLimitedCall(headers: Record<string, string>): Error {
	return Object.assign(new Error("Too many requests"), {
		name: "AI_APICallError",
		statusCode: 429,
		responseHeaders: headers,
	});
}

describe("providerRetryAfterMs through a wrapped provider error", () => {
	it("reads Retry-After from the wrapped 429, not only the envelope", () => {
		const envelope = Object.assign(
			new Error("Failed after 3 attempts. Last error: Too many requests"),
			{
				name: "AI_RetryError",
				reason: "maxRetriesExceeded",
				errors: [rateLimitedCall({ "retry-after": "7" })],
			},
		);
		expect(providerRetryAfterMs(envelope, 1_000_000)).toBe(7_000);
	});

	it("prefers retry-after-ms on the wrapped call", () => {
		const envelope = {
			name: "AI_RetryError",
			errors: [
				rateLimitedCall({
					"retry-after-ms": "250",
					"retry-after": "60",
				}),
			],
		};
		expect(providerRetryAfterMs(envelope, 1_000_000)).toBe(250);
	});

	it("prefers lastError over an earlier errors[] entry", () => {
		const envelope = {
			name: "AI_RetryError",
			lastError: rateLimitedCall({ "retry-after": "2" }),
			errors: [rateLimitedCall({ "retry-after": "9" })],
		};
		expect(providerRetryAfterMs(envelope, 1_000_000)).toBe(2_000);
	});

	it("reads a cause when the outer error has no headers", () => {
		const envelope = {
			name: "Error",
			cause: rateLimitedCall({ "retry-after": "4" }),
		};
		expect(providerRetryAfterMs(envelope, 1_000_000)).toBe(4_000);
	});

	it("keeps a direct responseHeaders read", () => {
		expect(
			providerRetryAfterMs(rateLimitedCall({ "retry-after": "3" }), 1_000_000),
		).toBe(3_000);
	});

	it("returns undefined when no node has a usable hint", () => {
		expect(
			providerRetryAfterMs(
				{
					name: "AI_RetryError",
					errors: [rateLimitedCall({})],
				},
				1_000_000,
			),
		).toBeUndefined();
	});
});
