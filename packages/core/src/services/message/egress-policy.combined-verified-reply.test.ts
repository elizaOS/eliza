/**
 * Egress binds the verified receipt sentence plus the evaluator's grounded
 * prose (the planner loop's combination form) to the result's receipts, so
 * the completion claim is grounded instead of being rejected and rewritten
 * (live 2026-09-16, gate 181: "Created “Optometrist appointment” …" plus
 * "Added it. …" came back as a paraphrase). Deterministic; no runtime.
 */
import { describe, expect, it } from "vitest";
import type { Action, ActionResult } from "../../types/components";
import {
	appliedEffectReceiptIdsForReply,
	evaluatePlannedReplyEgress,
	replyCarriesCanonicalText,
} from "./egress-policy";

const receipt = {
	receiptId: "calendar-event-mutation-receipt-v1:create",
	operation: "calendar.event.create",
	resource: {
		kind: "calendar.event",
		id: "agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:evt-9",
		version: '"eliza-1"',
	},
	artifacts: [],
	idempotency: { key: "calendar-local-operation-v1:create", replayed: false },
	observedAt: "2026-09-16T00:07:00.000Z",
	outcome: "applied" as const,
	commit: {
		kind: "durable" as const,
		id: "agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:evt-9",
		committedAt: "2026-09-16T00:07:00.000Z",
	},
};
const VERIFIED =
	"Created “Optometrist appointment” for Friday, Sep 18 at 3pm EDT.";
const settled: ActionResult = {
	success: true,
	text: VERIFIED,
	userFacingText: VERIFIED,
	verifiedUserFacing: true,
	turnComplete: true,
	effectReceipts: [receipt],
	userFacingEffectReceiptIds: [receipt.receiptId],
};
const calendar = {
	name: "CALENDAR",
	tags: ["domain:calendar", "effect:receipt-required"],
} as unknown as Action;

describe("combined verified reply egress", () => {
	it("binds the verified sentence followed by grounded prose to the result's receipts", () => {
		const reply = `${VERIFIED}\n\nIt overlaps with your dentist visit at 3:30.`;
		expect(replyCarriesCanonicalText(reply, VERIFIED)).toBe(true);
		expect(appliedEffectReceiptIdsForReply(reply, [settled])).toEqual([
			receipt.receiptId,
		]);
		expect(
			evaluatePlannedReplyEgress({
				reply,
				request: "add an optometrist appointment friday at 3pm",
				actionResults: [settled],
				actions: [calendar],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("still rejects a paraphrase that no longer carries the exact sentence", () => {
		const reply =
			"Added it. Optometrist appointment is on your calendar for Friday, September 18 at 3:00 PM EDT.";
		expect(replyCarriesCanonicalText(reply, VERIFIED)).toBe(false);
		expect(appliedEffectReceiptIdsForReply(reply, [settled])).toEqual([]);
		expect(
			evaluatePlannedReplyEgress({
				reply,
				request: "add an optometrist appointment friday at 3pm",
				actionResults: [settled],
				actions: [calendar],
			}),
		).toEqual({ verdict: "reject", kind: "completed_side_effect" });
	});

	it("does not bind a sentence embedded mid-prose or rewritten", () => {
		expect(replyCarriesCanonicalText(`Sure. ${VERIFIED}`, VERIFIED)).toBe(
			false,
		);
		expect(replyCarriesCanonicalText(`${VERIFIED} And more.`, VERIFIED)).toBe(
			false,
		);
	});
});
