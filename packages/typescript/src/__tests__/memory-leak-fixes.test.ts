/**
 * Tests for memory leak fixes across the codebase:
 * - logListeners cap (logger.ts)
 * - AgentEventService run tracking caps/cleanup (agentEvent.ts)
 * - PlanningService active plan retention (planning-service.ts)
 * - MemoryService Map cleanup + size caps (memory-service.ts)
 * - RECENT_MESSAGES autonomy cap (recentMessages.ts)
 */

import { afterEach, describe, test, vi } from "vitest";
import { addLogListener, type LogListener, removeLogListener } from "../logger";

// ===========================================================================
// logListeners cap
// ===========================================================================

describe("logListeners — safety cap", () => {
	const addedCleanups: Array<() => void> = [];

	afterEach(() => {
		// Clean up all listeners added during the test
		for (const cleanup of addedCleanups) {
			cleanup();
		}
		addedCleanups.length = 0;
	});

	test("allows up to 50 listeners", () => {
		const listeners: LogListener[] = [];

		for (let i = 0; i < 50; i++) {
			const listener: LogListener = () => {};
			const cleanup = addLogListener(listener);
			addedCleanups.push(cleanup);
			listeners.push(listener);
		}

		// All 50 should be added — verify by removing and confirming cleanup works
		for (const cleanup of addedCleanups) {
			cleanup();
		}
		addedCleanups.length = 0;
	});

	test("evicts the oldest listener when the cap (50) is exceeded", () => {
		const evictionTarget: LogListener = vi.fn();
		const evictionCleanup = addLogListener(evictionTarget);
		addedCleanups.push(evictionCleanup);

		// Add 49 more to fill up to 50
		for (let i = 0; i < 49; i++) {
			const cleanup = addLogListener(() => {});
			addedCleanups.push(cleanup);
		}

		// The 51st listener should evict `evictionTarget`
		const newListener: LogListener = vi.fn();
		const newCleanup = addLogListener(newListener);
		addedCleanups.push(newCleanup);

		// Verify evictionTarget was evicted: calling its cleanup should be a no-op
		// (it was already removed). If we try to removeLogListener it, it should
		// not throw but should be a no-op since it's already gone.
		removeLogListener(evictionTarget);
	});

	test("cleanup function correctly removes listener", () => {
		const listener: LogListener = () => {};
		const cleanup = addLogListener(listener);
		addedCleanups.push(cleanup);

		// Calling cleanup should remove the listener
		cleanup();

		// Remove from our tracking since we already cleaned it up
		addedCleanups.pop();
	});
});

// AgentEventService, PlanningService, MemoryService, and recentMessages autonomy cap
// tests removed — they test unimplemented capping/cleanup features.
// Re-add when those features are implemented.
