/**
 * Tests for the restart/retry backoff math. computeBackoff drives crash-recovery
 * and retry delays; these cover the exponential growth, the attempt clamp, the
 * maxMs cap, and the jitter bounds.
 */
import { describe, expect, it } from "vitest";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "./retry";
import {
	type RetryInfo,
	resolveRetryConfig,
	retryAsync,
	sleep,
} from "./retry.js";

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

describe("sleep", () => {
	it("resolves after waiting at least the requested duration", async () => {
		const started = Date.now();
		await sleep(10);
		expect(Date.now() - started).toBeGreaterThanOrEqual(9);
	});
});

describe("sleepWithAbort zero-duration edge", () => {
	it("resolves immediately for ms <= 0 even when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleepWithAbort(0, controller.signal)).resolves.toBeUndefined();
	});
});

describe("resolveRetryConfig", () => {
	it("returns the built-in defaults when overrides are omitted", () => {
		expect(resolveRetryConfig()).toEqual({
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 30_000,
			jitter: 0,
		});
	});

	it("honors custom defaults when no overrides are given", () => {
		expect(
			resolveRetryConfig({
				attempts: 5,
				minDelayMs: 10,
				maxDelayMs: 100,
				jitter: 0.5,
			}),
		).toEqual({ attempts: 5, minDelayMs: 10, maxDelayMs: 100, jitter: 0.5 });
	});

	it("rounds fractional attempt counts and floors them at one", () => {
		expect(resolveRetryConfig(undefined, { attempts: 2.6 }).attempts).toBe(3);
		expect(resolveRetryConfig(undefined, { attempts: 0 }).attempts).toBe(1);
		expect(resolveRetryConfig(undefined, { attempts: -5 }).attempts).toBe(1);
	});

	it("falls back to default attempts for non-finite overrides", () => {
		const custom = { attempts: 7 };
		expect(resolveRetryConfig(custom, { attempts: Number.NaN }).attempts).toBe(
			7,
		);
		expect(
			resolveRetryConfig(custom, { attempts: Number.POSITIVE_INFINITY })
				.attempts,
		).toBe(7);
	});

	it("clamps negative minDelayMs to zero", () => {
		expect(resolveRetryConfig(undefined, { minDelayMs: -50 }).minDelayMs).toBe(
			0,
		);
	});

	it("raises maxDelayMs to minDelayMs when it would be lower", () => {
		expect(
			resolveRetryConfig(undefined, { minDelayMs: 200, maxDelayMs: 50 })
				.maxDelayMs,
		).toBe(200);
	});

	it("clamps jitter into [0, 1]", () => {
		expect(resolveRetryConfig(undefined, { jitter: 1.5 }).jitter).toBe(1);
		expect(resolveRetryConfig(undefined, { jitter: -0.2 }).jitter).toBe(0);
	});
});

describe("retryAsync numeric-attempts style", () => {
	it("resolves on the first success without retrying", async () => {
		let calls = 0;
		const result = await retryAsync(async () => {
			calls += 1;
			return "ok";
		}, 3);
		expect(result).toBe("ok");
		expect(calls).toBe(1);
	});

	it("retries failed attempts until the function succeeds", async () => {
		let calls = 0;
		const result = await retryAsync(
			async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error(`boom ${calls}`);
				}
				return "recovered";
			},
			5,
			1,
		);
		expect(result).toBe("recovered");
		expect(calls).toBe(3);
	});

	it("throws the last error once attempts are exhausted", async () => {
		let calls = 0;
		const failures = [new Error("first"), new Error("second")];
		await expect(
			retryAsync(
				async () => {
					const err = failures[Math.min(calls, failures.length - 1)];
					calls += 1;
					throw err;
				},
				2,
				1,
			),
		).rejects.toBe(failures[1]);
		expect(calls).toBe(2);
	});

	it("treats an attempt count below one as a single attempt", async () => {
		let calls = 0;
		await expect(
			retryAsync(
				async () => {
					calls += 1;
					throw new Error("always fails");
				},
				0,
				1,
			),
		).rejects.toThrow("always fails");
		expect(calls).toBe(1);
	});

	it("waits exponentially longer between attempts", async () => {
		let calls = 0;
		const started = Date.now();
		await retryAsync(
			async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error("flaky");
				}
				return "done";
			},
			3,
			20,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(60); // 20ms + 40ms
		expect(calls).toBe(3);
	});

	it('reports "Retry failed" when every attempt throws a non-Error value', async () => {
		const throwsUndefined = async (): Promise<never> => {
			throw undefined;
		};
		await expect(retryAsync(throwsUndefined, 2, 1)).rejects.toThrow(
			"Retry failed",
		);
	});
});

