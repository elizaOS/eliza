/** Tests the pure workspace-delta receipt validator with deterministic fixtures. */

import { describe, expect, it } from "vitest";
import {
	normalizeWorkspaceDeltaReceipt,
	readWorkspaceDeltaReceipt,
	WORKSPACE_DELTA_RECEIPT_DATA_KEY,
} from "./workspace-delta";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ROOT_ID = "c".repeat(64);
const DOMAIN_ID = "d".repeat(64);

function observed(outcome: "changed" | "unchanged") {
	return {
		version: 1,
		kind: "workspace_delta",
		scope: {
			kind: "git_worktree",
			root: "/workspace",
			rootId: ROOT_ID,
			executionDomainId: DOMAIN_ID,
			coverage: "tracked_and_untracked_nonignored",
		},
		outcome,
		beforeFingerprint: HASH_A,
		afterFingerprint: outcome === "changed" ? HASH_B : HASH_A,
		observedAt: "2026-08-22T12:00:00.000Z",
	};
}

describe("WorkspaceDeltaReceipt", () => {
	it("normalizes observed and indeterminate receipts", () => {
		expect(normalizeWorkspaceDeltaReceipt(observed("changed"))).toEqual(
			observed("changed"),
		);
		expect(
			normalizeWorkspaceDeltaReceipt({
				...observed("unchanged"),
				outcome: "indeterminate",
				afterFingerprint: undefined,
				reasonCode: "POST_SNAPSHOT_FAILED",
			}),
		).toMatchObject({
			outcome: "indeterminate",
			reasonCode: "POST_SNAPSHOT_FAILED",
			beforeFingerprint: HASH_A,
		});
	});

	it("reads only the canonical ActionResult.data key", () => {
		expect(
			readWorkspaceDeltaReceipt({
				[WORKSPACE_DELTA_RECEIPT_DATA_KEY]: observed("unchanged"),
			}),
		).toMatchObject({ outcome: "unchanged" });
		expect(readWorkspaceDeltaReceipt({ unrelated: observed("changed") })).toBe(
			undefined,
		);
	});

	it("preserves display roots separately from canonical opaque identities", () => {
		const receipt = normalizeWorkspaceDeltaReceipt({
			...observed("unchanged"),
			scope: {
				...observed("unchanged").scope,
				root: "[redacted]",
			},
		});
		expect(receipt.scope).toEqual({
			kind: "git_worktree",
			root: "[redacted]",
			rootId: ROOT_ID,
			executionDomainId: DOMAIN_ID,
			coverage: "tracked_and_untracked_nonignored",
		});
	});

	it("requires pending and terminal background receipts to carry matching lifecycle status", () => {
		const pending = {
			...observed("unchanged"),
			outcome: "indeterminate",
			afterFingerprint: undefined,
			reasonCode: "BACKGROUND_RECEIPT_PENDING",
			operation: {
				kind: "background_shell",
				handle: "bg-1",
				status: "terminating",
			},
		};
		expect(normalizeWorkspaceDeltaReceipt(pending)).toMatchObject({
			outcome: "indeterminate",
			operation: { handle: "bg-1", status: "terminating" },
		});
		expect(() =>
			normalizeWorkspaceDeltaReceipt({
				...observed("unchanged"),
				operation: {
					kind: "background_shell",
					handle: "bg-1",
					status: "running",
				},
			}),
		).toThrow(/terminal status/);
	});

	it.each([
		{ ...observed("changed"), version: 2 },
		{ ...observed("changed"), outcome: "maybe" },
		{ ...observed("changed"), beforeFingerprint: "short" },
		{ ...observed("changed"), observedAt: "not-a-time" },
		{ ...observed("changed"), observedAt: "2026-08-22" },
		{
			...observed("changed"),
			scope: { ...observed("changed").scope, rootId: "short" },
		},
		{
			...observed("changed"),
			scope: {
				...observed("changed").scope,
				executionDomainId: undefined,
			},
		},
		{ ...observed("changed"), afterFingerprint: HASH_A },
		{ ...observed("unchanged"), afterFingerprint: HASH_B },
		{ ...observed("changed"), extra: true },
		{
			...observed("changed"),
			scope: { ...observed("changed").scope, extra: true },
		},
		{
			...observed("changed"),
			outcome: "indeterminate",
			afterFingerprint: undefined,
			reasonCode: "BACKGROUND_RECEIPT_PENDING",
		},
		{
			...observed("changed"),
			operation: {
				kind: "background_shell",
				handle: "bg-1",
				status: "exited",
				extra: true,
			},
		},
		{
			...observed("changed"),
			outcome: "indeterminate",
			afterFingerprint: undefined,
			reasonCode: "arbitrary prose",
		},
		{
			...observed("changed"),
			outcome: "indeterminate",
			reasonCode: "POST_SNAPSHOT_FAILED",
		},
	])("rejects malformed receipt %#", (value) => {
		expect(() => normalizeWorkspaceDeltaReceipt(value)).toThrow(TypeError);
	});
});
