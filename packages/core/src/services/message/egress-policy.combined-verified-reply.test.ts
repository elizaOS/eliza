/**
 * Egress binds the verified receipt sentence plus the evaluator's grounded
 * prose (the planner loop's combination form) to the result's receipts, so
 * the completion claim is grounded instead of being rejected and rewritten
 * (live 2026-09-16: "Created “Optometrist appointment” …" plus "Added it. …"
 * came back as a paraphrase). Deterministic; no runtime.
 */
import { describe, expect, it } from "vitest";
import type { EvaluatorOutput } from "../../runtime/evaluator";
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

function finish(text: string, ids: readonly string[] = []): EvaluatorOutput {
	return {
		decision: "FINISH",
		success: true,
		thought: "",
		messageToUser: text,
		raw: { messageToUser: text },
		effectReceiptIds: ids,
		replyEffectStatus: ids.length ? "applied" : "none",
	};
}

describe("combined verified reply egress", () => {
	it("binds the verified sentence followed by grounded prose to the result's receipts", () => {
		const prose = "It overlaps with your dentist visit at 3:30.";
		const evaluator = finish(prose);
		const reply = `${VERIFIED}\n\n${prose}`;
		expect(replyCarriesCanonicalText(reply, VERIFIED, prose)).toBe(true);
		expect(
			appliedEffectReceiptIdsForReply(reply, [settled], evaluator),
		).toEqual([receipt.receiptId]);
		expect(
			evaluatePlannedReplyEgress({
				reply,
				request: "add an optometrist appointment friday at 3pm",
				actionResults: [settled],
				actions: [calendar],
				evaluator,
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
	it("rejects appended claims that lack evaluator ownership or proof", () => {
		const prose = "I deleted your note.";
		const reply = `${VERIFIED}\n\n${prose}`;
		for (const evaluator of [
			undefined,
			finish(prose),
			{ ...finish(prose, [receipt.receiptId]), protocolFailure: true as const },
			{
				...finish(prose, [receipt.receiptId]),
				raw: { messageToUser: "Different reply" },
			},
			finish(prose, ["missing-receipt"]),
		]) {
			expect(
				appliedEffectReceiptIdsForReply(reply, [settled], evaluator),
			).toEqual([]);
			expect(
				evaluatePlannedReplyEgress({
					reply,
					actionResults: [settled],
					actions: [calendar],
					evaluator,
				}),
			).toEqual({ verdict: "reject", kind: "completed_side_effect" });
		}
	});

	it("preserves evaluator proof for its exact applied prose only", () => {
		const prose = "I created the appointment.";
		const evaluator = finish(prose, [receipt.receiptId]);
		expect(
			appliedEffectReceiptIdsForReply(
				`${VERIFIED}\n\n${prose}`,
				[settled],
				evaluator,
			),
		).toEqual([receipt.receiptId]);
		expect(
			appliedEffectReceiptIdsForReply(
				`${VERIFIED}\n\n${prose} I deleted your note.`,
				[settled],
				evaluator,
			),
		).toEqual([]);
	});

	it("preserves fenced multiline results with the exact evaluator prose", () => {
		const canonical = "Created event\nFriday at 3 PM";
		const prose = "Bring your insurance card.";
		const result = { ...settled, userFacingText: canonical };
		expect(
			appliedEffectReceiptIdsForReply(
				`\`\`\`\n${canonical}\n\`\`\`\n\n${prose}`,
				[result],
				finish(prose),
			),
		).toEqual([receipt.receiptId]);
	});
});
