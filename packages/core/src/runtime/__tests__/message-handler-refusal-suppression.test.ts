/**
 * Refusal-suppression regression for `parseMessageHandlerOutput`.
 *
 * The fix for elizaOS/eliza#7620 — Cerebras-hosted `gpt-oss-120b` and
 * `qwen-3-235b-a22b-instruct-2507` emit identical refusal text in Stage-1
 * `replyText` even on turns whose `contexts` / `candidateActions` route to
 * the planner. The runtime previously shipped that refusal to the user. We
 * blank `plan.reply` when:
 *
 *   (a) `looksLikeRefusal(replyText)` matches, AND
 *   (b) the turn routes to a non-simple context OR populates `candidateActions`
 *
 * Refusals on the simple path are left intact (model may legitimately
 * decline an unsafe request).
 */

import { describe, expect, it } from "vitest";

import { parseMessageHandlerOutput } from "../message-handler";

describe("parseMessageHandlerOutput — refusal suppression on the planning path (#7620)", () => {
	it("blanks plan.reply when refusal text routes to a non-simple context", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["tasks"],
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			replyText:
				"I'm unable to spawn a sub-agent in this context. I can create /tmp/foo.py directly with the line: print('hello')",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result).not.toBeNull();
		expect(result?.plan.contexts).toEqual(["tasks"]);
		expect(result?.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
		// The refusal must have been suppressed.
		expect(result?.plan.reply).toBe("");
	});

	it("blanks plan.reply when refusal text rides on candidateActionNames even with empty contexts", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: [],
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			replyText: "I cannot delegate that in this session.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("blanks plan.reply for the second Cerebras refusal variant from #7620", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["code"],
			replyText:
				"I am unable to spawn a sub-agent in this context. I can create /tmp/foo.py directly with the line: print('hello')",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("preserves plan.reply on the simple path (refusal may be legitimate)", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			replyText: "I cannot help with that request.",
		});
		const result = parseMessageHandlerOutput(wire);
		// Simple path: caller-visible refusal stays — Stage-1 IS the reply.
		expect(result?.plan.reply).toBe("I cannot help with that request.");
	});

	it("preserves plan.reply when the model emits a normal acknowledgement on the planning path", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["tasks"],
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			replyText: "On it — spawning a coding sub-agent.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("On it — spawning a coding sub-agent.");
	});

	it("preserves plan.reply when no plan-context or candidateActions are present (pure shouldRespond=IGNORE-style)", () => {
		const wire = JSON.stringify({
			shouldRespond: "IGNORE",
			contexts: [],
			replyText: "I cannot do that.",
		});
		const result = parseMessageHandlerOutput(wire);
		// No planning path → no suppression. Caller's downstream routing
		// handles IGNORE explicitly anyway.
		expect(result?.plan.reply).toBe("I cannot do that.");
	});
});

describe("parseMessageHandlerOutput — training-cutoff-leak suppression on the planning path", () => {
	it("blanks plan.reply when a cutoff leak routes to a non-simple context", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["general"],
			candidateActionNames: ["WEB_FETCH"],
			replyText:
				"As of my training data, the latest release is 18.2 — let me check for newer info.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("blanks plan.reply for a cutoff leak riding on candidateActionNames with empty contexts", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: [],
			candidateActionNames: ["WEB_FETCH"],
			replyText:
				"My knowledge cutoff is 2023, so I can't be sure that's current.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("preserves a normal answer that merely mentions years (no model-internals leak)", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["general"],
			candidateActionNames: ["WEB_FETCH"],
			replyText: "Sure — pulling the latest figures for 2023 through 2026 now.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe(
			"Sure — pulling the latest figures for 2023 through 2026 now.",
		);
	});

	it("preserves a cutoff leak on the simple path (Stage-1 IS the reply there)", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			replyText: "As of my training data, that hasn't shipped yet.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe(
			"As of my training data, that hasn't shipped yet.",
		);
	});
});

describe("parseMessageHandlerOutput — fabricated-moderation suppression on the planning path", () => {
	it("blanks plan.reply when a fabricated-moderation claim routes to a non-simple context", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["general"],
			candidateActionNames: ["WEB_FETCH"],
			replyText:
				"Your request was flagged as hateful, so I'm blocked from answering.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("blanks plan.reply for a fabricated content-policy claim with empty contexts", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: [],
			candidateActionNames: ["TASKS_SPAWN_AGENT"],
			replyText: "That violates our usage policies.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("");
	});

	it("preserves a genuine runtime-error description on the planning path", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["general"],
			candidateActionNames: ["WEB_FETCH"],
			replyText: "The request was blocked by CORS — trying the API origin now.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe(
			"The request was blocked by CORS — trying the API origin now.",
		);
	});

	it("preserves a genuine runtime-error description when phrased as the user's request", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["general"],
			candidateActionNames: ["WEB_FETCH"],
			replyText:
				"Your request was blocked by CORS — trying the API origin now.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe(
			"Your request was blocked by CORS — trying the API origin now.",
		);
	});

	it("preserves a fabricated-moderation reply on the simple path (model may decline there)", () => {
		const wire = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			replyText: "My content filter prevented this.",
		});
		const result = parseMessageHandlerOutput(wire);
		expect(result?.plan.reply).toBe("My content filter prevented this.");
	});
});
