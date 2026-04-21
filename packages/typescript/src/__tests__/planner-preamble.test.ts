/**
 * Unit tests for the planner-preamble emission logic in the message service.
 *
 * When the planner returns `{text, actions}`, the runtime decides whether to
 * surface `text` to the user based on the dispatch mode:
 *
 *   - Simple mode (`actions === ["REPLY"]` + `simple=true` + planner text):
 *     text is emitted as the reply via the normal simple-mode pipeline.
 *   - Actions mode with first action REPLY: skip the preamble — the REPLY
 *     handler generates its own text via TEXT_LARGE.
 *   - Actions mode with first action IGNORE or STOP: skip the preamble —
 *     nothing is sent to the user.
 *   - Actions mode with any other first action: fire the preamble so the user
 *     sees "checking your inbox" before INBOX/GMAIL/etc. produce the grounded
 *     answer.
 *
 * `shouldEmitPlannerPreamble` encodes that decision.
 */

import { describe, expect, it } from "vitest";
import {
	resolveStrategyMode,
	shouldEmitPlannerPreamble,
	stripReplyWhenActionOwnsTurn,
} from "../services/message.ts";

const runtime = {
	actions: [
		{ name: "INBOX" },
		{ name: "GMAIL_ACTION" },
		{ name: "BLOCK_WEBSITES", suppressPostActionContinuation: true },
		{
			name: "OWNER_CALENDAR",
			similes: ["UPDATE_MEETING_PREFERENCES"],
			suppressPostActionContinuation: true,
		},
		{
			name: "CALL_USER",
			similes: ["CALL_IF_STUCK"],
			suppressPostActionContinuation: true,
		},
		{ name: "SLOW_BACKGROUND_LOOKUP" },
	],
	logger: {
		info() {},
		warn() {},
		debug() {},
		error() {},
	},
} as Parameters<typeof shouldEmitPlannerPreamble>[0];

describe("shouldEmitPlannerPreamble", () => {
	it("emits when first action is a non-terminal action and text is present", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "checking your inbox",
				actions: ["INBOX"],
			}),
		).toBe(true);
	});

	it("emits when text is present and first action is any non-REPLY/IGNORE/STOP", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "looking that up",
				actions: ["GMAIL_ACTION"],
			}),
		).toBe(true);
	});

	it("does not emit when first action is REPLY (REPLY handler produces text)", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "hello", actions: ["REPLY"] }),
		).toBe(false);
	});

	it("does not emit when first action is IGNORE (no user-visible response)", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "irrelevant",
				actions: ["IGNORE"],
			}),
		).toBe(false);
	});

	it("does not emit when first action is STOP (terminal)", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "shutting down",
				actions: ["STOP"],
			}),
		).toBe(false);
	});

	it("does not emit when text is empty", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "", actions: ["INBOX"] }),
		).toBe(false);
	});

	it("does not emit when text is whitespace only", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "   \n  ",
				actions: ["INBOX"],
			}),
		).toBe(false);
	});

	it("does not emit when actions array is empty", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "something", actions: [] }),
		).toBe(false);
	});

	it("normalizes action identifiers (underscores, case)", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "hi", actions: ["reply"] }),
		).toBe(false);
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "hi", actions: ["Re_Ply"] }),
		).toBe(false);
	});

	it("returns false for null / undefined content", () => {
		expect(shouldEmitPlannerPreamble(runtime, null)).toBe(false);
		expect(shouldEmitPlannerPreamble(runtime, undefined)).toBe(false);
	});

	it("skips preamble when REPLY is the first action even if other actions follow", () => {
		// The REPLY handler is still invoked via processActions and produces
		// its own user-visible text, so we don't pre-emit the plan.
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "checking",
				actions: ["REPLY", "INBOX"],
			}),
		).toBe(false);
	});

	it("emits preamble when REPLY trails a non-terminal first action", () => {
		// First action drives the decision; REPLY later in the list is the
		// responsibility of processActions.
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "checking your inbox",
				actions: ["INBOX", "REPLY"],
			}),
		).toBe(true);
	});

	it("does not emit when the first action suppresses post-action continuation", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "blocking x.com and twitter.com for 1 minute.",
				actions: ["BLOCK_WEBSITES"],
			}),
		).toBe(false);
	});
});
