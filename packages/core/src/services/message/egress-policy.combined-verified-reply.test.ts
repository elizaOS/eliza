/**
 * Verifies real egress receipt binding for combined tool and evaluator text.
 * Deterministic fixtures require each span to retain its own exact proof;
 * an action-owned prefix cannot authorize arbitrary appended claims.
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

function boundEvaluator(text: string): EvaluatorOutput {
	return {
		success: true,
		decision: "FINISH",
		thought: "The observed result grounds this response.",
		messageToUser: text,
		raw: { messageToUser: text },
		effectReceiptIds: [receipt.receiptId],
	};
}

describe("combined verified reply egress", () => {
	it("binds the verified sentence followed by grounded prose to the result's receipts", () => {
		const prose = "It overlaps with your dentist visit at 3:30.";
		const evaluator = boundEvaluator(prose);
		const reply = `${VERIFIED}\n\n${prose}`;
		expect(replyCarriesCanonicalText(reply, VERIFIED)).toBe(true);
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
});

it.each([
	{ name: "absent evaluator", evaluator: undefined },
	{
		name: "changed prose",
		evaluator: boundEvaluator("A different statement."),
	},
	{
		name: "missing receipts",
		evaluator: { ...boundEvaluator("Added it."), effectReceiptIds: [] },
	},
	{
		name: "unknown receipts",
		evaluator: {
			...boundEvaluator("Added it."),
			effectReceiptIds: ["unrelated"],
		},
	},
	{
		name: "changed original",
		evaluator: {
			...boundEvaluator("Added it."),
			raw: { messageToUser: "Different original" },
		},
	},
])("rejects unbound combined prose: $name", ({ evaluator }) => {
	const reply = `${VERIFIED}\n\nAdded it.`;
	expect(appliedEffectReceiptIdsForReply(reply, [settled], evaluator)).toEqual(
		[],
	);
	expect(
		evaluatePlannedReplyEgress({
			reply,
			request: "add an appointment",
			actionResults: [settled],
			actions: [calendar],
			evaluator,
		}),
	).toEqual({ verdict: "reject", kind: "completed_side_effect" });
});

it("preserves independently bound prose after a fenced multiline result", () => {
	const canonical = `${VERIFIED}\nCalendar: primary`;
	const result = { ...settled, userFacingText: canonical };
	const prose = "Added it.";
	expect(
		appliedEffectReceiptIdsForReply(
			`\`\`\`\n${canonical}\n\`\`\`\n\n${prose}`,
			[result],
			boundEvaluator(prose),
		),
	).toEqual([receipt.receiptId]);
});

it.each([
	"The dentist appointment was moved to 5pm.",
	"Deleted all your reminders.",
	"Your task list is empty.",
	"Created another calendar event.",
	"I have cancelled the dentist appointment.",
])("does not ground additional suffix effects: %s", (prose) => {
	const reply = `${VERIFIED}\n\n${prose}`;
	expect(
		evaluatePlannedReplyEgress({
			reply,
			request: "add an optometrist appointment friday at 3pm",
			actionResults: [settled],
			actions: [calendar],
		}),
	).toEqual({ verdict: "reject", kind: "completed_side_effect" });
	expect(appliedEffectReceiptIdsForReply(reply, [settled])).toEqual([]);
});

it("retains distinct receipt bindings for both spans", () => {
	const moved = {
		...receipt,
		receiptId: "calendar-event-mutation-receipt-v1:update",
		operation: "calendar.event.update",
		resource: { ...receipt.resource, id: "dentist-event" },
	};
	const prose = "The dentist appointment was moved to 5pm.";
	const evaluator = {
		...boundEvaluator(prose),
		effectReceiptIds: [moved.receiptId],
	};
	const results = [settled, { success: true, effectReceipts: [moved] }];
	const reply = `${VERIFIED}\n\n${prose}`;
	expect(appliedEffectReceiptIdsForReply(reply, results, evaluator)).toEqual([
		receipt.receiptId,
		moved.receiptId,
	]);
	expect(
		evaluatePlannedReplyEgress({
			reply,
			request: "add the optometrist and move the dentist appointment",
			actionResults: results,
			actions: [calendar],
			evaluator,
		}),
	).toEqual({ verdict: "allow" });
});
