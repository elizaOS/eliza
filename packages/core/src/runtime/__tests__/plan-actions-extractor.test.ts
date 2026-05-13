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
// Pattern 3: OpenAI function-call envelope echoed as content text
// ---------------------------------------------------------------------------

describe("extractPlanActionsFromContent — OpenAI function-call envelope", () => {
	it("extracts {name, arguments:object} shape (most common llama3.1-8b output)", () => {
		// Real example captured from Cerebras llama3.1-8b probe @ 2026-05-13.
		const text = `{"name": "PLAN_ACTIONS", "arguments": {"action": "TASKS_SPAWN_AGENT", "parameters": {"task": "Write /tmp/hello.py", "agentType": "opencode"}, "thought": "Spawn coding sub-agent"}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.parameters).toMatchObject({
			task: "Write /tmp/hello.py",
			agentType: "opencode",
		});
		expect(result?.thought).toBe("Spawn coding sub-agent");
		expect(result?.recoverySource).toBe("openai-function-call");
	});

	it("extracts {name, arguments:string} shape (OpenAI on-wire serialization)", () => {
		// The OpenAI API serializes `arguments` as a string. Some models echo
		// that exact wire format as content.
		const inner = JSON.stringify({
			action: "REPLY",
			parameters: { text: "hello" },
		});
		const text = `{"name":"PLAN_ACTIONS","arguments":${JSON.stringify(inner)}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
		expect(result?.parameters).toMatchObject({ text: "hello" });
	});

	it("extracts {function: {name, arguments}} nested wrapper shape", () => {
		const text = `{"function": {"name": "PLAN_ACTIONS", "arguments": {"action": "TODO", "parameters": {"title": "x"}}}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TODO");
		expect(result?.parameters).toMatchObject({ title: "x" });
	});

	it("accepts `params` drift inside the function-call arguments", () => {
		const text = `{"name":"PLAN_ACTIONS","arguments":{"action":"TASKS_SPAWN_AGENT","params":{"task":"do it","agentType":"opencode"}}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.parameters).toMatchObject({ task: "do it" });
	});

	it("accepts <think> prefix before function-call shape", () => {
		const text = `<think>route to spawn agent</think>
{"name":"PLAN_ACTIONS","arguments":{"action":"TASKS_SPAWN_AGENT","parameters":{"task":"x"}}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.recoverySource).toBe("openai-function-call");
	});

	it("accepts code-fenced function-call shape", () => {
		const text = `\`\`\`json\n{"name":"PLAN_ACTIONS","arguments":{"action":"REPLY","parameters":{"text":"hi"}}}\n\`\`\``;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("rejects function-call shape with wrong tool name (HANDLE_RESPONSE envelopes are a different pipeline)", () => {
		const text = `{"name":"HANDLE_RESPONSE","arguments":{"action":"REPLY","parameters":{}}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects function-call shape with arbitrary other tool name", () => {
		const text = `{"name":"some_other_tool","arguments":{"action":"REPLY","parameters":{}}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects function-call shape with non-JSON arguments string", () => {
		const text = `{"name":"PLAN_ACTIONS","arguments":"not really json {"}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects function-call shape with missing arguments", () => {
		const text = `{"name":"PLAN_ACTIONS"}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects function-call shape with arguments missing action field", () => {
		const text = `{"name":"PLAN_ACTIONS","arguments":{"parameters":{}}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects multiple function-call objects in sequence (ambiguous)", () => {
		const text = `{"name":"PLAN_ACTIONS","arguments":{"action":"A","parameters":{}}} {"name":"PLAN_ACTIONS","arguments":{"action":"B","parameters":{}}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("rejects function-call shape with surrounding prose in strict mode", () => {
		const text = `Here's the call: {"name":"PLAN_ACTIONS","arguments":{"action":"REPLY","parameters":{}}}`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
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

	it("<think> prefix before wrapper is stripped and the wrapper is extracted (strict mode)", () => {
		const text = `<think>Let me call the action</think>
PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.recoverySource).toBe("plan-actions-wrapper");
	});

	it("multi-line <think> reasoning block is stripped before extraction", () => {
		const text = `<think>
The user wants to spawn a sub-agent.
The right action is TASKS_SPAWN_AGENT with agentType=opencode.
</think>

PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": { "task": "do thing", "agentType": "opencode" }
})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TASKS_SPAWN_AGENT");
		expect(result?.parameters).toMatchObject({ agentType: "opencode" });
	});

	it("dangling </think> with no opening tag is stripped (truncated reasoning)", () => {
		// Reasoning models occasionally drop the opening <think> if the stream
		// was joined post-truncate — handle the bare closing tag too.
		const text = `internal reasoning that got truncated</think>
PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hi"}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("orphan opening <think> with no close is stripped (truncated mid-stream)", () => {
		// Sometimes the reverse: opening tag landed but the closer was eaten by
		// max_tokens. The first sweep removes complete blocks, the third strips
		// the dangling open.
		const text = `PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"ok"}})<think>more reasoning would have gone here`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("stray /no_think marker is stripped (Qwen-style reasoning-suppression)", () => {
		const text = `/no_think PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hello"}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("multiple stacked <think> blocks are all stripped", () => {
		const text = `<think>step 1</think><think>step 2</think>
PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hi"}})`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("REPLY");
	});

	it("real prose (not reasoning tags) before wrapper is still rejected in strict mode", () => {
		// Regression guard: only <think>/no_think are stripped. Free-form prose
		// before the wrapper still rejects so "here's how you'd call it: ..." is
		// not silently dispatched.
		const text = `I'll go ahead and call: PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}})`;
		expect(extractPlanActionsFromContent(text)).toBeNull();
	});

	it("reasoning prefix before a bare action object is also extracted", () => {
		const text = `<think>routing to TODO</think>
{"action":"TODO","params":{"title":"finish docs"}}`;
		const result = extractPlanActionsFromContent(text);
		expect(result?.action).toBe("TODO");
		expect(result?.recoverySource).toBe("bare-action-object");
	});
});
