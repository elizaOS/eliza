/** Surrogate safety for fallback-reply clampForScan. */
import { describe, expect, test } from "vitest";
import { isInsufficientCreditsMessage } from "./fallback-reply.ts";

describe("fallback-reply clampForScan surrogate safety", () => {
	test("emoji at 9999 boundary backs off cleanly without lone surrogate at 10000 cap", () => {
		const fox = "🦊";
		const input = `${"a".repeat(9999)}${fox} insufficient_credits`;
		expect(() => isInsufficientCreditsMessage(input)).not.toThrow();
	});

	test("fitting emoji ending at 10000 cap with error phrase detected", () => {
		const fox = "🦊";
		const input = `insufficient_credits ${"a".repeat(9900)}${fox}`;
		expect(isInsufficientCreditsMessage(input)).toBe(true);
	});

	test("lone high surrogate in error message does not throw", () => {
		const badInput = `bad \ud800 in error ${"x".repeat(12000)}`;
		expect(() => isInsufficientCreditsMessage(badInput)).not.toThrow();
	});

	test("sweep offsets around 10000 cap all evaluate safely", () => {
		const fox = "🦊";
		for (let n = 9990; n <= 10005; n++) {
			const msg = `${"a".repeat(n)}${fox} out of credits`;
			expect(() => isInsufficientCreditsMessage(msg)).not.toThrow();
		}
	});
});
