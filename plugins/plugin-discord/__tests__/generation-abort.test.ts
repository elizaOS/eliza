/**
 * Discriminating tests for `runGenerationWithAbortableTimeout` — the fix for
 * the Discord "I timed out while generating that reply" bug where a timeout
 * fired WITHOUT aborting the underlying generation, leaving an orphaned run
 * that kept burning tokens and could race a late response into the same room
 * (the alternating timeout / instant-reply pattern).
 *
 * Diagnosis receipts (verified against origin/develop):
 *   - messages.ts dispatch did `Promise.race([generationPromise,
 *     timeoutPromise])` with NO AbortController and NO abortSignal passed to
 *     `messageService.handleMessage` (messages.ts ~1315-1382 pre-fix).
 *   - The core chain `MessageProcessingOptions.abortSignal` →
 *     `StreamingContext.abortSignal` → `runtime.useModel(params.signal)` is
 *     ALREADY wired and tested (packages/core message-handler-abort.test.ts,
 *     message.ts:9175/9290/9403). The only missing link was the connector
 *     never creating/passing a signal.
 *
 * Each test states whether it reproduces the pre-fix bug (RED against the old
 * race-without-abort behavior).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isUserRequestedTurnAbort,
	runGenerationWithAbortableTimeout,
} from "../messages.ts";

/** Deferred promise helper — lets a test control exactly when generation settles. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("runGenerationWithAbortableTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * (c) Generation completing just UNDER the timeout → normal result, no
	 * timeout, no error. Baseline: the happy path is unaffected.
	 */
	it("returns a clean result when generation completes before the timeout", async () => {
		const generate = vi.fn(async (_signal: AbortSignal) => {
			// resolves immediately on the microtask queue
		});

		const resultPromise = runGenerationWithAbortableTimeout(generate, 1000);
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.timedOut).toBe(false);
		expect(result.settled).toBe(true);
		expect(result.error).toBeUndefined();
		// The signal handed to generate must not be aborted on the happy path.
		const passedSignal = generate.mock.calls[0]?.[0];
		expect(passedSignal?.aborted).toBe(false);
	});

	/**
	 * (f) + (b) Hung generation that never resolves → timeout reply AND the
	 * underlying call is ABORTED (assert the signal fired). This is the core
	 * fix. RED against pre-fix behavior: the old code never aborted, so the
	 * signal would remain un-aborted (in fact no signal existed at all).
	 */
	it("aborts a hung generation when the timeout fires (REPRODUCES BUG)", async () => {
		let capturedSignal: AbortSignal | undefined;
		const generate = vi.fn((signal: AbortSignal) => {
			capturedSignal = signal;
			// Never resolves — simulates a hung model call.
			return new Promise<void>(() => {});
		});

		const resultPromise = runGenerationWithAbortableTimeout(generate, 2000);
		// `generate` runs on a microtask edge (Promise.resolve().then). Flush it
		// so the signal is captured before we assert on it.
		await vi.advanceTimersByTimeAsync(0);
		expect(capturedSignal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(2000);
		const result = await resultPromise;

		expect(result.timedOut).toBe(true);
		expect(result.settled).toBe(false);
		// The whole point: the abort actually fired.
		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(true);
	});

	/**
	 * (a) Slow generation resolving AFTER the timeout → helper reports a single
	 * timeout; the late resolution does NOT flip the result and does NOT throw
	 * an unhandled rejection. RED against pre-fix: old code left the orphan
	 * live and only `.catch(()=>{})`'d it — no abort, so it kept running.
	 */
	it("reports one timeout and swallows a late resolution (no double-dispatch)", async () => {
		const gate = deferred<void>();
		let capturedSignal: AbortSignal | undefined;
		const generate = vi.fn((signal: AbortSignal) => {
			capturedSignal = signal;
			return gate.promise;
		});

		const resultPromise = runGenerationWithAbortableTimeout(generate, 1500);
		await vi.advanceTimersByTimeAsync(1500);
		const result = await resultPromise;

		expect(result.timedOut).toBe(true);
		expect(capturedSignal?.aborted).toBe(true);

		// Orphan resolves LATE — must not throw, must not change the result.
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		// Re-assert the already-returned result is stable (value type, frozen).
		expect(result.timedOut).toBe(true);
	});

	/**
	 * Late REJECTION of the orphaned run must be swallowed (no unhandled
	 * rejection crashing the process). RED against a naive fix that aborts but
	 * forgets to catch the abandoned promise.
	 */
	it("swallows a late rejection from the orphaned run", async () => {
		const gate = deferred<void>();
		const generate = vi.fn((_signal: AbortSignal) => gate.promise);

		const resultPromise = runGenerationWithAbortableTimeout(generate, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		const result = await resultPromise;
		expect(result.timedOut).toBe(true);

		// Orphan rejects late (e.g. the aborted fetch throws AbortError). If this
		// rejection weren't swallowed inside the helper, flushing microtasks here
		// would surface an unhandled rejection. We assert the flush completes
		// without throwing.
		gate.reject(new Error("aborted"));
		let threw = false;
		try {
			await vi.advanceTimersByTimeAsync(0);
			// Extra real-microtask flush to let any un-swallowed rejection surface.
			await Promise.resolve();
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	/**
	 * Generation that REJECTS on its own before the timeout → surfaces the
	 * error, not a timeout. Distinguishes provider-error path from timeout
	 * path (the call site sends different failure copy for each).
	 */
	it("surfaces a genuine generation error without marking it a timeout", async () => {
		const boom = new Error("provider 500");
		const generate = vi.fn(async (_signal: AbortSignal) => {
			throw boom;
		});

		const resultPromise = runGenerationWithAbortableTimeout(generate, 5000);
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.timedOut).toBe(false);
		expect(result.settled).toBe(true);
		expect(result.error).toBe(boom);
	});

	/**
	 * `timeoutMs === null` disables the timeout: generation is awaited to
	 * completion and no abort is fired even for a long job. Covers the media /
	 * long-running path (Wan video etc.).
	 */
	it("awaits to completion with no abort when the timeout is disabled (null)", async () => {
		const gate = deferred<void>();
		let capturedSignal: AbortSignal | undefined;
		const generate = vi.fn((signal: AbortSignal) => {
			capturedSignal = signal;
			return gate.promise;
		});

		const resultPromise = runGenerationWithAbortableTimeout(generate, null);
		// Advance well past any plausible timeout — nothing should fire.
		await vi.advanceTimersByTimeAsync(600_000);
		expect(capturedSignal?.aborted).toBe(false);

		gate.resolve();
		const result = await resultPromise;
		expect(result.timedOut).toBe(false);
		expect(result.settled).toBe(true);
		expect(capturedSignal?.aborted).toBe(false);
	});

	/**
	 * (e) Back-to-back messages: the FIRST run times out (and is aborted), the
	 * SECOND run gets its OWN fresh controller and is NOT poisoned by the
	 * first's abort. This is the unit-level reproduction of the alternating
	 * pattern — each invocation is independent. RED against pre-fix where the
	 * orphaned first run stayed live and could bleed into the next slot.
	 */
	it("gives each invocation an independent controller (no cross-poisoning)", async () => {
		// First message: hangs → times out → aborted.
		let firstSignal: AbortSignal | undefined;
		const firstGenerate = vi.fn((signal: AbortSignal) => {
			firstSignal = signal;
			return new Promise<void>(() => {});
		});
		const firstPromise = runGenerationWithAbortableTimeout(firstGenerate, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		const firstResult = await firstPromise;
		expect(firstResult.timedOut).toBe(true);
		expect(firstSignal?.aborted).toBe(true);

		// Second message: completes cleanly. Its signal must be a DIFFERENT,
		// un-aborted controller.
		let secondSignal: AbortSignal | undefined;
		const secondGenerate = vi.fn(async (signal: AbortSignal) => {
			secondSignal = signal;
		});
		const secondPromise = runGenerationWithAbortableTimeout(
			secondGenerate,
			1000,
		);
		await vi.advanceTimersByTimeAsync(0);
		const secondResult = await secondPromise;

		expect(secondResult.timedOut).toBe(false);
		expect(secondSignal).toBeDefined();
		expect(secondSignal).not.toBe(firstSignal);
		expect(secondSignal?.aborted).toBe(false);
	});
});

describe("isUserRequestedTurnAbort", () => {
	it("recognizes core's TURN_ABORTED error by code, not by message", () => {
		const aborted = Object.assign(
			new Error("Turn aborted: user requested to stop"),
			{ code: "TURN_ABORTED" },
		);
		expect(isUserRequestedTurnAbort(aborted)).toBe(true);
		expect(isUserRequestedTurnAbort(new Error("Turn aborted: anything"))).toBe(
			false,
		);
		expect(isUserRequestedTurnAbort(new Error("Bad Request"))).toBe(false);
		expect(isUserRequestedTurnAbort(undefined)).toBe(false);
	});
});
