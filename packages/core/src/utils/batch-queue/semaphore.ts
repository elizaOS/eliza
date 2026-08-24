/**
 * Async semaphore: limits how many in-flight `process` calls run at once (true throttle for I/O).
 *
 * **Contract:** every `acquire()` must be paired with `release()` in a `finally` (or equivalent)
 * so permits return even when the guarded work throws. {@link BatchProcessor} does this; ad-hoc
 * callers must do the same.
 *
 * **Why shared with PromptDispatcher:** One implementation avoids drift; `prompt-batcher/shared`
 * re-exports this module so existing `import { Semaphore } from "./shared"` keeps working.
 */
export class Semaphore {
	private permits: number;
	private maxPermits: number;
	private waiters: Array<() => void> = [];

	constructor(count: number) {
		const sanitized =
			typeof count === "number" && Number.isFinite(count)
				? Math.max(1, Math.floor(count))
				: 1;
		this.permits = sanitized;
		this.maxPermits = sanitized;
	}

	/** Number of currently available permits. */
	get availablePermits(): number {
		return this.permits;
	}

	/** Number of tasks currently queued waiting for a permit. */
	get queueLength(): number {
		return this.waiters.length;
	}

	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits -= 1;
			return;
		}

		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		if (this.permits < this.maxPermits) {
			this.permits += 1;
		}
	}
}
