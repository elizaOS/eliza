/**
 * Run non-critical startup work in the background.
 *
 * WHY: Plugins/services sometimes want to warm caches or precompute state during
 * startup, but blocking init delays the whole agent. Centralize the "fire later,
 * log errors, allow cancel" pattern so callers do not duplicate timer/cancel
 * handling.
 */

import { logger } from "../logger.js";

export function deferStartupWork(
	label: string,
	fn: () => Promise<void>,
	delayMs = 0,
): () => void {
	let cancelled = false;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const run = () => {
		if (cancelled) return;
		fn().catch((error) => {
			logger.warn({ error }, `[${label}] Deferred startup work failed`);
		});
	};

	if (delayMs > 0) {
		timeoutId = setTimeout(run, delayMs);
	} else {
		run();
	}

	return () => {
		cancelled = true;
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
	};
}
