/**
 * Tests for the RECENT_ERRORS provider: renders nothing when clean, dedupes by
 * code (newest wins), caps the list, and ages out stale entries. Uses a fake
 * runtime that returns a controlled reported-error ring.
 */

import { describe, expect, it } from "vitest";
import type { ReportedError } from "../errors";
import type { IAgentRuntime, Memory, State } from "../types";
import { QUIET_ERROR_CODES, recentErrorsProvider } from "./recent-errors";

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

	it("never narrates internal scheduler-plumbing codes into chat (SHADOW-ACCOUNT-DEBUG)", async () => {
		const now = Date.now();
		// The exact codes that spammed Shadow's chat 9x.
		const entries: ReportedError[] = [
			{
				scope: "TaskService.timer",
				code: "TASK_TICK_FAILED",
				message: "1 scheduled task failure(s)",
				at: now - 100,
			},
			{
				scope: "validateTasks",
				code: "TASK_WORKER_MISSING",
				message: "No worker registered for task X",
				at: now - 90,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("still surfaces a genuinely actionable error even when quiet codes are present", async () => {
		const now = Date.now();
		const entries: ReportedError[] = [
			{
				scope: "TaskService.timer",
				code: "TASK_TICK_FAILED",
				message: "noise",
				at: now - 100,
			},
			{
				scope: "WalletPlugin",
				code: "WALLET_RPC_DOWN",
				message: "upstream RPC unreachable",
				at: now - 50,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		const surfaced = result.data?.recentErrors as ReportedError[];
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0].code).toBe("WALLET_RPC_DOWN");
		expect(result.text).not.toContain("TASK_TICK_FAILED");
	});

	it("never narrates diagnostic-only persistence failures into chat", async () => {
		const entries: ReportedError[] = [
			{
				scope: "TrajectoryStorage.write",
				code: "TRAJECTORY_SAVE_FAILED",
				message: "Could not save trajectory",
				context: { stepId: "step-failed", diagnosticOnly: true },
				at: Date.now(),
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.data?.recentErrors).toEqual([]);
	});

	it("frames the block as internal diagnostics that never absorb user questions", async () => {
		// A live "available_apps provider timeout" rendered without this framing
		// got answered as if it were the user's question (tj-f8249b30e986d6).
		const entries: ReportedError[] = [
			{
				scope: "provider:available_apps",
				code: "PROVIDER_TIMEOUT",
				message: "available_apps provider timeout",
				at: Date.now() - 100,
			},
		];
		const result = await recentErrorsProvider.get(
			runtimeWith(entries),
			message,
			state,
		);
		expect(result.text).toContain("internal diagnostics");
		expect(result.text).toContain(
			"Never assume a user's message refers to them unless the user explicitly asks about errors.",
		);
		// The self-healing / escalation instruction is unchanged.
		expect(result.text).toContain("tell the owner");
	});

	it("exports the quiet-code set with the scheduler plumbing codes", () => {
		expect(QUIET_ERROR_CODES.has("TASK_TICK_FAILED")).toBe(true);
		expect(QUIET_ERROR_CODES.has("TASK_WORKER_MISSING")).toBe(true);
		expect(QUIET_ERROR_CODES.has("WALLET_RPC_DOWN")).toBe(false);
	});
});
