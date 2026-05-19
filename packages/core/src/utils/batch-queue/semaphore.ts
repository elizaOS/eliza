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
	private waiters: Array<() => void> = [];

	constructor(count: number) {
		this.permits = Math.max(1, count);
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
		this.permits += 1;
		const next = this.waiters.shift();
		if (next && this.permits > 0) {
			this.permits -= 1;
			next();
		}
	}
}
