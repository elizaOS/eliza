import { describe, expect, it } from "vitest";
import { computeBackoff, resolveRetryConfig } from "./retry.js";

describe("retry utils", () => {
	it("computes backoff with min and jitter 0", () => {
		const policy = { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
		expect(computeBackoff(policy, 1)).toBe(100);
		expect(computeBackoff(policy, 2)).toBe(200);
		expect(computeBackoff(policy, 3)).toBe(400);
	});

	it("caps at maxMs", () => {
		const policy = { initialMs: 500, maxMs: 600, factor: 2, jitter: 0 };
		expect(computeBackoff(policy, 10)).toBe(600);
	});

	it("resolves retry config with defaults and clamps", () => {
		const cfg = resolveRetryConfig();
		expect(cfg.attempts).toBe(3);
		const overridden = resolveRetryConfig(cfg, {
			attempts: 10,
			minDelayMs: -5,
			jitter: 2,
		});
		expect(overridden.attempts).toBe(10);
		expect(overridden.minDelayMs).toBe(0);
		expect(overridden.jitter).toBe(1);
	});

	it("ensures maxDelay >= minDelay", () => {
		const cfg = resolveRetryConfig(
			{ attempts: 3, minDelayMs: 500, maxDelayMs: 1000, jitter: 0 },
			{ minDelayMs: 2000, maxDelayMs: 1000 },
		);
		expect(cfg.maxDelayMs).toBeGreaterThanOrEqual(cfg.minDelayMs);
	});
});
