/**
 * Orders host shutdown around Electrobun's quit sequence.
 *
 * `Utils.quit()` emits `before-quit` synchronously and then blocks in native
 * teardown until the process exits, so async cleanup started from the handler
 * never runs. The gate vetoes that first quit, runs cleanup, and quits again
 * once cleanup has settled. Cleanup is bounded by a deadline so one hung
 * callback cannot leave the app unable to quit.
 */

/** Upper bound for shutdown cleanup before the host quits regardless. */
export const SHUTDOWN_CLEANUP_DEADLINE_MS = 20_000;

/** The part of Electrobun's `before-quit` event the gate writes to. */
export interface BeforeQuitEvent {
	response?: { allow: boolean } | undefined;
}

export interface QuitGateOptions {
	/** Runs shutdown cleanup. Must be safe to call more than once. */
	runCleanup: () => Promise<void>;
	/** Starts the host quit sequence (`Utils.quit()`). */
	quit: () => void;
	deadlineMs?: number;
	onCleanupError?: (error: unknown) => void;
	onDeadline?: (deadlineMs: number) => void;
}

export interface QuitGate {
	/** Runs cleanup (bounded by the deadline) and then quits. Idempotent. */
	requestQuit: () => Promise<void>;
	/** `before-quit` handler: vetoes the quit until cleanup has settled. */
	handleBeforeQuit: (event: BeforeQuitEvent) => void;
	/** Marks cleanup as settled so the next quit is allowed through. */
	markCleanupSettled: () => void;
}

export function createQuitGate(options: QuitGateOptions): QuitGate {
	const deadlineMs = options.deadlineMs ?? SHUTDOWN_CLEANUP_DEADLINE_MS;
	let cleanupSettled = false;
	let quitRequest: Promise<void> | null = null;

	const markCleanupSettled = (): void => {
		cleanupSettled = true;
	};

	const requestQuit = (): Promise<void> => {
		if (quitRequest) return quitRequest;
		quitRequest = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = Promise.resolve()
				.then(options.runCleanup)
				.catch((error: unknown) => {
					options.onCleanupError?.(error);
				})
				.then(() => false);
			const deadline = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), deadlineMs);
			});
			const timedOut = await Promise.race([cleanup, deadline]);
			clearTimeout(timer);
			if (timedOut) {
				options.onDeadline?.(deadlineMs);
			}
			// Settled or abandoned: either way the next before-quit must pass.
			markCleanupSettled();
			options.quit();
		})();
		return quitRequest;
	};

	const handleBeforeQuit = (event: BeforeQuitEvent): void => {
		if (cleanupSettled) return;
		event.response = { allow: false };
		void requestQuit();
	};

	return { requestQuit, handleBeforeQuit, markCleanupSettled };
}
