/**
 * Deterministic unit tests for the abortable retry utilities (retry.ts):
 * abort branches of sleepWithAbort, the exponent/cap/jitter math of
 * computeBackoff, the clamping and fallback rules of resolveRetryConfig, and
 * retryAsync under both calling styles — first-attempt success, bounded
 * exhaustion rethrowing the final error, shouldRetry gating, Retry-After
 * override and clamping, maxDelayMs capping, jitter bounds, and onRetry
 * payloads. Real timers with millisecond-scale delays; the module under test
 * runs unmocked end to end.
 */
import { describe, expect, it } from "vitest";
import {
	type BackoffPolicy,
	computeBackoff,
	type RetryInfo,
	resolveRetryConfig,
	retryAsync,
	sleep,
	sleepWithAbort,
} from "./retry.ts";

const BOOM = new Error("boom");
const SECOND = new Error("second failure");
const THIRD = new Error("third failure");

function flakyFailures(
	failures: unknown[],
	payload = "ok",
): { calls: () => number; run: () => Promise<string> } {
	let count = 0;
	return {
		calls: () => count,
		run: async () => {
			const index = count;
			count += 1;
			if (index < failures.length) {
				throw failures[index];
			}
			return payload;
		},
	};
}

describe("computeBackoff", () => {
	const POLICY: BackoffPolicy = {
		initialMs: 100,
		maxMs: 10_000,
		factor: 2,
		jitter: 0,
	};

	it("scales exponentially with the attempt number", () => {
		expect(computeBackoff(POLICY, 1)).toBe(100);
		expect(computeBackoff(POLICY, 2)).toBe(200);
		expect(computeBackoff(POLICY, 4)).toBe(800);
	});

	it("treats attempts below 1 as the first attempt", () => {
		expect(computeBackoff(POLICY, 0)).toBe(100);
		expect(computeBackoff(POLICY, -3)).toBe(100);
	});

	it("caps the delay at maxMs", () => {
		const capped: BackoffPolicy = { ...POLICY, factor: 3, maxMs: 5_000 };
		expect(computeBackoff(capped, 3)).toBe(900);
		expect(computeBackoff(capped, 5)).toBe(5_000);
		expect(computeBackoff(capped, 12)).toBe(5_000);
	});

	it("adds jitter upward only up to base * (1 + jitter)", () => {
		const policy: BackoffPolicy = {
			initialMs: 200,
			maxMs: 1_000_000,
			factor: 1,
			jitter: 0.5,
		};
		for (let i = 0; i < 50; i += 1) {
			const delay = computeBackoff(policy, 1);
			expect(delay).toBeGreaterThanOrEqual(200);
			expect(delay).toBeLessThanOrEqual(300);
			expect(Number.isInteger(delay)).toBe(true);
		}
	});

	it("lets maxMs win even when jitter pushes the raw delay higher", () => {
		const policy: BackoffPolicy = {
			initialMs: 100,
			maxMs: 500,
			factor: 3,
			jitter: 0.5,
		};
		for (let i = 0; i < 50; i += 1) {
			expect(computeBackoff(policy, 6)).toBe(500);
		}
	});
});

