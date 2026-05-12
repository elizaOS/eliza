import { describe, expect, it } from "vitest";
import { buildFailureReplyPrompt } from "../message";

/**
 * Pinned hard rules for the transient-failure reply prompt.
 *
 * BACKGROUND — live regression on Cerebras gpt-oss-120b (2026-05-12):
 * a user asked "what is the SHA of the latest commit on develop in
 * /home/eliza/iqlabs/eliza/eliza ? short sha only". The planner
 * trajectory errored (no stages recorded, finalDecision=error) and the
 * fallback failure-reply path emitted a SHA that appeared in recent
 * conversation context but did not match the actual current SHA.
 *
 * Root cause: the failure prompt contained the line
 *
 *   "If the user already gave a clear command and you can plausibly act,
 *    acknowledge it and offer to take the action directly."
 *
 * which the model read as license to invent an answer from context.
 *
 * Fix: the prompt now explicitly forbids answering the question on the
 * merits during a failure reply — even when the answer looks obvious —
 * because the grounding trajectory never ran. These tests pin the
 * forbid-list so a future "let's make the failure reply more helpful"
 * refactor can't silently re-introduce the hallucination vector.
 */
describe("buildFailureReplyPrompt", () => {
	const RECENT =
		"@e2e: what is the SHA of the latest commit on develop?\n@bot: 7593";

	it("includes the explicit NEVER-answer-on-the-merits rule", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("NEVER answer the user's question on the merits");
		expect(prompt).toContain(
			"The trajectory that would have GROUNDED the answer failed",
		);
	});

	it("enumerates the answer-shaped tokens it must refuse to emit", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		// Must list SHA, count, price, date, status, file path, name —
		// these are the specific identifier-shaped categories the model
		// was previously tempted to fabricate from context.
		expect(prompt).toContain("a SHA");
		expect(prompt).toContain("a count");
		expect(prompt).toContain("a price");
		expect(prompt).toContain("a date");
		expect(prompt).toContain("a status");
		expect(prompt).toContain("a file path");
		expect(prompt).toContain("a name");
	});

	it("does NOT contain the removed 'plausibly act' escape hatch", () => {
		// Regression guard against the exact wording that caused the
		// hallucination. If anyone re-introduces this phrasing the bot
		// can re-hallucinate.
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).not.toContain("plausibly act");
		expect(prompt).not.toContain("take the action directly");
	});

	it("requires the reply to invite a retry", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("Acknowledge that something went wrong");
		expect(prompt).toContain("suggest a retry");
	});

	it("forbids paraphrasing the user's question as if about to answer", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain("Do not paraphrase or echo the user's question");
	});

	it("embeds the recent conversation verbatim for the model to keep voice", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain(RECENT);
		// The recent-conversation block lives below the rules so the
		// rules anchor before the context.
		const ruleIdx = prompt.indexOf("Hard rules:");
		const recentIdx = prompt.indexOf("Recent Conversation:");
		expect(ruleIdx).toBeGreaterThanOrEqual(0);
		expect(recentIdx).toBeGreaterThan(ruleIdx);
	});

	it("preserves the internal-mechanism vocabulary blocklist", () => {
		// The bot's character protects against tech-jargon leaks via this
		// list. Keep it pinned so blanket rewrites of the prompt don't
		// accidentally drop it.
		const prompt = buildFailureReplyPrompt(RECENT);
		for (const term of [
			"planner",
			"action_planner",
			"XML",
			"JSON",
			"schema",
			"prompt",
			"runtime",
		]) {
			expect(prompt).toContain(term);
		}
	});

	it("preserves the punctuation rule (no em-dash / en-dash)", () => {
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt).toContain(
			"Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
		);
	});

	it("does not leak any obvious internal trace into the prompt itself", () => {
		// Catch accidental newlines / markdown formatting that would
		// confuse the model. The prompt should be a clean plain-text
		// instruction block ending with the literal "Reply:" anchor.
		const prompt = buildFailureReplyPrompt(RECENT);
		expect(prompt.endsWith("Reply:")).toBe(true);
		expect(prompt).not.toContain("```");
	});
});
