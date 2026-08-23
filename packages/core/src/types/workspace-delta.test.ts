/**
 * Contract tests for the WorkspaceDeltaReceipt parser. The receipt is the
 * evidence the coding completion gate acts on, and it arrives inside an
 * `ActionResult` the runtime does not control, so these tests pin the parser
 * as a trust boundary: a receipt validates only when its own fields prove the
 * status it declares. A merely well-formed receipt that claims `unchanged`
 * without a before/after relationship must never validate, because the planner
 * would clear a pending mutation on it. Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
	parseWorkspaceDeltaReceipt,
	readWorkspaceDeltaReceipt,
	WORKSPACE_DELTA_RECEIPT_KEY,
} from "./workspace-delta";

const before = "a".repeat(64);
const after = "b".repeat(64);

/** The four shapes the coding-tools producer actually emits. */
const changed = {
	version: 1,
	status: "changed",
	beforeFingerprint: before,
	afterFingerprint: after,
} as const;
const unchanged = {
	version: 1,
	status: "unchanged",
	beforeFingerprint: before,
	afterFingerprint: before,
} as const;
const baselineFailure = {
	version: 1,
	status: "indeterminate",
	reason: "not_a_git_worktree",
} as const;
const postFailure = {
	version: 1,
	status: "indeterminate",
	reason: "post_capture_failed",
	beforeFingerprint: before,
} as const;

describe("parseWorkspaceDeltaReceipt", () => {
	it("accepts every receipt the producer emits", () => {
		for (const receipt of [changed, unchanged, baselineFailure, postFailure]) {
			expect(parseWorkspaceDeltaReceipt(receipt)).toEqual(receipt);
		}
		// A baseline failure and a post-execution failure can both report
		// git_unavailable, so it is the one reason valid with or without a
		// baseline digest.
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "git_unavailable",
			}),
		).toEqual({
			version: 1,
			status: "indeterminate",
			reason: "git_unavailable",
		});
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "git_unavailable",
				beforeFingerprint: before,
			}),
		).toEqual({
			version: 1,
			status: "indeterminate",
			reason: "git_unavailable",
			beforeFingerprint: before,
		});
		// Remote capability-router dispatch never fingerprints locally.
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "execution_route_unknown",
			}),
		).toEqual({
			version: 1,
			status: "indeterminate",
			reason: "execution_route_unknown",
		});
	});

	it("rejects malformed values instead of guessing", () => {
		expect(parseWorkspaceDeltaReceipt(null)).toBeNull();
		expect(parseWorkspaceDeltaReceipt("unchanged")).toBeNull();
		expect(parseWorkspaceDeltaReceipt({ status: "unchanged" })).toBeNull();
		expect(parseWorkspaceDeltaReceipt({ ...unchanged, version: 2 })).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "CHANGED" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "unknown" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				...unchanged,
				beforeFingerprint: "not-a-digest",
			}),
		).toBeNull();
	});

	it("rejects a status the receipt's own fingerprints do not prove", () => {
		// The core of the trust boundary: a bare status claim is an assertion,
		// not evidence, and would otherwise clear a pending mutation.
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "unchanged" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "changed" }),
		).toBeNull();
		// unchanged must mean the two digests are equal...
		expect(
			parseWorkspaceDeltaReceipt({ ...unchanged, afterFingerprint: after }),
		).toBeNull();
		// ...and changed must mean they differ.
		expect(
			parseWorkspaceDeltaReceipt({ ...changed, afterFingerprint: before }),
		).toBeNull();
		// Half a pair proves nothing in either direction.
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "changed",
				beforeFingerprint: before,
			}),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "unchanged",
				afterFingerprint: before,
			}),
		).toBeNull();
		// A reason contradicts a status that completed both captures.
		expect(
			parseWorkspaceDeltaReceipt({
				...unchanged,
				reason: "not_a_git_worktree",
			}),
		).toBeNull();
	});

	it("rejects indeterminate receipts without a valid typed reason", () => {
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "indeterminate" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ ...baselineFailure, reason: "because" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ ...baselineFailure, reason: 7 }),
		).toBeNull();
	});

	it("rejects fingerprints a given capture failure could not have produced", () => {
		// No indeterminate path completes the post-execution capture.
		expect(
			parseWorkspaceDeltaReceipt({
				...baselineFailure,
				afterFingerprint: after,
			}),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ ...postFailure, afterFingerprint: after }),
		).toBeNull();
		// A baseline that never completed cannot have produced a digest.
		expect(
			parseWorkspaceDeltaReceipt({
				...baselineFailure,
				beforeFingerprint: before,
			}),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "baseline_capture_failed",
				beforeFingerprint: before,
			}),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "execution_route_unknown",
				beforeFingerprint: before,
			}),
		).toBeNull();
		// A post-execution failure always has the baseline in hand.
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "post_capture_failed",
			}),
		).toBeNull();
	});

	it("drops unknown extra fields from the validated receipt", () => {
		// The receipt is content-free by contract; a producer that smuggles file
		// names alongside a valid verdict must not have them pass through.
		expect(
			parseWorkspaceDeltaReceipt({ ...changed, paths: ["secret.txt"] }),
		).toEqual(changed);
	});
});

describe("readWorkspaceDeltaReceipt", () => {
	it("reads the receipt from the canonical ActionResult.data key", () => {
		expect(
			readWorkspaceDeltaReceipt({ [WORKSPACE_DELTA_RECEIPT_KEY]: changed }),
		).toEqual(changed);
	});

	it("returns null for absent or malformed data", () => {
		expect(readWorkspaceDeltaReceipt(undefined)).toBeNull();
		expect(readWorkspaceDeltaReceipt({})).toBeNull();
		expect(
			readWorkspaceDeltaReceipt({
				[WORKSPACE_DELTA_RECEIPT_KEY]: { version: 1, status: "nope" },
			}),
		).toBeNull();
	});

	it("returns null for a receipt that does not prove its own status", () => {
		expect(
			readWorkspaceDeltaReceipt({
				[WORKSPACE_DELTA_RECEIPT_KEY]: { version: 1, status: "unchanged" },
			}),
		).toBeNull();
	});
});
