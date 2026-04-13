/**
 * Stateless execution of a **batch** of work items: each item runs through `process` with a
 * {@link Semaphore} cap, exponential backoff between attempts, and optional `onExhausted`.
 *
 * **Why not push failed items back onto a queue:** Inline retries keep item lifecycle simple and
 * avoid losing work between ticks; releasing the semaphore between attempts lets other items run.
 *
 * Reuses `resolveRetryConfig` / `computeBackoff` from `utils/retry.ts` so delay policy matches
 * the rest of the runtime.
 */
import {
	type BackoffPolicy,
	computeBackoff,
	type RetryConfig,
	resolveRetryConfig,
	sleep,
} from "../retry.js";
import { Semaphore } from "./semaphore.js";

export interface BatchItemOutcome<T> {
	item: T;
	success: boolean;
	error?: Error;
	retryCount: number;
}

export interface BatchProcessorOptions<T> {
	/** Max concurrent `process` calls across the batch. */
	maxParallel: number;
	/**
	 * After a failed attempt, re-try up to this many times (embedding-style).
	 * Total attempts = maxRetriesAfterFailure + 1. Default 3 → 4 total tries.
	 *
	 * **Interaction with per-item `maxRetries`:** If the item is an object with numeric `maxRetries`,
	 * total attempts use `maxRetries + 1` instead of this default (unless `maxAttemptsCap` applies).
	 * Prefer one source of truth per call site to avoid surprises.
	 */
	maxRetriesAfterFailure?: number;
	retryPolicy?: RetryConfig;
	/**
	 * Upper bound on attempts per item after resolving per-item `maxRetries` and global retry config.
	 * Use for shutdown-style paths where items may carry large `maxRetries` but only one try is wanted.
	 */
	maxAttemptsCap?: number;
	process: (item: T) => Promise<void>;
	onExhausted?: (item: T, error: Error) => void | Promise<void>;
	shouldRetry?: (item: T, error: Error, attempt: number) => boolean;
}

function defaultShouldRetry(
	_item: unknown,
	_err: Error,
	_attempt: number,
): boolean {
	return true;
}

function toBackoffPolicy(
	resolved: ReturnType<typeof resolveRetryConfig>,
): BackoffPolicy {
	return {
		initialMs: resolved.minDelayMs,
		maxMs: resolved.maxDelayMs,
		factor: 2,
		jitter: resolved.jitter,
	};
}

/**
 * If the item carries `maxRetries` (e.g. embedding payload), total attempts = `maxRetries + 1`.
 * **Why:** Aligns with “retryCount < maxRetries” style loops elsewhere in the codebase.
 */
function getPerItemMaxAttempts(item: unknown, fallback: number): number {
	if (
		item &&
		typeof item === "object" &&
		"maxRetries" in item &&
		typeof (item as { maxRetries?: unknown }).maxRetries === "number"
	) {
		const mr = (item as { maxRetries: number }).maxRetries;
		if (Number.isFinite(mr) && mr >= 0) {
			return mr + 1;
		}
	}
	return fallback;
}

export class BatchProcessor<T> {
	private readonly maxParallel: number;
	private readonly defaultMaxAttempts: number;
	private readonly maxAttemptsCap?: number;
	private readonly policy: BackoffPolicy;
	private readonly process: (item: T) => Promise<void>;
	private readonly onExhausted?: (
		item: T,
		error: Error,
	) => void | Promise<void>;
	private readonly shouldRetry: (
		item: T,
		error: Error,
		attempt: number,
	) => boolean;
	private readonly semaphore: Semaphore;

	constructor(options: BatchProcessorOptions<T>) {
		this.maxParallel = Math.max(1, options.maxParallel);
		// retriesAfter + 1 total attempts: first try + N failures that may retry.
		const retriesAfter = options.maxRetriesAfterFailure ?? 3;
		const resolved = resolveRetryConfig(
			{
				attempts: retriesAfter + 1,
				minDelayMs: 300,
				maxDelayMs: 30_000,
				jitter: 0,
			},
			options.retryPolicy,
		);
		this.defaultMaxAttempts = resolved.attempts;
		this.maxAttemptsCap = options.maxAttemptsCap;
		// Factor 2 in toBackoffPolicy: matches classic exponential backoff between attempts.
		this.policy = toBackoffPolicy(resolved);
		this.process = options.process;
		this.onExhausted = options.onExhausted;
		this.shouldRetry = options.shouldRetry ?? defaultShouldRetry;
		this.semaphore = new Semaphore(this.maxParallel);
	}

	async processBatch(items: T[]): Promise<BatchItemOutcome<T>[]> {
		return Promise.all(items.map((item) => this.processOne(item)));
	}

	private async processOne(item: T): Promise<BatchItemOutcome<T>> {
		const resolved = getPerItemMaxAttempts(item, this.defaultMaxAttempts);
		const maxAttempts = Math.max(
			1,
			this.maxAttemptsCap !== undefined
				? Math.min(resolved, this.maxAttemptsCap)
				: resolved,
		);
		let retryCount = 0;
		let lastError: Error = new Error("unknown");

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await this.semaphore.acquire();
			try {
				await this.process(item);
				return { item, success: true, retryCount };
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (
					attempt >= maxAttempts ||
					!this.shouldRetry(item, lastError, attempt)
				) {
					if (this.onExhausted) {
						await this.onExhausted(item, lastError);
					}
					return {
						item,
						success: false,
						error: lastError,
						retryCount,
					};
				}
				retryCount++;
			} finally {
				this.semaphore.release();
			}
			const delayMs = computeBackoff(this.policy, attempt);
			if (delayMs > 0) {
				await sleep(delayMs);
			}
		}

		// Unreachable when maxAttempts >= 1 (loop always returns), but satisfies the compiler.
		return { item, success: false, error: lastError, retryCount };
	}
}
