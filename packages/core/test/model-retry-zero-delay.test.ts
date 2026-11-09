/**
 * A provider 429 with a zero retry delay must retry at once, not throw.
 * `providerRateLimitRetryAt` returns the retry deadline; the planner loop
 * throws when it returns undefined, so a zero delay must return `now`.
 */
import { describe, expect, it } from "vitest";
import { providerRateLimitRetryAt } from "../src/utils/model-retry";

describe("providerRateLimitRetryAt with a zero retry delay", () => {
	it("returns now when retryAfterMs is zero", () => {
		const now = 1_000_000;
		const retryAt = providerRateLimitRetryAt(
			{ statusCode: 429, retryAfterMs: 0 },
			now,
		);
		expect(retryAt).toBe(now);
	});

	it("returns now when the Retry-After header is zero", () => {
		const now = 1_000_000;
		const retryAt = providerRateLimitRetryAt(
			{ statusCode: 429, responseHeaders: { "retry-after": "0" } },
			now,
		);
		expect(retryAt).toBe(now);
	});

	it("still returns a future deadline for a positive delay", () => {
		const now = 1_000_000;
		const retryAt = providerRateLimitRetryAt(
			{ statusCode: 429, retryAfterMs: 7_000 },
			now,
		);
		expect(retryAt).toBe(now + 7_000);
	});
});
