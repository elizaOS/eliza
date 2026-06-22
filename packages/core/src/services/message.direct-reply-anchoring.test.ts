import { describe, expect, it } from "vitest";
import type { MessageHandlerResult } from "../types/components";
import type { IAgentRuntime, Memory, State } from "../types/index";
import { directReplyPromptForMessage } from "./message";

/**
 * Regression test for #8877: the direct-reply fast path was answering message
 * N-1 instead of N (off-by-one). Root cause: with the fast path's tiny token
 * budget, a small model anchored on the tail of `recent_context` (the composed
 * state, which ends on the prior user turn) instead of the explicit
 * `user_message:` line. The fix relabels the context as already-answered
 * reference and gives the current message an unambiguous directive lead-in.
 *
 * These assertions lock in that the rendered prompt makes the CURRENT message
 * the unmistakable reply target, regardless of what history precedes it.
 */
function makeRuntime(): IAgentRuntime {
	// getService returns null so resolveOptimizedPromptForRuntime falls back to
	// the baseline instructions verbatim — no optimized-prompt artifact needed.
	return {
		getService: () => null,
	} as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		entityId: "00000000-0000-0000-0000-0000000000aa",
		roomId: "00000000-0000-0000-0000-0000000000bb",
		content: { text },
	} as unknown as Memory;
}

const messageHandler: MessageHandlerResult = {
	processMessage: "RESPOND",
	thought: "Direct private chat fast path.",
	plan: {
		contexts: ["simple"],
		reply: "",
		simple: true,
		requiresTool: false,
	},
};

describe("directReplyPromptForMessage anchoring (#8877)", () => {
	it("makes the current message the directive reply target after history context", () => {
		// recent_context deliberately ends on the PREVIOUS user turn — the exact
		// shape that triggered the off-by-one.
		const state = {
			text: "user: spell the word dog\nassistant: dog\nuser: what is the capital of japan",
		} as unknown as State;
		const message = makeMessage("what is two plus two");

		const prompt = directReplyPromptForMessage({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
		});

		// Baseline rule that forbids re-answering an earlier turn is present.
		expect(prompt).toContain(
			"reply to the final user_message only; recent_context shows earlier turns that are already answered",
		);
		// Context is labelled as already-answered reference, not a fresh prompt.
		expect(prompt).toContain(
			"recent_context (earlier turns, already answered — reference only, do not reply to these):",
		);
		// The current message is the directive target.
		expect(prompt).toContain(
			"Now write your reply to this new message, and only this message:",
		);
		expect(prompt).toContain("user_message: what is two plus two");

		// Ordering: context block → directive lead-in → current user_message.
		const contextIdx = prompt.indexOf("recent_context (earlier turns");
		const directiveIdx = prompt.indexOf("Now write your reply to this new");
		const userMsgIdx = prompt.indexOf("user_message: what is two plus two");
		expect(contextIdx).toBeGreaterThanOrEqual(0);
		expect(directiveIdx).toBeGreaterThan(contextIdx);
		expect(userMsgIdx).toBeGreaterThan(directiveIdx);

		// The directive lead-in sits immediately before the user_message line so
		// the current turn is the most salient, last instruction.
		expect(prompt).toContain(
			"Now write your reply to this new message, and only this message:\nuser_message: what is two plus two",
		);
	});

	it("still anchors the current message when there is no prior context", () => {
		const state = { text: "" } as unknown as State;
		const message = makeMessage("hello there");

		const prompt = directReplyPromptForMessage({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
		});

		// No recent_context block when state is empty (the rules text mentions
		// "recent_context", but the labelled context header must be absent)...
		expect(prompt).not.toContain("recent_context (earlier turns");
		// ...but the current message is still the explicit directive target.
		expect(prompt).toContain(
			"Now write your reply to this new message, and only this message:\nuser_message: hello there",
		);
	});
});
