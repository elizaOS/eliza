/**
 * Failure-reply classifiers: 402 credit exhaustion must be recognized as its
 * own kind (actionable "top up", never generic retry copy — #13962), and must
 * not bleed into the 401/403 auth or 429 rate-limit buckets.
 */

import { describe, expect, it } from "vitest";
import {
	isAuthError,
	isCreditsExhaustedError,
	isRateLimitError,
} from "./fallback-reply";

function httpError(status: number, message: string): Error {
	const err = new Error(message) as Error & { status: number };
	err.status = status;
	return err;
}

describe("isCreditsExhaustedError", () => {
	it("matches a structured 402", () => {
		expect(isCreditsExhaustedError(httpError(402, "Payment Required"))).toBe(
			true,
		);
	});

	it("matches the cloud insufficient_credits error string", () => {
		expect(
			isCreditsExhaustedError(
				new Error('402 {"error":"insufficient_credits"}'),
			),
		).toBe(true);
	});

	it("does not match 401/403/429 or generic failures", () => {
		expect(isCreditsExhaustedError(httpError(401, "Unauthorized"))).toBe(false);
		expect(isCreditsExhaustedError(httpError(429, "Too Many Requests"))).toBe(
			false,
		);
		expect(isCreditsExhaustedError(new Error("fetch failed"))).toBe(false);
	});
});

describe("bucket disjointness on a 402", () => {
	it("a 402 is credits-exhausted, not auth or rate-limit", () => {
		const err = httpError(402, "insufficient credits");
		expect(isCreditsExhaustedError(err)).toBe(true);
		expect(isAuthError(err)).toBe(false);
		expect(isRateLimitError(err)).toBe(false);
	});
});
