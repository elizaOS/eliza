/**
 * withCleanup — graceful-abort scope for action handlers.
 *
 * When a turn is aborted, action handlers and sub-agents need a brief window
 * to commit WIP, close files, or send a final user-visible reply explaining
 * what stopped. This utility wraps an async function so that:
 *
 *   - When `signal` is NOT aborted: `fn` runs normally. The cleanup function
 *     is never called.
 *   - When `signal` aborts mid-execution: a fresh AbortController is created
 *     with `timeoutMs` deadline. The cleanup callback is invoked with that
 *     fresh signal. The original `fn` is expected to honor its `signal` and
 *     exit; the cleanup runs as a separate phase under the fresh deadline.
 *   - When `signal` is already aborted at call time: the cleanup runs once,
 *     `fn` does NOT run.
 *
 * This matches Temporal's `nonCancellable` scope and Claude Code's "wrap-up
 * window" pattern. Aligns with the repo's AGENTS.md "never lose work to
 * stashes" rule.
 *
 * Typical use:
 *
 *   await withCleanup(turnSignal, 5_000,
 *     async (cleanupSignal) => {
 *       await runShell("git add -A && git commit -m 'WIP: aborted'", {
 *         signal: cleanupSignal,
 *       });
 *     },
 *     async (fn) => {
 *       await spawnCodingAgent(turnSignal);
 *     },
 *   );
 */

export class CleanupTimeoutError extends Error {
	readonly code = "CLEANUP_TIMEOUT";
	constructor(timeoutMs: number) {
		super(`Cleanup phase exceeded ${timeoutMs}ms; force-stopping.`);
	}
}

export async function withCleanup<T>(
	signal: AbortSignal,
	timeoutMs: number,
	cleanup: (cleanupSignal: AbortSignal) => Promise<void>,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	if (signal.aborted) {
		await runCleanup(cleanup, timeoutMs);
		return undefined;
	}
	try {
		const result = await fn();
		return result;
	} catch (error) {
		if (signal.aborted) {
			await runCleanup(cleanup, timeoutMs);
			// Re-throw the original abort so callers can detect it; cleanup ran.
			throw error;
		}
		throw error;
	}
}

async function runCleanup(
	cleanup: (cleanupSignal: AbortSignal) => Promise<void>,
	timeoutMs: number,
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new CleanupTimeoutError(timeoutMs)),
		timeoutMs,
	);
	try {
		await cleanup(controller.signal);
	} catch {
		// Swallow — cleanup is best-effort. We're already in an abort path.
	} finally {
		clearTimeout(timer);
	}
}
