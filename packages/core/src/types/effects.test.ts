/**
 * Canonical effect-receipt validation and current-turn proof resolution.
 * These deterministic tests exercise malformed, conflicting, replayed, and
 * rolled-back outcomes without substituting a provider for commit evidence.
 */

import { describe, expect, it } from "vitest";
import type { EffectReceipt } from "./effects";
import {
	hasAppliedUserFacingEffectProof,
	mergeEffectReceipts,
	normalizeEffectReceipt,
	normalizeEffectReceipts,
	resolveAppliedUserFacingEffectReceipts,
	tagsMayProduceEffects,
	tagsPermitAutomaticRetry,
	tagsRequireEffectReceipts,
} from "./effects";

const observedAt = "2026-07-27T18:00:00.000Z";

function appliedReceipt(overrides: Partial<EffectReceipt> = {}): EffectReceipt {
	return {
		receiptId: "receipt-1",
		operation: "lifeops.reminder.create",
		resource: { kind: "lifeops.reminder", id: "reminder-1" },
		artifacts: [],
		idempotency: { key: "request-1", replayed: false },
		observedAt,
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "transaction-1",
			committedAt: observedAt,
		},
		...overrides,
	} as EffectReceipt;
}

describe("effect receipt validation", () => {
	it("canonicalizes and freezes applied proof while discarding unknown fields", () => {
		const receipt = normalizeEffectReceipt({
			...appliedReceipt(),
			untrustedPayload: "must-not-propagate",
			resource: {
				kind: " lifeops.reminder ",
				id: " reminder-1 ",
				untrustedPayload: "must-not-propagate",
			},
		});

		expect(receipt).toMatchObject({
			receiptId: "receipt-1",
			resource: { kind: "lifeops.reminder", id: "reminder-1" },
			outcome: "applied",
		});
		expect(receipt).not.toHaveProperty("untrustedPayload");
		expect(receipt.resource).not.toHaveProperty("untrustedPayload");
		expect(Object.isFrozen(receipt)).toBe(true);
		expect(Object.isFrozen(receipt.resource)).toBe(true);
	});

	it.each([
		["missing commit", { ...appliedReceipt(), commit: undefined }],
		[
			"replay without a key",
			{
				...appliedReceipt(),
				idempotency: { key: null, replayed: true },
			},
		],
		[
			"invalid timestamp",
			{ ...appliedReceipt(), observedAt: "not-a-timestamp" },
		],
		[
			"ambiguous timestamp",
			{ ...appliedReceipt(), observedAt: "July 27, 2026" },
		],
		[
			"impossible calendar date",
			{ ...appliedReceipt(), observedAt: "2026-02-30T18:00:00.000Z" },
		],
		[
			"empty rollback target",
			{
				...appliedReceipt(),
				outcome: "rolled_back",
				commit: undefined,
				rollback: {
					receiptId: "rollback-1",
					revertedReceiptIds: [],
					rolledBackAt: observedAt,
				},
			},
		],
	])("rejects %s", (_name, value) => {
		expect(() => normalizeEffectReceipt(value)).toThrow();
	});

	it("deduplicates exact retries and rejects conflicting receipt identities", () => {
		const receipt = appliedReceipt();
		expect(normalizeEffectReceipts([receipt, receipt])).toHaveLength(1);
		expect(() =>
			normalizeEffectReceipts([
				receipt,
				{
					...receipt,
					operation: "lifeops.reminder.update",
				},
			]),
		).toThrow(/reused for a different outcome/iu);
	});

	it("canonicalizes an explicit timezone offset to UTC", () => {
		expect(
			normalizeEffectReceipt({
				...appliedReceipt(),
				observedAt: "2026-07-27T11:00:00-07:00",
			}).observedAt,
		).toBe(observedAt);
	});

	it.each([
		"capability:write",
		"capability:update",
		"capability:delete",
		"capability:schedule",
		"capability:send",
		"capability:delegate",
		"capability:execute",
	])("treats %s as a mutation-capable action boundary", (tag) => {
		expect(tagsMayProduceEffects([tag])).toBe(true);
		expect(tagsPermitAutomaticRetry([tag])).toBe(false);
	});

	it("separates receipt enforcement rollout from mutation retry safety", () => {
		expect(tagsRequireEffectReceipts(["capability:write"])).toBe(false);
		expect(
			tagsRequireEffectReceipts([
				"capability:write",
				"effect:receipt-required",
			]),
		).toBe(true);
		expect(
			tagsPermitAutomaticRetry(["capability:write", "effect:receipt-required"]),
		).toBe(false);
		expect(
			tagsPermitAutomaticRetry(["capability:write", "effect:idempotent"]),
		).toBe(true);
	});
});