describe("resolveRetryConfig", () => {
	it("applies the documented defaults with no arguments", () => {
		expect(resolveRetryConfig()).toEqual({
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 30_000,
			jitter: 0,
		});
	});

	it("rounds fractional attempts and floors them at 1", () => {
		expect(resolveRetryConfig(undefined, { attempts: 2.6 }).attempts).toBe(3);
		expect(resolveRetryConfig(undefined, { attempts: 0 }).attempts).toBe(1);
		expect(resolveRetryConfig(undefined, { attempts: -5 }).attempts).toBe(1);
	});

	it("falls back to defaults for non-finite overrides", () => {
		const resolved = resolveRetryConfig(undefined, {
			attempts: Number.NaN,
			minDelayMs: Number.POSITIVE_INFINITY,
		});
		expect(resolved.attempts).toBe(3);
		expect(resolved.minDelayMs).toBe(300);
	});

	it("ignores non-number override types entirely", () => {
		const overrides = {
			attempts: "7",
			jitter: null,
		} as unknown as { attempts?: number; jitter?: number };
		const resolved = resolveRetryConfig(undefined, overrides);
		expect(resolved.attempts).toBe(3);
		expect(resolved.jitter).toBe(0);
	});

	it("clamps negative delays to zero and keeps an in-range maxDelayMs", () => {
		const resolved = resolveRetryConfig(undefined, {
			attempts: 2,
			minDelayMs: -100,
			maxDelayMs: 40,
		});
		expect(resolved.minDelayMs).toBe(0);
		expect(resolved.maxDelayMs).toBe(40);

		const raised = resolveRetryConfig(undefined, {
			minDelayMs: 500,
			maxDelayMs: 100,
		});
		expect(raised.maxDelayMs).toBe(500);
	});

	it("clamps jitter into [0, 1]", () => {
		expect(resolveRetryConfig(undefined, { jitter: -1 }).jitter).toBe(0);
		expect(resolveRetryConfig(undefined, { jitter: 5 }).jitter).toBe(1);
		expect(resolveRetryConfig(undefined, { jitter: 0.25 }).jitter).toBe(0.25);
	});

	it("lets explicit defaults replace the built-in ones", () => {
		const resolved = resolveRetryConfig(
			{ attempts: 9, minDelayMs: 5, maxDelayMs: 60_000, jitter: 0.1 },
			{},
		);
		expect(resolved).toEqual({
			attempts: 9,
			minDelayMs: 5,
			maxDelayMs: 60_000,
			jitter: 0.1,
		});
	});
});

describe("sleepWithAbort", () => {
	it("resolves immediately for non-positive durations", async () => {
		await expect(sleepWithAbort(0)).resolves.toBeUndefined();
		await expect(sleepWithAbort(-5)).resolves.toBeUndefined();
	});

	it("resolves after the duration when never aborted", async () => {
		await expect(sleepWithAbort(1)).resolves.toBeUndefined();
	});

	it("rejects when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleepWithAbort(5, controller.signal)).rejects.toThrow(
			"aborted",
		);
	});

	it("rejects when aborted mid-sleep", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1);
		await expect(sleepWithAbort(50, controller.signal)).rejects.toThrow(
			"aborted",
		);
	});
});

describe("sleep", () => {
	it("resolves with undefined", async () => {
		await expect(sleep(1)).resolves.toBeUndefined();
	});
});

describe("retryAsync (numeric calling style)", () => {
	it("returns the first success without retrying", async () => {
		const fn = flakyFailures([]);
		await expect(retryAsync(fn.run, 3, 1)).resolves.toBe("ok");
		expect(fn.calls()).toBe(1);
	});

	it("retries until success across exponential delays", async () => {
		const fn = flakyFailures([BOOM, SECOND]);
		await expect(retryAsync(fn.run, 5, 1)).resolves.toBe("ok");
		expect(fn.calls()).toBe(3);
	});

	it("rethrows the final error once attempts are exhausted", async () => {
		const fn = flakyFailures([BOOM, SECOND, THIRD]);
		await expect(retryAsync(fn.run, 3, 1)).rejects.toBe(THIRD);
		expect(fn.calls()).toBe(3);
	});

	it("runs exactly once when attempts is 1", async () => {
		const fn = flakyFailures([BOOM]);
		await expect(retryAsync(fn.run, 1, 1)).rejects.toBe(BOOM);
		expect(fn.calls()).toBe(1);
	});

	it("clamps sub-one attempt counts up to a single attempt", async () => {
		const zero = flakyFailures([BOOM]);
		await expect(retryAsync(zero.run, 0, 1)).rejects.toBe(BOOM);
		expect(zero.calls()).toBe(1);
		const negative = flakyFailures([BOOM]);
		await expect(retryAsync(negative.run, -4, 1)).rejects.toBe(BOOM);
		expect(negative.calls()).toBe(1);
	});
});

