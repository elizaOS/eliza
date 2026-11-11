import { describe, expect, it } from "vitest";
import { providerRateLimitRetryAt } from "../src/utils/model-retry.ts";

describe("providerRateLimitRetryAt", () => {
	it("returns now for a 429 with Retry-After 0 instead of no deadline", () => {
		expect(
			providerRateLimitRetryAt(
				{ status: 429, responseHeaders: { "retry-after": "0" } },
				1000,
			),
		).toBe(1000);
	});

	it("returns now for a 429 with a Retry-After date already past", () => {
		const resetAt = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
		const now = resetAt + 5000;
		expect(
			providerRateLimitRetryAt(
				{
					status: 429,
					responseHeaders: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
				},
				now,
			),
		).toBe(now);
	});

	it("still returns now plus the delay for a positive Retry-After", () => {
		expect(
			providerRateLimitRetryAt(
				{ status: 429, responseHeaders: { "retry-after": "2" } },
				1000,
			),
		).toBe(3000);
	});

	it("returns undefined for a 429 with no retry hint", () => {
		expect(providerRateLimitRetryAt({ status: 429 }, 1000)).toBeUndefined();
	});

	it("returns undefined for a non-429 error", () => {
		expect(
			providerRateLimitRetryAt(
				{ status: 500, responseHeaders: { "retry-after": "0" } },
				1000,
			),
		).toBeUndefined();
	});
});
