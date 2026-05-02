/**
 * Retry and backoff utilities for robust async operations.
 *
 * Provides:
 * - Exponential backoff with jitter
 * - Configurable retry logic
 * - Abort signal support
 *
 * @module utils/retry
 */

// ============================================================================
// Sleep Utilities
// ============================================================================

/**
 * Sleep for a specified duration.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with abort signal support.
 *
 * @param ms - Milliseconds to sleep
 * @param abortSignal - Optional signal to abort sleep
 * @throws If aborted
 */
export async function sleepWithAbort(
	ms: number,
	abortSignal?: AbortSignal,
): Promise<void> {
	if (ms <= 0) {
		return;
	}
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			return reject(new Error("aborted"));
		}

		const timeoutId = setTimeout(() => {
			if (abortSignal) {
				abortSignal.removeEventListener("abort", onAbort);
			}
			resolve();
		}, ms);

		function onAbort() {
			clearTimeout(timeoutId);
			reject(new Error("aborted"));
		}

		if (abortSignal) {
			abortSignal.addEventListener("abort", onAbort);
		}
	});
}

// ============================================================================
// Backoff Policy
// ============================================================================

/**
 * Configuration for exponential backoff.
 */
export type BackoffPolicy = {
	/** Initial delay in milliseconds */
	initialMs: number;
	/** Maximum delay in milliseconds */
	maxMs: number;
	/** Multiplier for each attempt */
	factor: number;
	/** Random jitter factor (0-1) */
	jitter: number;
};

/**
 * Compute the backoff delay for a given attempt.
 *
 * @param policy - Backoff policy configuration
 * @param attempt - Attempt number (1-based)
 * @returns Delay in milliseconds
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
	const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
	const jitter = base * policy.jitter * Math.random();
	return Math.min(policy.maxMs, Math.round(base + jitter));
}

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Basic retry configuration.
 */
export type RetryConfig = {
	/** Maximum number of attempts */
	attempts?: number;
	/** Minimum delay between retries in ms */
	minDelayMs?: number;
	/** Maximum delay between retries in ms */
	maxDelayMs?: number;
	/** Random jitter factor (0-1) */
	jitter?: number;
};

/**
 * Information about a retry attempt.
 */
export type RetryInfo = {
	/** Current attempt number */
	attempt: number;
	/** Maximum attempts configured */
	maxAttempts: number;
	/** Delay before this retry in ms */
	delayMs: number;
	/** The error that triggered the retry */
	err: unknown;
	/** Optional label for logging */
	label?: string;
};

/**
 * Full retry options including callbacks.
 */
export type RetryOptions = RetryConfig & {
	/** Label for logging/debugging */
	label?: string;
	/** Custom function to determine if error should trigger retry */
	shouldRetry?: (err: unknown, attempt: number) => boolean;
	/** Custom function to extract retry-after from error */
	retryAfterMs?: (err: unknown) => number | undefined;
	/** Callback called before each retry */
	onRetry?: (info: RetryInfo) => void;
};

const DEFAULT_RETRY_CONFIG = {
	attempts: 3,
	minDelayMs: 300,
	maxDelayMs: 30_000,
	jitter: 0,
};

const asFiniteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clampNumber = (
	value: unknown,
	fallback: number,
	min?: number,
	max?: number,
): number => {
	const next = asFiniteNumber(value);
	if (next === undefined) {
		return fallback;
	}
	const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
	const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
	return Math.min(Math.max(next, floor), ceiling);
};

/**
 * Resolve retry configuration with defaults.
 *
 * @param defaults - Default configuration
 * @param overrides - Override values
 * @returns Fully resolved configuration
 */
export function resolveRetryConfig(
	defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
	overrides?: RetryConfig,
): Required<RetryConfig> {
	const attempts = Math.max(
		1,
		Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)),
	);
	const minDelayMs = Math.max(
		0,
		Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
	);
	const maxDelayMs = Math.max(
		minDelayMs,
		Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
	);
	const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
	return { attempts, minDelayMs, maxDelayMs, jitter };
}

function applyJitter(delayMs: number, jitter: number): number {
	if (jitter <= 0) {
		return delayMs;
	}
	const offset = (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.round(delayMs * (1 + offset)));
}

/**
 * Execute an async function with automatic retries.
 *
 * Supports two calling styles:
 * 1. Simple: `retryAsync(fn, attempts, initialDelayMs)`
 * 2. Full options: `retryAsync(fn, { attempts, minDelayMs, ... })`
 *
 * @example
 * ```ts
 * // Simple usage
 * const result = await retryAsync(() => fetch(url), 3, 1000);
 *
 * // Full options
 * const result = await retryAsync(
 *   () => fetch(url),
 *   {
 *     attempts: 5,
 *     minDelayMs: 500,
 *     maxDelayMs: 30000,
 *     jitter: 0.2,
 *     shouldRetry: (err) => isRetryable(err),
 *     onRetry: ({ attempt, delayMs }) => log(`Retry ${attempt} in ${delayMs}ms`)
 *   }
 * );
 * ```
 *
 * @param fn - Async function to execute
 * @param attemptsOrOptions - Number of attempts or full options
 * @param initialDelayMs - Initial delay (only used with simple calling style)
 * @returns Promise resolving to function result
 * @throws Last error after all retries exhausted
 */
export async function retryAsync<T>(
	fn: () => Promise<T>,
	attemptsOrOptions: number | RetryOptions = 3,
	initialDelayMs = 300,
): Promise<T> {
	if (typeof attemptsOrOptions === "number") {
		const attempts = Math.max(1, Math.round(attemptsOrOptions));
		let lastErr: unknown;
		for (let i = 0; i < attempts; i += 1) {
			try {
				return await fn();
			} catch (err) {
				lastErr = err;
				if (i === attempts - 1) {
					break;
				}
				const delay = initialDelayMs * 2 ** i;
				await sleep(delay);
			}
		}
		throw lastErr ?? new Error("Retry failed");
	}

	const options = attemptsOrOptions;

	const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
	const maxAttempts = resolved.attempts;
	const minDelayMs = resolved.minDelayMs;
	const maxDelayMs =
		Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
			? resolved.maxDelayMs
			: Number.POSITIVE_INFINITY;
	const jitter = resolved.jitter;
	const shouldRetry = options.shouldRetry ?? (() => true);
	let lastErr: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
				break;
			}

			const retryAfterMs = options.retryAfterMs?.(err);
			const hasRetryAfter =
				typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
			const baseDelay = hasRetryAfter
				? Math.max(retryAfterMs, minDelayMs)
				: minDelayMs * 2 ** (attempt - 1);
			let delay = Math.min(baseDelay, maxDelayMs);
			delay = applyJitter(delay, jitter);
			delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

			options.onRetry?.({
				attempt,
				maxAttempts,
				delayMs: delay,
				err,
				label: options.label,
			});
			await sleep(delay);
		}
	}

	throw lastErr ?? new Error("Retry failed");
}
