/**
 * Unit tests for the planner-preamble emission logic in the message service.
 *
 * Two pieces cooperate to make agents show the planner's text when the first
 * action isn't REPLY:
 *
 *   1. `stripPlannerReplyForSuppressiveActions` removes REPLY from the action
 *      list when a suppressive action (GMAIL/INBOX/etc.) is present, but now
 *      KEEPS the planner's text so the message service can emit it as a
 *      preamble.
 *
 *   2. `shouldEmitPlannerPreamble` decides whether to fire that preamble —
 *      only when text is non-empty AND the first action isn't REPLY, IGNORE,
 *      or STOP.
 *
 * Together, a response like `{text: "checking your inbox", actions: ["INBOX"]}`
 * no longer presents silence to the user; the preamble fires, then INBOX
 * handler produces its grounded answer.
 */

import { describe, expect, it } from "vitest";
import type { Action, Content, IAgentRuntime } from "../types/index.ts";
import {
	shouldEmitPlannerPreamble,
	stripPlannerReplyForSuppressiveActions,
} from "../services/message.ts";

function runtimeWithActions(actions: Action[]): IAgentRuntime {
	return { actions } as unknown as IAgentRuntime;
}

function suppressiveAction(name: string): Action {
	return {
		name,
		similes: [],
		description: name,
		suppressPostActionContinuation: true,
		validate: async () => true,
		handler: async () => ({ success: true }),
		examples: [],
	};
}

function plainAction(name: string): Action {
	return {
		name,
		similes: [],
		description: name,
		validate: async () => true,
		handler: async () => ({ success: true }),
		examples: [],
	};
}

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
		expect(
			shouldEmitPlannerPreamble({ text: "something", actions: [] }),
		).toBe(false);
	});

	it("normalizes action identifiers (underscores, case)", () => {
		expect(
			shouldEmitPlannerPreamble({ text: "hi", actions: ["reply"] }),
		).toBe(false);
		expect(
			shouldEmitPlannerPreamble({ text: "hi", actions: ["Re_Ply"] }),
		).toBe(false);
	});

	it("returns false for null / undefined content", () => {
		expect(shouldEmitPlannerPreamble(null)).toBe(false);
		expect(shouldEmitPlannerPreamble(undefined)).toBe(false);
	});

	it("handles first action being REPLY even when more follow (covered by simple-mode detection upstream)", () => {
		// Defense: if a bundled response slips through as actions-mode with REPLY
		// as the first entry, we still skip the preamble — the REPLY handler's
		// own text generation owns the user-visible reply.
		expect(
			shouldEmitPlannerPreamble({
				text: "checking",
				actions: ["REPLY", "INBOX"],
			}),
		).toBe(false);
	});
});

describe("stripPlannerReplyForSuppressiveActions", () => {
	it("preserves text and strips REPLY when a suppressive action is present", () => {
		const runtime = runtimeWithActions([
			plainAction("REPLY"),
			suppressiveAction("GMAIL_ACTION"),
		]);
		const content: Content = {
			text: "checking your inbox",
			actions: ["REPLY", "GMAIL_ACTION"],
		};

		stripPlannerReplyForSuppressiveActions(runtime, content);

		// REPLY removed so its handler doesn't generate a second message after
		// the suppressive action produces its grounded answer.
		expect(content.actions).toEqual(["GMAIL_ACTION"]);
		// Text retained — the caller surfaces it as a preamble before actions run.
		expect(content.text).toBe("checking your inbox");
	});

	it("is a no-op when no suppressive action is present", () => {
		const runtime = runtimeWithActions([
			plainAction("REPLY"),
			plainAction("PLAIN_ACTION"),
		]);
		const content: Content = {
			text: "hello",
			actions: ["REPLY", "PLAIN_ACTION"],
		};

		stripPlannerReplyForSuppressiveActions(runtime, content);

		expect(content.actions).toEqual(["REPLY", "PLAIN_ACTION"]);
		expect(content.text).toBe("hello");
	});

	it("is a no-op when no actions are present", () => {
		const runtime = runtimeWithActions([suppressiveAction("GMAIL_ACTION")]);
		const content: Content = { text: "standalone", actions: [] };

		stripPlannerReplyForSuppressiveActions(runtime, content);

		expect(content.actions).toEqual([]);
		expect(content.text).toBe("standalone");
	});

	it("keeps REPLY if it is the only action (filteredActions fallback)", () => {
		// Existing behavior: if stripping REPLY would leave the action list
		// empty, keep REPLY. This is a defensive fallback — in practice the
		// suppressive-action check earlier prevents this scenario.
		const runtime = runtimeWithActions([
			plainAction("REPLY"),
			suppressiveAction("GMAIL_ACTION"),
		]);
		const content: Content = {
			text: "retained",
			actions: ["REPLY"],
		};
		// No suppressive action in THIS content, so it's a no-op.
		stripPlannerReplyForSuppressiveActions(runtime, content);
		expect(content.actions).toEqual(["REPLY"]);
		expect(content.text).toBe("retained");
	});
});