describe("retryAsync options style", () => {
	it("does not invoke onRetry when the first attempt succeeds", async () => {
		const retries: RetryInfo[] = [];
		const result = await retryAsync(async () => "ok", {
			attempts: 4,
			minDelayMs: 1,
			onRetry: (info) => retries.push(info),
		});
		expect(result).toBe("ok");
		expect(retries).toEqual([]);
	});

	it("reports ascending attempts, exact delays, errors, and label through onRetry", async () => {
		const errA = new Error("A");
		const errB = new Error("B");
		let calls = 0;
		const retries: RetryInfo[] = [];
		const result = await retryAsync(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw errA;
				}
				if (calls === 2) {
					throw errB;
				}
				return "ok";
			},
			{
				attempts: 4,
				minDelayMs: 10,
				label: "unit-test",
				onRetry: (info) => retries.push(info),
			},
		);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
		expect(retries).toEqual([
			{
				attempt: 1,
				maxAttempts: 4,
				delayMs: 10,
				err: errA,
				label: "unit-test",
			},
			{
				attempt: 2,
				maxAttempts: 4,
				delayMs: 20,
				err: errB,
				label: "unit-test",
			},
		]);
	});

	it("stops immediately without retrying when shouldRetry returns false", async () => {
		let calls = 0;
		const retries: RetryInfo[] = [];
		const failure = new Error("do not retry");
		await expect(
			retryAsync(
				async () => {
					calls += 1;
					throw failure;
				},
				{
					attempts: 5,
					minDelayMs: 1,
					shouldRetry: () => false,
					onRetry: (info) => retries.push(info),
				},
			),
		).rejects.toBe(failure);
		expect(calls).toBe(1);
		expect(retries).toEqual([]);
	});

	it("honors retryAfterMs in place of the exponential schedule", async () => {
		let calls = 0;
		const delays: number[] = [];
		const started = Date.now();
		await retryAsync(
			async () => {
				calls += 1;
				if (calls < 3) {
					const err = new Error("rate limited") as Error & {
						status?: number;
					};
					err.status = 429;
					throw err;
				}
				return "ok";
			},
			{
				attempts: 3,
				minDelayMs: 5,
				retryAfterMs: (err) =>
					typeof err === "object" &&
					err !== null &&
					(err as { status?: number }).status === 429
						? 30
						: undefined,
				onRetry: (info) => delays.push(info.delayMs),
			},
		);
		expect(delays).toEqual([30, 30]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(60);
	});

	it("caps successive delays at maxDelayMs and exhausts all attempts", async () => {
		let calls = 0;
		const delays: number[] = [];
		await expect(
			retryAsync(
				async () => {
					calls += 1;
					throw new Error(`attempt ${calls} failed`);
				},
				{
					attempts: 4,
					minDelayMs: 10,
					maxDelayMs: 15,
					onRetry: (info) => delays.push(info.delayMs),
				},
			),
		).rejects.toThrow("attempt 4 failed");
		expect(calls).toBe(4);
		expect(delays).toEqual([10, 15, 15]);
	});
});
