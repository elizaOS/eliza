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