describe("effect receipt proof resolution", () => {
	it("requires exact verified text and every referenced applied receipt", () => {
		const receipt = appliedReceipt();
		const result = {
			verifiedUserFacing: true,
			userFacingText: "Done — the reminder is set.",
			effectReceipts: [receipt],
			userFacingEffectReceiptIds: [receipt.receiptId],
		};

		expect(hasAppliedUserFacingEffectProof(result)).toBe(true);
		expect(resolveAppliedUserFacingEffectReceipts(result)).toEqual([receipt]);
		expect(
			hasAppliedUserFacingEffectProof({
				...result,
				verifiedUserFacing: false,
			}),
		).toBe(false);
		expect(
			hasAppliedUserFacingEffectProof({
				...result,
				userFacingEffectReceiptIds: ["unknown-receipt"],
			}),
		).toBe(false);
	});

	it("rejects preview, failure, no-op, and same-turn rollback as application proof", () => {
		const applied = appliedReceipt();
		const rollback: EffectReceipt = {
			...applied,
			receiptId: "receipt-rollback",
			operation: "lifeops.reminder.rollback",
			outcome: "rolled_back",
			rollback: {
				receiptId: "rollback-transaction-1",
				revertedReceiptIds: [applied.receiptId],
				rolledBackAt: "2026-07-27T18:01:00.000Z",
			},
		};
		const allTurn = mergeEffectReceipts([applied], [rollback]);
		const result = {
			verifiedUserFacing: true,
			userFacingText: "Done — the reminder is set.",
			effectReceipts: [applied],
			userFacingEffectReceiptIds: [applied.receiptId],
		};

		expect(resolveAppliedUserFacingEffectReceipts(result, allTurn)).toBeNull();
		for (const receipt of [
			{ ...applied, outcome: "preview" as const, commit: undefined },
			{
				...applied,
				outcome: "noop" as const,
				commit: undefined,
				reason: "already existed",
			},
			{
				...applied,
				outcome: "failed" as const,
				commit: undefined,
				failure: {
					code: "PROVIDER_TIMEOUT",
					retryable: true,
					acceptance: "unknown" as const,
				},
			},
		]) {
			expect(
				hasAppliedUserFacingEffectProof({
					...result,
					effectReceipts: [receipt as EffectReceipt],
				}),
			).toBe(false);
		}
	});

	it("accepts a replayed no-op as committed desired-state proof", () => {
		const replayedNoop = {
			...appliedReceipt(),
			outcome: "noop",
			commit: undefined,
			reason: "an equivalent reminder already exists",
			idempotency: { key: "request-1", replayed: true },
		} as EffectReceipt;
		const result = {
			verifiedUserFacing: true,
			userFacingText: "An equivalent reminder already exists.",
			effectReceipts: [replayedNoop],
			userFacingEffectReceiptIds: [replayedNoop.receiptId],
		};

		expect(hasAppliedUserFacingEffectProof(result)).toBe(true);
		expect(resolveAppliedUserFacingEffectReceipts(result)?.[0]).toMatchObject({
			receiptId: "receipt-1",
			outcome: "noop",
			idempotency: { key: "request-1", replayed: true },
		});
		// A non-replayed no-op still proves nothing: "nothing changed" without a
		// verified earlier commit is not desired-state evidence.
		expect(
			hasAppliedUserFacingEffectProof({
				...result,
				effectReceipts: [
					{
						...replayedNoop,
						idempotency: { key: "request-1", replayed: false },
					} as EffectReceipt,
				],
			}),
		).toBe(false);
	});

	it("rejects a replayed no-op whose observed commit was reverted this turn", () => {
		const replayedNoop = {
			...appliedReceipt(),
			outcome: "noop",
			commit: undefined,
			reason: "an equivalent reminder already exists",
			idempotency: { key: "request-1", replayed: true },
		} as EffectReceipt;
		const rollback: EffectReceipt = {
			...appliedReceipt(),
			receiptId: "receipt-rollback",
			operation: "lifeops.reminder.rollback",
			outcome: "rolled_back",
			commit: undefined,
			rollback: {
				receiptId: "rollback-transaction-1",
				revertedReceiptIds: [replayedNoop.receiptId],
				rolledBackAt: "2026-07-27T18:01:00.000Z",
			},
		} as EffectReceipt;
		const result = {
			verifiedUserFacing: true,
			userFacingText: "An equivalent reminder already exists.",
			effectReceipts: [replayedNoop],
			userFacingEffectReceiptIds: [replayedNoop.receiptId],
		};

		expect(
			resolveAppliedUserFacingEffectReceipts(
				result,
				mergeEffectReceipts([replayedNoop], [rollback]),
			),
		).toBeNull();
	});
});
