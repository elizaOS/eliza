/**
 * Zero-delivery recovery regression tests for #20086 (v3 redesign of #20402).
 *
 * These tests drive the REAL production decision logic: they import and call
 * `answerlessAckFallback`, the exported seam in `message.ts` that
 * `runV5MessageRuntimeStage1` uses to compute the answerless-final fallback,
 * plus the real `answerlessToolTurnReport` it delegates to. The v2 suite
 * re-declared the gate locally and stayed green with the fix reverted; here,
 * reverting the seam's behavior (the early-ack guard, the success/failure
 * split) turns these tests red — see the mutation run recorded in the PR.
 *
 * Pre-fix (develop) symptom corrected here, described honestly: an all-failed
 * answerless turn did NOT say "on it, working on that now." — that string
 * requires an ACCEPTED async handoff (`success === true`). It produced
 * NO_REPORTABLE_TOOL_OUTCOME_MESSAGE (or a verified failure text). The live
 * gap was the EARLY-ACK turn: once a progress ack shipped, the
 * `!earlyReplySent` guard dropped the turn from the report entirely, so a
 * turn whose tools all failed ended with the ack and then silence — no
 * terminal reply, violating the issue's recovery criterion.
 */

import { describe, expect, it } from "vitest";
import type { PlannerToolResult } from "../runtime/planner-loop";
import type { Action, ActionResult } from "../types";
import {
	answerlessAckFallback,
	NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
	normalizeVisibleTextForDuplicateCheck,
} from "./message";

const ASYNC_HANDOFF_ACK = "on it, working on that now.";

type SettledEntry = { name: string; result: PlannerToolResult };

function baseArgs() {
	return {
		actionResults: [] as readonly ActionResult[],
		settledToolResults: [] as ReadonlyArray<SettledEntry>,
		deliveredVisibleTexts: new Set<string>(),
		actions: undefined as readonly Action[] | undefined,
		stageOneAck: "",
		plannedText: "",
		earlyReplySent: false,
		suppressesPlannerReply: false,
		preservedAnswerFallback: "",
		mediaDeliverableShipped: false,
	};
}

function acceptedHandoffFixture() {
	// Minimal accepted-async-handoff shape: hasAcceptedAsyncHandoff reads only
	// success + effectReceipts[].outcome/commit.id; candidateActionsIncludeAsync
	// Handoff reads name/similes + asyncHandoff. Cast away the unrelated
	// receipt-bookkeeping fields the production guards never touch here.
	const handoffResult = {
		success: true,
		data: { actionName: "SPAWN_AGENT" },
		effectReceipts: [{ outcome: "applied", commit: { id: "commit-1" } }],
	} as unknown as ActionResult;
	const handoffAction = {
		name: "SPAWN_AGENT",
		asyncHandoff: true,
	} as unknown as Action;
	return { handoffResult, handoffAction };
}

