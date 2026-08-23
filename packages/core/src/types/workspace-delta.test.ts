/**
 * Contract tests for the WorkspaceDeltaReceipt parser: malformed values must
 * never validate, because a malformed receipt passing as "unchanged" would
 * let the coding completion gate clear a pending mutation without proof.
 * Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
	parseWorkspaceDeltaReceipt,
	readWorkspaceDeltaReceipt,
	WORKSPACE_DELTA_RECEIPT_KEY,
} from "./workspace-delta";

const digest = "a".repeat(64);

describe("parseWorkspaceDeltaReceipt", () => {
	it("accepts the three statuses with valid fingerprints", () => {
		for (const status of ["changed", "unchanged"] as const) {
			expect(
				parseWorkspaceDeltaReceipt({
					version: 1,
					status,
					beforeFingerprint: digest,
					afterFingerprint: digest,
				}),
			).toEqual({
				version: 1,
				status,
				beforeFingerprint: digest,
				afterFingerprint: digest,
			});
		}
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "not_a_git_worktree",
			}),
		).toEqual({
			version: 1,
			status: "indeterminate",
			reason: "not_a_git_worktree",
		});
	});

	it("rejects malformed values instead of guessing", () => {
		expect(parseWorkspaceDeltaReceipt(null)).toBeNull();
		expect(parseWorkspaceDeltaReceipt("unchanged")).toBeNull();
		expect(parseWorkspaceDeltaReceipt({ status: "unchanged" })).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 2, status: "unchanged" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "CHANGED" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({ version: 1, status: "unknown" }),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "indeterminate",
				reason: "because",
			}),
		).toBeNull();
		// A reason is only meaningful on an indeterminate receipt.
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "unchanged",
				reason: "not_a_git_worktree",
			}),
		).toBeNull();
		expect(
			parseWorkspaceDeltaReceipt({
				version: 1,
				status: "unchanged",
				beforeFingerprint: "not-a-digest",
			}),
		).toBeNull();
	});

	it("drops unknown extra fields from the validated receipt", () => {
		const parsed = parseWorkspaceDeltaReceipt({
			version: 1,
			status: "changed",
			paths: ["secret.txt"],
		});
		expect(parsed).toEqual({ version: 1, status: "changed" });
	});
});

describe("readWorkspaceDeltaReceipt", () => {
	it("reads the receipt from the canonical ActionResult.data key", () => {
		expect(
			readWorkspaceDeltaReceipt({
				[WORKSPACE_DELTA_RECEIPT_KEY]: { version: 1, status: "changed" },
			}),
		).toEqual({ version: 1, status: "changed" });
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
});
