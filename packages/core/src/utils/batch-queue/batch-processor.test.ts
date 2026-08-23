/**
 * Behavioral coverage for BatchProcessor: per-item retries, semaphore
 * parallelism, per-item `_batchMaxAttempts`, `maxAttemptsCap`, `shouldRetry`,
 * non-Error wrapping, and onExhausted observation (including callback throw).
 * Drives the real module; backoff is zeroed except where delay is the claim.
 */

import { describe, expect, test } from "vitest";
import { BatchProcessor } from "./batch-processor";

const instantRetry = {
	minDelayMs: 0,
	maxDelayMs: 0,
	jitter: 0,
} as const;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("BatchProcessor", () => {
	test("processBatch returns an empty outcome list for an empty input", async () => {
		const processor = new BatchProcessor<number>({
			maxParallel: 2,
			retryPolicy: instantRetry,
			process: async () => {
				throw new Error("must not run");
			},
		});

		await expect(processor.processBatch([])).resolves.toEqual([]);
	});

	test("a first-try success reports retryCount 0 and preserves item identity", async () => {
		const item = { id: "ok" };
		const seen: Array<{ id: string }> = [];
		const processor = new BatchProcessor<typeof item>({
			maxParallel: 1,
			retryPolicy: instantRetry,
			process: async (current) => {
				seen.push(current);
			},
		});

		const [outcome] = await processor.processBatch([item]);

		expect(seen).toEqual([item]);
		expect(outcome).toEqual({ item, success: true, retryCount: 0 });
		expect(outcome?.item).toBe(item);
	});

	test("retries a failed item and succeeds with the retry count of later attempts", async () => {
		const attempts: number[] = [];
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 3,
			retryPolicy: instantRetry,
			process: async (item) => {
				attempts.push(item.length);
				if (attempts.length < 3) {
					throw new Error(`fail-${attempts.length}`);
				}
			},
		});

		const [outcome] = await processor.processBatch(["x"]);

		expect(attempts).toHaveLength(3);
		expect(outcome).toEqual({ item: "x", success: true, retryCount: 2 });
	});

	test("exhausts after maxRetriesAfterFailure + 1 attempts and reports the last error", async () => {
		const processor = new BatchProcessor<number>({
			maxParallel: 1,
			maxRetriesAfterFailure: 2,
			retryPolicy: instantRetry,
			process: async () => {
				throw new Error("still broken");
			},
		});

		const [outcome] = await processor.processBatch([7]);

		expect(outcome?.success).toBe(false);
		expect(outcome?.retryCount).toBe(2);
		expect(outcome?.item).toBe(7);
		expect(outcome?.error).toBeInstanceOf(Error);
		expect(outcome?.error?.message).toBe("still broken");
	});

	test("default maxRetriesAfterFailure is 3 (four total attempts)", async () => {
		let calls = 0;
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			retryPolicy: instantRetry,
			process: async () => {
				calls += 1;
				throw new Error("nope");
			},
		});

		const [outcome] = await processor.processBatch(["a"]);

		expect(calls).toBe(4);
		expect(outcome?.success).toBe(false);
		expect(outcome?.retryCount).toBe(3);
	});

	test("retryPolicy.attempts overrides maxRetriesAfterFailure when resolving total tries", async () => {
		let calls = 0;
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 9,
			retryPolicy: { ...instantRetry, attempts: 1 },
			process: async () => {
				calls += 1;
				throw new Error("once");
			},
		});

		const [outcome] = await processor.processBatch(["only"]);

		expect(calls).toBe(1);
		expect(outcome?.success).toBe(false);
		expect(outcome?.retryCount).toBe(0);
	});

	test("shouldRetry false on the first failure exhausts without further attempts", async () => {
		let calls = 0;
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 5,
			retryPolicy: instantRetry,
			shouldRetry: () => false,
			process: async () => {
				calls += 1;
				throw new Error("fatal");
			},
		});

		const [outcome] = await processor.processBatch(["no-retry"]);

		expect(calls).toBe(1);
		expect(outcome?.success).toBe(false);
		expect(outcome?.retryCount).toBe(0);
		expect(outcome?.error?.message).toBe("fatal");
	});

	test("shouldRetry can stop after a later attempt while keeping the prior retryCount", async () => {
		const attempts: number[] = [];
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 5,
			retryPolicy: instantRetry,
			shouldRetry: (_item, _err, attempt) => attempt < 2,
			process: async () => {
				attempts.push(attempts.length + 1);
				throw new Error(`n-${attempts.length}`);
			},
		});

		const [outcome] = await processor.processBatch(["stop-after-one-retry"]);

		expect(attempts).toEqual([1, 2]);
		expect(outcome?.success).toBe(false);
		expect(outcome?.retryCount).toBe(1);
	});

	test("wraps a non-Error throw in Error(String(err))", async () => {
		const processor = new BatchProcessor<number>({
			maxParallel: 1,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				throw "plain-string";
			},
		});

		const [outcome] = await processor.processBatch([1]);

		expect(outcome?.success).toBe(false);
		expect(outcome?.error).toBeInstanceOf(Error);
		expect(outcome?.error?.message).toBe("plain-string");
	});

	test("wraps a non-string non-Error throw via String(err)", async () => {
		const processor = new BatchProcessor<number>({
			maxParallel: 1,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				throw 42;
			},
		});

		const [outcome] = await processor.processBatch([1]);

		expect(outcome?.error?.message).toBe("42");
	});

	test("onExhausted receives the item and last error, then the failed outcome is returned", async () => {
		const item = { name: "job" };
		const seen: Array<{ item: typeof item; error: Error }> = [];
		const processor = new BatchProcessor<typeof item>({
			maxParallel: 1,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				throw new Error("exhausted");
			},
			onExhausted: (current, error) => {
				seen.push({ item: current, error });
			},
		});

		const [outcome] = await processor.processBatch([item]);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.item).toBe(item);
		expect(seen[0]?.error.message).toBe("exhausted");
		expect(outcome?.success).toBe(false);
		expect(outcome?.error?.message).toBe("exhausted");
	});

	test("an onExhausted throw does not reject processBatch or replace the item error", async () => {
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				throw new Error("item-failed");
			},
			onExhausted: async () => {
				throw new Error("observer-failed");
			},
		});

		const outcomes = await processor.processBatch(["a", "b"]);

		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((o) => o.success === false)).toBe(true);
		expect(outcomes.map((o) => o.error?.message)).toEqual([
			"item-failed",
			"item-failed",
		]);
	});

	test("maxParallel sanitizes 0 to 1 so items run serially", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const hold = deferred();
		let started = 0;
		const processor = new BatchProcessor<number>({
			maxParallel: 0,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				started += 1;
				if (started === 1) {
					await hold.promise;
				}
				inFlight -= 1;
			},
		});

		const running = processor.processBatch([1, 2]);
		await viWaitUntil(() => started === 1);
		expect(maxInFlight).toBe(1);
		hold.resolve();
		await running;
		expect(maxInFlight).toBe(1);
	});

	test("maxParallel 2 never runs a third item concurrently", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const hold = deferred();
		let started = 0;
		const processor = new BatchProcessor<number>({
			maxParallel: 2,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				started += 1;
				if (started <= 2) {
					await hold.promise;
				}
				inFlight -= 1;
			},
		});

		const running = processor.processBatch([1, 2, 3]);
		await viWaitUntil(() => started === 2);
		expect(maxInFlight).toBe(2);
		hold.resolve();
		const outcomes = await running;
		expect(maxInFlight).toBe(2);
		expect(outcomes.every((o) => o.success)).toBe(true);
	});

	test("releases the semaphore between retries so a sibling item can run", async () => {
		const events: string[] = [];
		const attempts = new Map<string, number>();
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 1,
			retryPolicy: { minDelayMs: 25, maxDelayMs: 25, jitter: 0 },
			process: async (item) => {
				const n = (attempts.get(item) ?? 0) + 1;
				attempts.set(item, n);
				events.push(`${item}:${n}`);
				if (item === "slow" && n === 1) {
					throw new Error("first fail");
				}
			},
		});

		const outcomes = await processor.processBatch(["slow", "fast"]);

		expect(events[0]).toBe("slow:1");
		expect(events).toContain("fast:1");
		expect(events).toContain("slow:2");
		expect(events.indexOf("fast:1")).toBeLessThan(events.indexOf("slow:2"));
		expect(outcomes.find((o) => o.item === "slow")?.success).toBe(true);
		expect(outcomes.find((o) => o.item === "fast")?.success).toBe(true);
	});

	test("sleeps the computed backoff when delayMs is positive", async () => {
		const started: number[] = [];
		const processor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 1,
			retryPolicy: { minDelayMs: 40, maxDelayMs: 40, jitter: 0 },
			process: async () => {
				started.push(Date.now());
				if (started.length === 1) {
					throw new Error("retry-me");
				}
			},
		});

		const [outcome] = await processor.processBatch(["timed"]);
		expect(outcome?.success).toBe(true);
		expect(outcome?.retryCount).toBe(1);
		expect(started).toHaveLength(2);
		expect((started[1] ?? 0) - (started[0] ?? 0)).toBeGreaterThanOrEqual(35);
	});

	test("per-item _batchMaxAttempts overrides queue-level total attempts", async () => {
		const calls = new Map<number, number>();
		const processor = new BatchProcessor<{
			id: number;
			_batchMaxAttempts: number;
		}>({
			maxParallel: 2,
			maxRetriesAfterFailure: 5,
			retryPolicy: instantRetry,
			process: async (item) => {
				calls.set(item.id, (calls.get(item.id) ?? 0) + 1);
				throw new Error("fail");
			},
		});

		const outcomes = await processor.processBatch([
			{ id: 1, _batchMaxAttempts: 1 },
			{ id: 2, _batchMaxAttempts: 3 },
		]);

		expect(calls.get(1)).toBe(1);
		expect(calls.get(2)).toBe(3);
		expect(outcomes.find((o) => o.item.id === 1)?.retryCount).toBe(0);
		expect(outcomes.find((o) => o.item.id === 2)?.retryCount).toBe(2);
	});

	test("ignores non-numeric, non-finite, and sub-1 _batchMaxAttempts", async () => {
		const calls: string[] = [];
		const processor = new BatchProcessor<unknown>({
			maxParallel: 4,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async (item) => {
				calls.push(label(item));
				throw new Error("fail");
			},
		});

		await processor.processBatch([
			"primitive",
			{ tag: "missing" },
			{ tag: "string", _batchMaxAttempts: "2" },
			{ tag: "nan", _batchMaxAttempts: Number.NaN },
			{ tag: "inf", _batchMaxAttempts: Number.POSITIVE_INFINITY },
			{ tag: "zero", _batchMaxAttempts: 0 },
			{ tag: "neg", _batchMaxAttempts: -3 },
		]);

		// fallback is maxRetriesAfterFailure 0 → 1 total attempt each
		expect(calls).toHaveLength(7);
	});

	test("maxAttemptsCap clamps per-item and queue-level attempts, and never goes below 1", async () => {
		const calls: string[] = [];
		const processor = new BatchProcessor<{
			name: string;
			_batchMaxAttempts?: number;
		}>({
			maxParallel: 2,
			maxRetriesAfterFailure: 8,
			maxAttemptsCap: 1,
			retryPolicy: instantRetry,
			process: async (item) => {
				calls.push(item.name);
				throw new Error("fail");
			},
		});

		const outcomes = await processor.processBatch([
			{ name: "uncapped-item" },
			{ name: "large-item", _batchMaxAttempts: 50 },
		]);

		expect(calls.sort()).toEqual(["large-item", "uncapped-item"]);
		expect(outcomes.every((o) => o.retryCount === 0)).toBe(true);
		expect(outcomes.every((o) => o.success === false)).toBe(true);

		let zeroCalls = 0;
		const zeroProcessor = new BatchProcessor<string>({
			maxParallel: 1,
			maxRetriesAfterFailure: 3,
			maxAttemptsCap: 0,
			retryPolicy: instantRetry,
			process: async () => {
				zeroCalls += 1;
				throw new Error("fail");
			},
		});
		await zeroProcessor.processBatch(["z"]);
		expect(zeroCalls).toBe(1);
	});

	test("processBatch keeps input order and isolates per-item success from failure", async () => {
		const processor = new BatchProcessor<number>({
			maxParallel: 3,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async (item) => {
				if (item % 2 === 0) {
					throw new Error(`even-${item}`);
				}
			},
		});

		const outcomes = await processor.processBatch([1, 2, 3, 4]);

		expect(outcomes.map((o) => o.item)).toEqual([1, 2, 3, 4]);
		expect(outcomes.map((o) => o.success)).toEqual([true, false, true, false]);
		expect(outcomes[1]?.error?.message).toBe("even-2");
	});

	test("a negative maxParallel still runs (sanitized to at least 1)", async () => {
		const seen: number[] = [];
		const processor = new BatchProcessor<number>({
			maxParallel: -4,
			maxRetriesAfterFailure: 0,
			retryPolicy: instantRetry,
			process: async (item) => {
				seen.push(item);
			},
		});

		const outcomes = await processor.processBatch([9]);
		expect(seen).toEqual([9]);
		expect(outcomes[0]?.success).toBe(true);
	});
});

function label(item: unknown): string {
	if (typeof item === "string") return item;
	if (item && typeof item === "object" && "tag" in item) {
		return String((item as { tag: unknown }).tag);
	}
	return String(item);
}

async function viWaitUntil(predicate: () => boolean, timeoutMs = 1000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out waiting for processor start");
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}