describe("retryAsync (options calling style)", () => {
	const BASE_OPTIONS = {
		attempts: 4,
		minDelayMs: 1,
		maxDelayMs: 10_000,
		jitter: 0,
	};

	it("fails fast when shouldRetry returns false", async () => {
		const fn = flakyFailures([BOOM]);
		await expect(
			retryAsync(fn.run, {
				...BASE_OPTIONS,
				shouldRetry: () => false,
			}),
		).rejects.toBe(BOOM);
		expect(fn.calls()).toBe(1);
	});

	it("gates retries per error through shouldRetry(err, attempt)", async () => {
		const transient = new TypeError("transient");
		const seen: Array<[unknown, number]> = [];
		const fn = flakyFailures([transient, THIRD]);
		await expect(
			retryAsync(fn.run, {
				...BASE_OPTIONS,
				shouldRetry: (err, attempt) => {
					seen.push([err, attempt]);
					return err instanceof TypeError;
				},
			}),
		).rejects.toBe(THIRD);
		expect(fn.calls()).toBe(2);
		expect(seen).toEqual([
			[transient, 1],
			[THIRD, 2],
		]);
	});

	it("reports every retry through onRetry with doubled delays", async () => {
		const infos: RetryInfo[] = [];
		const failures = [BOOM, SECOND, THIRD];
		const fn = flakyFailures(failures);
		await expect(
			retryAsync(fn.run, {
				attempts: 4,
				minDelayMs: 10,
				maxDelayMs: 10_000,
				jitter: 0,
				label: "probe",
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(fn.calls()).toBe(4);
		expect(infos.map((info) => info.attempt)).toEqual([1, 2, 3]);
		expect(infos.map((info) => info.delayMs)).toEqual([10, 20, 40]);
		expect(infos.map((info) => info.maxAttempts)).toEqual([4, 4, 4]);
		expect(infos.map((info) => info.err)).toEqual(failures);
		expect(infos.map((info) => info.label)).toEqual([
			"probe",
			"probe",
			"probe",
		]);
	});

	it("prefers a finite Retry-After hint over exponential backoff", async () => {
		const infos: RetryInfo[] = [];
		const fn = flakyFailures([BOOM, SECOND]);
		await expect(
			retryAsync(fn.run, {
				...BASE_OPTIONS,
				minDelayMs: 10,
				retryAfterMs: () => 750,
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(infos.map((info) => info.delayMs)).toEqual([750, 750]);
	});

	it("raises a small Retry-After hint to minDelayMs", async () => {
		const infos: RetryInfo[] = [];
		const fn = flakyFailures([BOOM]);
		await expect(
			retryAsync(fn.run, {
				...BASE_OPTIONS,
				minDelayMs: 10,
				retryAfterMs: () => -5,
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(infos.map((info) => info.delayMs)).toEqual([10]);
	});

	it("ignores non-finite Retry-After hints", async () => {
		const infos: RetryInfo[] = [];
		const fn = flakyFailures([BOOM]);
		await expect(
			retryAsync(fn.run, {
				...BASE_OPTIONS,
				minDelayMs: 10,
				retryAfterMs: () => Number.NaN,
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(infos.map((info) => info.delayMs)).toEqual([10]);
	});

	it("caps backoff at maxDelayMs before and after jitter", async () => {
		const infos: RetryInfo[] = [];
		const fn = flakyFailures([BOOM, SECOND]);
		await expect(
			retryAsync(fn.run, {
				attempts: 3,
				minDelayMs: 10,
				maxDelayMs: 15,
				jitter: 0,
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(infos.map((info) => info.delayMs)).toEqual([10, 15]);
	});

	it("keeps jittered delays within [minDelayMs, maxDelayMs]", async () => {
		const infos: RetryInfo[] = [];
		const fn = flakyFailures([BOOM, SECOND, THIRD]);
		await expect(
			retryAsync(fn.run, {
				attempts: 5,
				minDelayMs: 10,
				maxDelayMs: 30,
				jitter: 1,
				onRetry: (info) => infos.push(info),
			}),
		).resolves.toBe("ok");
		expect(fn.calls()).toBe(4);
		for (const info of infos) {
			expect(info.delayMs).toBeGreaterThanOrEqual(10);
			expect(info.delayMs).toBeLessThanOrEqual(30);
			expect(Number.isInteger(info.delayMs)).toBe(true);
		}
	});

	it("throws the last observed error after exhausting all attempts", async () => {
		const fn = flakyFailures([BOOM, SECOND, THIRD]);
		await expect(
			retryAsync(fn.run, { ...BASE_OPTIONS, attempts: 3 }),
		).rejects.toBe(THIRD);
		expect(fn.calls()).toBe(3);
	});
});
