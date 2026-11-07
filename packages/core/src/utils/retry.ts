/** Abortable sleeps, exponential backoff and retry-config resolution for bounded retries. */

// Sleep Utilities

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
 * @throws The signal's abort reason if aborted
 */
export async function sleepWithAbort(
	ms: number,
	abortSignal?: AbortSignal,
): Promise<void> {
	abortSignal?.throwIfAborted();
	if (ms <= 0) {
		return;
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeoutId);
			reject(abortSignal?.reason);
		};
		const timeoutId = setTimeout(() => {
			abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Backoff Policy

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

// Retry Configuration

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
	defaults: Required<RetryConfig>,
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
