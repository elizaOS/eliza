import { describe, expect, it } from "vitest";

import { looksLikeRefusal } from "../refusal-detector";

describe("looksLikeRefusal", () => {
	describe("matches the verbatim refusals reported in elizaOS/eliza#7620", () => {
		const verbatim = [
			"I'm unable to spawn a sub-agent in this context. I can create /tmp/foo.py directly with the line: ...",
			"I am unable to spawn a sub-agent in this context. I can create /tmp/foo.py directly with the line: ...",
			"I'm unable to spawn a sub-agent right now — let me know if I can do something else.",
		];
		for (const text of verbatim) {
			it(`matches: "${text.slice(0, 60)}..."`, () => {
				expect(looksLikeRefusal(text)).toBe(true);
			});
		}
	});

	describe("matches common refusal openings", () => {
		const refusals = [
			"I cannot spawn sub-agents from this chat.",
			"I can't run code in this session.",
			"I can not invoke that action right now.",
			"Unfortunately, I cannot help with that.",
			"Sorry, I cannot do that.",
			"Sorry, but I'm unable to delegate this task.",
			"Apologies, I can't run that for you.",
			"I don't have the ability to spawn a sub-agent.",
			"I don't have access to a coding sub-agent in this context.",
			"I don't have the tools to run that.",
			"I don't have permission to delegate this task.",
			"It's not possible for me to spawn a sub-agent here.",
			"I am not able to fire up a coding agent.",
			"As an AI assistant, I cannot spawn sub-processes.",
			"As an AI, I'm unable to write files on your behalf.",
			"Got it — but in this context I cannot spawn sub-agents.",
		];
		for (const text of refusals) {
			it(`matches: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeRefusal(text)).toBe(true);
			});
		}
	});

	describe("does NOT match legitimate acknowledgements", () => {
		const acknowledgements = [
			"On it, spawning a coding sub-agent.",
			"Sure, I'll spawn an opencode sub-agent to create /tmp/foo.py that prints hello.",
			"Got it — delegating to a coding sub-agent.",
			"Working on it.",
			"Spawning a coding sub-agent for the auth refactor.",
			"Spinning up an opencode sub-agent now.",
			"Yes, I can handle that.",
			"Absolutely — kicking off a coding sub-agent.",
			"Let me delegate this to a coding sub-agent.",
			"Looking into it.",
			"Will do.",
			"Coming right up.",
			"hello",
			"hi there",
			"how can I help?",
		];
		for (const text of acknowledgements) {
			it(`does not match: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeRefusal(text)).toBe(false);
			});
		}
	});

	describe("does NOT match incidental 'can't' / 'unable' mid-sentence", () => {
		const mid = [
			"Sure thing — I can't promise it'll work first try but I'll spawn the sub-agent.",
			"Spawning the agent now; let me know if it can't see something it needs.",
			"On it. If the workspace can't be provisioned I'll fall back to a local run.",
			"Got it, the script can't import that yet but I'll fix it in the spawn.",
		];
		for (const text of mid) {
			it(`does not match: "${text.slice(0, 60)}"`, () => {
				expect(looksLikeRefusal(text)).toBe(false);
			});
		}
	});

	describe("guards on empty / short / non-string inputs", () => {
		it("returns false for undefined", () => {
			expect(looksLikeRefusal(undefined)).toBe(false);
		});
		it("returns false for null", () => {
			expect(looksLikeRefusal(null)).toBe(false);
		});
		it("returns false for empty string", () => {
			expect(looksLikeRefusal("")).toBe(false);
		});
		it("returns false for short strings (< 12 chars)", () => {
			expect(looksLikeRefusal("I cannot.")).toBe(false);
		});
		it("returns false for non-string (number)", () => {
			expect(looksLikeRefusal(123 as unknown as string)).toBe(false);
		});
	});
});
