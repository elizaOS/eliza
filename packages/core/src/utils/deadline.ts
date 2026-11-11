/**
 * Provides the canonical promise deadline engine while leaving timeout budgets
 * and boundary-specific error or fallback policies with each subsystem.
 */

export interface DeadlineOptions<TTimeout> {
	timeoutMs: number;
	onTimeout: () => TTimeout;
}

/** Largest delay setTimeout accepts; a larger value overflows to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref: () => void }).unref();
	}
}

/** Resolve the source promise or the boundary-owned timeout value. */
export async function resolveAtDeadline<T, TTimeout>(
	promise: Promise<T>,
	options: DeadlineOptions<TTimeout>,
): Promise<T | TTimeout> {
	// An unbounded deadline never times out: arming a timer for it would
	// overflow Node's 32-bit timeout (Infinity clamps to 1 ms) and resolve
	// with the timeout value almost at once.
	if (options.timeoutMs === Infinity) {
		return await promise;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<TTimeout>((resolve, reject) => {
				// A finite deadline past the 32-bit limit is armed in
				// MAX_TIMEOUT_MS chunks so it fires at the requested time
				// instead of overflowing to 1 ms.
				let remaining = options.timeoutMs;
				const arm = (): void => {
					const delay = Math.min(remaining, MAX_TIMEOUT_MS);
					timer = setTimeout(() => {
						remaining -= delay;
						if (remaining > 0) {
							arm();
							return;
						}
						try {
							resolve(options.onTimeout());
						} catch (error) {
							reject(error);
						}
					}, delay);
					unrefTimer(timer);
				};
				arm();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Reject with the boundary-owned error when the source misses its deadline. */
export function rejectAtDeadline<T>(
	promise: Promise<T>,
	options: DeadlineOptions<Error>,
): Promise<T> {
	return resolveAtDeadline(promise, {
		timeoutMs: options.timeoutMs,
		onTimeout: () => {
			throw options.onTimeout();
		},
	});
}
