/**
 * Unit tests for the planner-preamble emission logic in the message service.
 *
 * When the planner returns `{text, actions}`, the runtime decides whether to
 * surface `text` to the user based on the first action:
 *
 *   - Simple mode (`actions === ["REPLY"]`): text is emitted as the reply via
 *     the normal simple-mode pipeline. No preamble needed.
 *   - Actions mode with first action REPLY: skip the preamble — the REPLY
 *     handler generates its own text.
 *   - Actions mode with first action IGNORE or STOP: skip the preamble —
 *     nothing is sent to the user.
 *   - Actions mode with any other first action: fire the preamble so the user
 *     sees "checking your inbox" before INBOX/GMAIL/etc. produce the grounded
 *     answer.
 *
 * `shouldEmitPlannerPreamble` encodes that decision.
 */

import { describe, expect, it } from "vitest";
import { shouldEmitPlannerPreamble } from "../services/message.ts";

describe("shouldEmitPlannerPreamble", () => {
	it("emits when first action is a non-terminal action and text is present", () => {
		expect(
			shouldEmitPlannerPreamble({
				text: "checking your inbox",
				actions: ["INBOX"],
			}),
		).toBe(true);
	});

	it("emits when text is present and first action is any non-REPLY/IGNORE/STOP", () => {
		expect(
			shouldEmitPlannerPreamble({
				text: "looking that up",
				actions: ["GMAIL_ACTION"],
			}),
		).toBe(true);
	});

	it("does not emit when first action is REPLY (REPLY handler produces text)", () => {
		expect(
			shouldEmitPlannerPreamble({ text: "hello", actions: ["REPLY"] }),
		).toBe(false);
	});

	it("does not emit when first action is IGNORE (no user-visible response)", () => {
		expect(
			shouldEmitPlannerPreamble({ text: "irrelevant", actions: ["IGNORE"] }),
		).toBe(false);
	});

	it("does not emit when first action is STOP (terminal)", () => {
		expect(
			shouldEmitPlannerPreamble({ text: "shutting down", actions: ["STOP"] }),
		).toBe(false);
	});

	it("does not emit when text is empty", () => {
		expect(shouldEmitPlannerPreamble({ text: "", actions: ["INBOX"] })).toBe(
			false,
		);
	});

	it("does not emit when text is whitespace only", () => {
		expect(
			shouldEmitPlannerPreamble({ text: "   \n  ", actions: ["INBOX"] }),
		).toBe(false);
	});

	it("does not emit when actions array is empty", () => {
		expect(shouldEmitPlannerPreamble({ text: "something", actions: [] })).toBe(
			false,
		);
	});

	it("normalizes action identifiers (underscores, case)", () => {
		expect(shouldEmitPlannerPreamble({ text: "hi", actions: ["reply"] })).toBe(
			false,
		);
		expect(shouldEmitPlannerPreamble({ text: "hi", actions: ["Re_Ply"] })).toBe(
			false,
		);
	});

	it("returns false for null / undefined content", () => {
		expect(shouldEmitPlannerPreamble(null)).toBe(false);
		expect(shouldEmitPlannerPreamble(undefined)).toBe(false);
	});

	it("skips preamble when REPLY is the first action even if other actions follow", () => {
		// The REPLY handler is still invoked via processActions and produces
		// its own user-visible text, so we don't pre-emit the plan.
		expect(
			shouldEmitPlannerPreamble({
				text: "checking",
				actions: ["REPLY", "INBOX"],
			}),
		).toBe(false);
	});

	it("emits preamble when REPLY trails a non-terminal first action", () => {
		// First action drives the decision; REPLY later in the list is the
		// responsibility of processActions.
		expect(
			shouldEmitPlannerPreamble({
				text: "checking your inbox",
				actions: ["INBOX", "REPLY"],
			}),
		).toBe(true);
	});
});
