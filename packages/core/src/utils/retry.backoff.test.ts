/**
 * Tests for the restart/retry backoff math. computeBackoff drives crash-recovery
 * and retry delays; these cover the exponential growth, the attempt clamp, the
 * maxMs cap, and the jitter bounds.
 */
import { describe, expect, it } from "vitest";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "./retry";

const noJitter: BackoffPolicy = {
	initialMs: 100,
	maxMs: 10_000,
	factor: 2,
	jitter: 0,
};

describe("computeBackoff", () => {
	it("grows exponentially by the factor (jitter 0)", () => {
		expect(computeBackoff(noJitter, 1)).toBe(100); // 100 * 2^0
		expect(computeBackoff(noJitter, 2)).toBe(200); // 100 * 2^1
		expect(computeBackoff(noJitter, 3)).toBe(400);
		expect(computeBackoff(noJitter, 4)).toBe(800);
	});

	it("treats attempt <= 1 as the first attempt (no negative exponent)", () => {
		expect(computeBackoff(noJitter, 0)).toBe(100);
		expect(computeBackoff(noJitter, -3)).toBe(100);
	});

	it("caps the delay at maxMs", () => {
		expect(computeBackoff(noJitter, 30)).toBe(10_000); // 100*2^29 >> max
	});

	it("with jitter, stays within [base, base*(1+jitter)] across many samples", () => {
		const j: BackoffPolicy = {
			initialMs: 100,
			maxMs: 1_000_000,
			factor: 2,
			jitter: 0.5,
		};
		for (let i = 0; i < 300; i += 1) {
			const v = computeBackoff(j, 3); // base = 400
			expect(v).toBeGreaterThanOrEqual(400);
			expect(v).toBeLessThanOrEqual(600); // 400 * 1.5
		}
	});
});

describe("sleepWithAbort abort signal listener cleanup", () => {
	it("rejects immediately if signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleepWithAbort(100, controller.signal)).rejects.toThrow(
			"aborted",
		);
	});

	it("cleans up listener when sleep times out normally", async () => {
		const controller = new AbortController();
		await sleepWithAbort(10, controller.signal);
		// Signal should not trigger reject after resolution
		controller.abort();
	});

	it("cleans up listener and rejects when aborted during sleep", async () => {
		const controller = new AbortController();
		const promise = sleepWithAbort(1000, controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
	});
});
