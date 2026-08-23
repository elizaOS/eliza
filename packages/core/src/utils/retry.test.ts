/**
 * Coverage for retry.
 */
import { describe, expect, it } from "vitest";
import { computeBackoff, resolveRetryConfig, sleepWithAbort } from "./retry.js";

describe("retry", () => {
	it("computes backoff", () => {
		const p = { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
		expect(computeBackoff(p, 1)).toBe(100);
		expect(computeBackoff(p, 2)).toBe(200);
		expect(computeBackoff(p, 3)).toBe(400);
		expect(computeBackoff(p, 10)).toBe(1000);
	});
	it("resolves config defaults", () => {
		const c = resolveRetryConfig();
		expect(c.attempts).toBe(3);
		expect(c.minDelayMs).toBe(300);
	});
	it("overrides config", () => {
		const c = resolveRetryConfig(
			{ attempts: 3, minDelayMs: 300, maxDelayMs: 30000, jitter: 0 },
			{ attempts: 5 },
		);
		expect(c.attempts).toBe(5);
	});
	it("sleeps immediately for 0", async () => {
		await expect(sleepWithAbort(0)).resolves.toBeUndefined();
	});
	it("aborts sleep", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(sleepWithAbort(100, ac.signal)).rejects.toThrow();
	});
});
