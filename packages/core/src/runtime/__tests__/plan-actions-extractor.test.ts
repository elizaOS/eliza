import { describe, expect, it } from "vitest";

import { extractPlanActionsFromContent } from "../plan-actions-extractor";

describe("extractPlanActionsFromContent", () => {
	describe("bare action object shape (what the local engine's GBNF produces)", () => {
		it("parses a well-formed bare action object", () => {
			const text =
				'{"action":"TASKS_SPAWN_AGENT","parameters":{"task":"write /tmp/foo.py","agentType":"opencode"},"thought":"delegating"}';
			const result = extractPlanActionsFromContent(text);
			expect(result).not.toBeNull();
			expect(result?.action).toBe("TASKS_SPAWN_AGENT");
			expect(result?.parameters).toEqual({
				task: "write /tmp/foo.py",
				agentType: "opencode",
			});
			expect(result?.thought).toBe("delegating");
			expect(result?.recoverySource).toBe("bare-action-object");
		});

		it("tolerates fenced JSON", () => {
			const text =
				'```json\n{"action":"REPLY","parameters":{"text":"hi"},"thought":""}\n```';
			const result = extractPlanActionsFromContent(text);
			expect(result?.action).toBe("REPLY");
			expect(result?.parameters).toEqual({ text: "hi" });
			expect(result?.recoverySource).toBe("bare-action-object");
		});

		it("returns null when the object lacks an action field", () => {
			const text = '{"parameters":{"task":"x"},"thought":"y"}';
			expect(extractPlanActionsFromContent(text)).toBeNull();
		});

		it("returns null when parameters is missing (treats as empty object)", () => {
			const text = '{"action":"REPLY"}';
			const result = extractPlanActionsFromContent(text);
			expect(result?.action).toBe("REPLY");
			expect(result?.parameters).toEqual({});
		});

		it("refuses Stage-1 HANDLE_RESPONSE-shaped envelopes", () => {
			// Defensive: a Stage-1 envelope that accidentally reached this
			// parser should NOT be turned into a plan action.
			const text =
				'{"action":"RESPOND","shouldRespond":"RESPOND","contexts":["simple"],"replyText":"hello"}';
			expect(extractPlanActionsFromContent(text)).toBeNull();
		});

		it("refuses Stage-1-shaped envelope with candidateActionNames", () => {
			const text =
				'{"action":"TASKS_SPAWN_AGENT","candidateActionNames":["TASKS_SPAWN_AGENT"],"replyText":"on it"}';
			expect(extractPlanActionsFromContent(text)).toBeNull();
		});
	});

	describe("PLAN_ACTIONS({...}) envelope shape (what hosted gpt-oss-120b emits)", () => {
		it("recovers the call when emitted as message text (#7620)", () => {
			const text = `Sure, I'll delegate that:

PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": { "task": "write /tmp/foo.py that prints hello", "agentType": "opencode" },
  "thought": "user asked for delegation"
})`;
			const result = extractPlanActionsFromContent(text);
			expect(result).not.toBeNull();
			expect(result?.action).toBe("TASKS_SPAWN_AGENT");
			expect(result?.parameters).toEqual({
				task: "write /tmp/foo.py that prints hello",
				agentType: "opencode",
			});
			expect(result?.thought).toBe("user asked for delegation");
			expect(result?.recoverySource).toBe("plan-actions-envelope");
		});

		it("handles whitespace and minimal spacing variants", () => {
			const text =
				'PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"x"},"thought":""})';
			const result = extractPlanActionsFromContent(text);
			expect(result?.action).toBe("REPLY");
			expect(result?.recoverySource).toBe("plan-actions-envelope");
		});

		it("brace-balances correctly when parameters contain nested objects", () => {
			const text = `PLAN_ACTIONS({"action":"COMPLEX","parameters":{"nested":{"a":1,"b":{"c":2}}},"thought":"nested"})`;
			const result = extractPlanActionsFromContent(text);
			expect(result?.action).toBe("COMPLEX");
			expect(result?.parameters).toEqual({ nested: { a: 1, b: { c: 2 } } });
		});

		it("brace-balances correctly when string values contain braces", () => {
			const text = `PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"unbalanced } ignored"},"thought":""})`;
			const result = extractPlanActionsFromContent(text);
			expect(result?.action).toBe("REPLY");
			expect(result?.parameters).toEqual({ text: "unbalanced } ignored" });
		});

		it("returns null when the envelope is incomplete", () => {
			const text = 'PLAN_ACTIONS({"action":"REPLY"';
			expect(extractPlanActionsFromContent(text)).toBeNull();
		});
	});

	describe("input guards", () => {
		it("returns null for null/undefined/empty/non-string input", () => {
			expect(extractPlanActionsFromContent(null)).toBeNull();
			expect(extractPlanActionsFromContent(undefined)).toBeNull();
			expect(extractPlanActionsFromContent("")).toBeNull();
			expect(extractPlanActionsFromContent("   ")).toBeNull();
		});

		it("returns null for plain prose without a recognizable envelope", () => {
			const text = "I'd be happy to help you with that task.";
			expect(extractPlanActionsFromContent(text)).toBeNull();
		});
	});
});
