/**
 * Powered-on scheduling: an occurrence is missed only when it passed outside
 * the scheduled window while the agent process was not running. A delay while
 * the agent was running (device doze, a busy scheduler) still runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	agentProcessStartedAtMs,
	isMissedScheduledOccurrence,
	MISSED_SCHEDULED_OCCURRENCES_SETTING,
	SCHEDULED_OCCURRENCE_WINDOW_MS,
} from "../src/services/trigger-scheduling.ts";

afterEach(() => vi.restoreAllMocks());

describe("powered-on scheduled occurrences", () => {
	const now = Date.parse("2026-10-27T13:30:00.000Z");
	const nineAm = Date.parse("2026-10-27T09:00:00.000Z");

	it("records an occurrence that passed before the agent started", () => {
		expect(isMissedScheduledOccurrence(nineAm, now, now - 5_000)).toBe(true);
	});

	it("runs an occurrence reached within the window, even right after boot", () => {
		const scheduled = now - SCHEDULED_OCCURRENCE_WINDOW_MS;
		expect(isMissedScheduledOccurrence(scheduled, now, now - 1_000)).toBe(
			false,
		);
		expect(isMissedScheduledOccurrence(scheduled - 1, now, now - 1_000)).toBe(
			true,
		);
	});

	it("runs a late occurrence that came due while the agent was running", () => {
		expect(isMissedScheduledOccurrence(nineAm, now, nineAm - 60 * 60_000)).toBe(
			false,
		);
	});

	it("derives the agent start from process uptime", () => {
		vi.spyOn(process, "uptime").mockReturnValue(90.5);
		expect(agentProcessStartedAtMs(now)).toBe(now - 90_500);
		expect(isMissedScheduledOccurrence(now - 3 * 60_000, now)).toBe(true);
		expect(isMissedScheduledOccurrence(now - 60_000, now)).toBe(false);
		expect(MISSED_SCHEDULED_OCCURRENCES_SETTING).toBe(
			"ELIZA_MISSED_SCHEDULED_OCCURRENCES",
		);
	});
});
