/**
 * Shared test utility functions.
 *
 * Consolidates helpers that were duplicated across many test files:
 * - saveEnv / envSnapshot — environment variable snapshotting
 * - withTimeout — promise timeout wrapper
 * - sleep — simple delay
 * - createDeferred — externally-resolvable promise
 */

/**
 * Save current values of environment variables and return a restore function.
 * Use in beforeEach/afterEach to prevent env leaks between tests.
 */
export function saveEnv(...keys: string[]): { restore: () => void } {
	const saved: Record<string, string | undefined> = {};
	for (const key of keys) {
		saved[key] = process.env[key];
	}
	return {
		restore() {
			for (const key of keys) {
				if (saved[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = saved[key];
				}
			}
		},
	};
}

/**
 * Snapshot environment variables with set/clear/restore operations.
 * Alternative to saveEnv with more control.
 */
export function envSnapshot(keys: string[]): {
	save: () => void;
	set: (key: string, value: string) => void;
	clear: () => void;
	restore: () => void;
} {
	const saved: Record<string, string | undefined> = {};
	for (const key of keys) {
		saved[key] = process.env[key];
	}
	return {
		save() {
			for (const key of keys) {
				saved[key] = process.env[key];
			}
		},
		set(key: string, value: string) {
			process.env[key] = value;
		},
		clear() {
			for (const key of keys) {
				delete process.env[key];
			}
		},
		restore() {
			for (const key of keys) {
				if (saved[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = saved[key];
				}
			}
		},
	};
}

/**
 * Wrap a promise with a timeout. Rejects with an error if the promise
 * doesn't resolve within the given time.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label = "Operation",
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	});
}

/**
 * Simple delay utility.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Create a promise with externally-accessible resolve/reject functions.
 */
export function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
