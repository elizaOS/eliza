/** Verifies both model-download deadline timers abort and dispose deterministically. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDownloadDeadline } from "./model-download-deadline.ts";

afterEach(() => vi.useRealTimers());

describe("createModelDownloadDeadline", () => {
	it("clears both idle and absolute timers when disposed", () => {
		vi.useFakeTimers();
		const deadline = createModelDownloadDeadline({
			label: "model",
			idleTimeoutMs: 100,
			totalTimeoutMs: 200,
		});
		expect(vi.getTimerCount()).toBe(2);
		deadline.noteProgress();
		expect(vi.getTimerCount()).toBe(2);
		deadline.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports the absolute deadline reason despite recent progress", () => {
		vi.useFakeTimers();
		const deadline = createModelDownloadDeadline({
			label: "model",
			idleTimeoutMs: 100,
			totalTimeoutMs: 50,
		});
		vi.advanceTimersByTime(40);
		deadline.noteProgress();
		vi.advanceTimersByTime(10);
		expect(deadline.signal.aborted).toBe(true);
		expect(deadline.failure(new Error("fallback"))).toEqual(
			new Error("model exceeded the 50ms total deadline"),
		);
		deadline.dispose();
	});
});
