/**
 * Tests for the RECENT_ERRORS provider: renders nothing when clean, dedupes by
 * code (newest wins), caps the list, and ages out stale entries. Uses a fake
 * runtime that returns a controlled reported-error ring.
 */

import { describe, expect, it } from "vitest";
import type { ReportedError } from "../errors";
import type { IAgentRuntime, Memory, State } from "../types";
import { recentErrorsProvider } from "./recent-errors";

function runtimeWith(entries: ReportedError[]): IAgentRuntime {
	return { getRecentReportedErrors: () => entries } as unknown as IAgentRuntime;
}

const message = {} as Memory;
const state = {} as State;

describe("RECENT_ERRORS provider", () => {
	it("renders nothing and costs no tokens when there are no errors", async () => {
		const result = await recentErrorsProvider.get(
			runtimeWith([]),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.values?.recentErrors).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("dedupes by code, keeping the newest occurrence", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "A", code: "DUP", message: "old dup", at: now - 1000 },
			{ scope: "A", code: "DUP", message: "new dup", at: now - 100 },
			{ scope: "B", code: "OTHER", message: "other", at: now - 50 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(2);
		const dup = surfaced.find((e) => e.code === "DUP");
		expect(dup?.message).toBe("new dup");
		expect(result.text).toContain("DUP: new dup");
		expect(result.text).not.toContain("old dup");
	});

	it("caps the surfaced list at 5 distinct codes (newest-first)", async () => {
		const now = Date.now();
		const entries: ReportedError[] = Array.from({ length: 8 }, (_, i) => ({
			scope: "S",
			code: `C${i}`,
			message: `m${i}`,
			at: now - i * 10,
		}));
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(5);
		// Newest (C0) first, oldest kept is C4.
		expect(surfaced[0].code).toBe("C0");
		expect(surfaced.at(-1)?.code).toBe("C4");
	});

	it("ages out entries older than 30 minutes", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "S", code: "STALE", message: "stale", at: now - 31 * 60 * 1000 },
			{ scope: "S", code: "FRESH", message: "fresh", at: now - 60 * 1000 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0].code).toBe("FRESH");
	});

	it("renders empty when every entry is stale", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{ scope: "S", code: "OLD", message: "old", at: now - 60 * 60 * 1000 },
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
	});
});