describe("zero-delivery recovery (#20086) — answerlessAckFallback seam", () => {
	it("success turn: delivers the last successful action's userFacingText", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [{ success: true }, { success: true }],
			settledToolResults: [
				{
					name: "LOOKUP",
					result: { success: true, userFacingText: "first result text." },
				},
				{
					name: "CALENDAR_CREATE",
					result: {
						success: true,
						userFacingText: "Event saved: 3pm tomorrow.",
					},
				},
			],
		});
		expect(result).toBe("Event saved: 3pm tomorrow.");
	});

	it("all-failed turn: delivers the verified failure text (failure-aware wording)", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [{ success: false }],
			settledToolResults: [
				{
					name: "WEB_SEARCH",
					result: {
						success: false,
						verifiedUserFacing: true,
						userFacingText: "The search failed: upstream rate limit.",
					},
				},
			],
		});
		expect(result).toBe("The search failed: upstream rate limit.");
	});

	it("all-failed turn without owned text: never silent, never the handoff ack (silence-regression case)", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [{ success: false }, { success: false }],
			settledToolResults: [
				{ name: "WEB_SEARCH", result: { success: false } },
				{ name: "LOOKUP", result: { success: false, text: "exit=1" } },
			],
		});
		expect(result).toBe(NO_REPORTABLE_TOOL_OUTCOME_MESSAGE);
		expect(result).not.toBe("");
		expect(result).not.toBe(ASYNC_HANDOFF_ACK);
	});

	it("early-ack + all-failed turn: still delivers failure-aware terminal wording (v3 fix)", () => {
		// develop's `!earlyReplySent` guard returned "" here — the progress ack
		// was the user's only word on a turn where every tool failed.
		const result = answerlessAckFallback({
			...baseArgs(),
			earlyReplySent: true,
			actionResults: [{ success: false }],
			settledToolResults: [
				{ name: "WEB_SEARCH", result: { success: false, text: "exit=1" } },
			],
		});
		expect(result).toBe(NO_REPORTABLE_TOOL_OUTCOME_MESSAGE);
	});

	it("early-ack + all-failed turn: delivers the verified failure text when one exists", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			earlyReplySent: true,
			actionResults: [{ success: false }],
			settledToolResults: [
				{
					name: "WEB_SEARCH",
					result: {
						success: false,
						verifiedUserFacing: true,
						userFacingText: "The search failed: upstream rate limit.",
					},
				},
			],
		});
		expect(result).toBe("The search failed: upstream rate limit.");
	});

	it("early-ack + accepted async handoff: does not duplicate the handoff ack", () => {
		const { handoffResult, handoffAction } = acceptedHandoffFixture();
		const result = answerlessAckFallback({
			...baseArgs(),
			earlyReplySent: true,
			actionResults: [handoffResult],
			actions: [handoffAction],
		});
		expect(result).toBe("");
	});

	it("no early ack + accepted async handoff: keeps the synchronous ack", () => {
		const { handoffResult, handoffAction } = acceptedHandoffFixture();
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [handoffResult],
			actions: [handoffAction],
		});
		expect(result).toBe(ASYNC_HANDOFF_ACK);
	});

	it("delivered-suppression: action-owned text already delivered via callback is not re-sent", () => {
		const ownedText = "Event saved: 3pm tomorrow.";
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [{ success: true }],
			settledToolResults: [
				{
					name: "CALENDAR_CREATE",
					result: { success: true, userFacingText: ownedText },
				},
			],
			deliveredVisibleTexts: new Set([
				normalizeVisibleTextForDuplicateCheck(ownedText),
			]),
		});
		expect(result).toBe("");
	});

	it("suppressesPlannerReply: deliberate silence is honored (passthrough)", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			suppressesPlannerReply: true,
			actionResults: [{ success: true }],
			settledToolResults: [
				{
					name: "LOOKUP",
					result: { success: true, userFacingText: "should not ship." },
				},
			],
		});
		expect(result).toBe("");
	});

	it("no tools ran: no reportable-outcome filler is invented", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [],
		});
		expect(result).toBe("");
	});

	it("planner text present: fallback stays out of the way", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			plannedText: "Here is the planner's own answer.",
			actionResults: [{ success: true }],
			settledToolResults: [
				{
					name: "LOOKUP",
					result: { success: true, userFacingText: "should not ship." },
				},
			],
		});
		expect(result).toBe("");
	});

	it("preserved substantive stage-0 answer outranks the report", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			preservedAnswerFallback: "The preserved stage-0 answer.",
			actionResults: [{ success: false }],
			settledToolResults: [{ name: "LOOKUP", result: { success: false } }],
		});
		expect(result).toBe("The preserved stage-0 answer.");
	});

	it("synchronously delivered media is the turn's answer: no ack resurrected behind it", () => {
		const result = answerlessAckFallback({
			...baseArgs(),
			actionResults: [{ success: true }],
			settledToolResults: [
				{ name: "GENERATE_MEDIA", result: { success: true } },
			],
			mediaDeliverableShipped: true,
		});
		expect(result).toBe("");
	});
});
