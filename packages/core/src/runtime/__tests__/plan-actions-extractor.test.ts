import { describe, expect, it } from "vitest";
import { extractPlanActionsFromContent } from "../plan-actions-extractor";

// ---------------------------------------------------------------------------
// Pattern 1: PLAN_ACTIONS(<JSON>) wrapper
// ---------------------------------------------------------------------------

describe("extractPlanActionsFromContent — PLAN_ACTIONS wrapper", () => {
	it("extracts a well-formed wrapper", () => {
		const text = `PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": {
    "task": "Create /tmp/foo.py",
    "agentType": "opencode"
  },
  "thought": "spawning"
})`;
		const result = extractPlanActionsFromContent(text);
		expect(result).toMatchObject({
			action: "TASKS_SPAWN_AGENT",
			parameters: { task: "Create /tmp/foo.py", agentType: "opencode" },
			thought: "spawning",
			recoverySource: "plan-actions-wrapper",
		});
	});

	it("accepts `params` drift instead of `parameters`", () => {
		const text = `PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "params": { "task": "do it", "agentType": "opencode", "approvalPreset": "yolo" }
})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.parameters).toMatchObject({
			task: "do it",
			agentType: "opencode",
		});
	});

	it("accepts single-line wrapper", () => {
		const text = `PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hello"}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("accepts wrapper wrapped in markdown code fence", () => {
		const text =
			'```json\nPLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hi"}})\n```';
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("accepts wrapper wrapped in plain code fence", () => {
		const text = '```\nPLAN_ACTIONS({"action":"LIFE","parameters":{}})\n```';
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("LIFE");
	});

	it("accepts wrapper with whitespace-only surrounding text", () => {
		const text = '  \n  PLAN_ACTIONS({"action":"TODO","parameters":{}})  \n  ';
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TODO");
	});

	it("rejects when prose precedes the wrapper (strict mode)", () => {
		const text =
			'I\'ll call this: PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}})';
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects when prose follows the wrapper (strict mode)", () => {
		const text =
			'PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}}) let me know if this works!';
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("accepts surrounding prose with strict=false", () => {
		const text =
			'Here\'s my call: PLAN_ACTIONS({"action":"TODO","parameters":{}})';
		const result = extractPlanActionsFromContent(text, { strict: false });
		expect(result?.action).toBe("TODO");
	});

	it("rejects multiple PLAN_ACTIONS blocks", () => {
		const text = `PLAN_ACTIONS({"action":"A","parameters":{}})
PLAN_ACTIONS({"action":"B","parameters":{}})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects malformed JSON in wrapper", () => {
		const text = `PLAN_ACTIONS({"action": "TASKS", "parameters": {missing quote})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects wrapper without action field", () => {
		const text = `PLAN_ACTIONS({"thought": "hmm", "parameters": {}})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("handles nested braces in parameters correctly", () => {
		const text = `PLAN_ACTIONS({
  "action": "LIFE",
  "parameters": {
    "data": { "nested": { "deep": true } }
  }
})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("LIFE");
		expect(result?.parameters).toMatchObject({
			data: { nested: { deep: true } },
		});
	});
});

// ---------------------------------------------------------------------------
// Pattern 2: bare JSON object
// ---------------------------------------------------------------------------

describe("extractPlanActionsFromContent — bare action object", () => {
	it("extracts a bare action object with canonical `parameters`", () => {
		const text = `{"action":"TASKS_SPAWN_AGENT","parameters":{"task":"do it","agentType":"opencode"}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.recoverySource).toBe("bare-action-object");
	});

	it("extracts a bare action object with `params` drift", () => {
		const text = `{"action":"TODO","params":{"title":"finish docs"}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TODO");
	});

	it("rejects a HANDLE_RESPONSE envelope (has replyText)", () => {
		const text = `{"shouldRespond":"RESPOND","replyText":"hi","contexts":["simple"]}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects a HANDLE_RESPONSE envelope (has contexts)", () => {
		const text = `{"contexts":["general"],"replyText":"ok"}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects multiple top-level objects", () => {
		const text = `{"action":"A","parameters":{}} {"action":"B","parameters":{}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects bare object with surrounding prose in strict mode", () => {
		const text = `Here is the action: {"action":"REPLY","parameters":{"text":"hi"}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("missing action field → null", () => {
		const text = `{"parameters":{"foo":"bar"}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("accepts empty parameters object", () => {
		const text = `{"action":"IGNORE","parameters":{}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("IGNORE");
		expect(result?.parameters).toEqual({});
	});

	it("accepts missing parameters (defaults to empty object)", () => {
		const text = `{"action":"STOP"}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("STOP");
		expect(result?.parameters).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("extractPlanActionsFromContent — edge cases", () => {
	it("returns null for empty string", () => {
		expect(extractPlanActionsFromContent("")).toBeNull();
	});

	it("returns null for plain prose", () => {
		expect(
			extractPlanActionsFromContent(
				"I'm unable to spawn a sub-agent in this context.",
			),
		).toBeNull();
	});

	it("returns null for unrelated JSON", () => {
		expect(extractPlanActionsFromContent('{"foo":"bar","baz":123}')).toBeNull();
	});

	it("handles trailing comma tolerance: rejects — no JSON5", () => {
		const text = `PLAN_ACTIONS({"action":"TODO","parameters":{"title":"x",}})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("action field with extra whitespace is trimmed", () => {
		const text = `PLAN_ACTIONS({"action":"  REPLY  ","parameters":{}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("<think> prefix before wrapper is rejected in strict mode", () => {
		const text = `<think>Let me call the action</think>
PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});
});
