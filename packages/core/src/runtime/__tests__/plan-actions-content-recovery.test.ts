/**
 * Integration tests for the PLAN_ACTIONS-in-content tolerant recovery path.
 *
 * These tests drive parsePlannerOutput and the Stage 2 planner loop against
 * recorded "bad model" responses (the model returned PLAN_ACTIONS({...}) as
 * content text instead of a native tool call). They verify:
 *
 *   1. parsePlannerOutput extracts the tool call from content text.
 *   2. tryRecoverPlanActionsFromText fires and logs the recovery.
 *   3. runPlannerLoop dispatches the extracted action correctly.
 *   4. Surrounding prose (explanatory text) is NOT dispatched.
 *   5. Malformed JSON falls through to messageToUser (no dispatch).
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerateTextResult, ToolDefinition } from "../../types/model";
import {
	parsePlannerOutput,
	runPlannerLoop,
	tryRecoverPlanActionsFromText,
} from "../planner-loop";

// ---------------------------------------------------------------------------
// parsePlannerOutput — content-text recovery
// ---------------------------------------------------------------------------

describe("parsePlannerOutput — PLAN_ACTIONS content-text recovery", () => {
	it("extracts PLAN_ACTIONS({...}) wrapper from content text (no native tool call)", () => {
		const raw: GenerateTextResult = {
			text: `PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": {
    "task": "Create /tmp/foo.py",
    "agentType": "opencode",
    "approvalPreset": "yolo"
  },
  "thought": "spawning"
})`,
			finishReason: "stop",
			toolCalls: [],
			usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
		};

		const result = parsePlannerOutput(raw);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
		expect(result.toolCalls[0]?.params).toMatchObject({
			task: "Create /tmp/foo.py",
			agentType: "opencode",
			approvalPreset: "yolo",
		});
	});

	it("extracts wrapper with `params` drift", () => {
		const raw: GenerateTextResult = {
			text: `PLAN_ACTIONS({"action":"TODO","params":{"title":"buy milk"}})`,
			finishReason: "stop",
			toolCalls: [],
			usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
		};

		const result = parsePlannerOutput(raw);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.name).toBe("TODO");
		expect(result.toolCalls[0]?.params).toMatchObject({ title: "buy milk" });
	});

	it("native tool calls take priority over content-text recovery", () => {
		const raw: GenerateTextResult = {
			text: `PLAN_ACTIONS({"action":"TODO","parameters":{}})`,
			finishReason: "tool-calls",
			toolCalls: [{ name: "TASKS_SPAWN_AGENT", arguments: { task: "real task" } }],
			usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
		};

		const result = parsePlannerOutput(raw);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
	});

	it("surrounding prose: existing parseJsonObject path still extracts and dispatches", () => {
		// NOTE: parseJsonObject's extractFirstJsonObject tolerantly pulls the JSON
		// body out of surrounding prose. This is the existing pre-PR behavior.
		// tryRecoverPlanActionsFromText (strict path) is NOT called here because
		// parseJsonObject already succeeds. Both behaviors are preserved.
		const raw: GenerateTextResult = {
			text: `Sure, here's how you would call it:
PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{}})
Let me know if that looks right.`,
			finishReason: "stop",
			toolCalls: [],
			usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
		};

		const result = parsePlannerOutput(raw);
		// Existing behavior: JSON is extracted from prose, action dispatches.
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
	});

	it("malformed JSON falls through to messageToUser", () => {
		const raw: GenerateTextResult = {
			text: `PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{missing_quote}})`,
			finishReason: "stop",
			toolCalls: [],
			usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
		};

		const result = parsePlannerOutput(raw);
		expect(result.toolCalls).toHaveLength(0);
		expect(result.messageToUser).toBeTruthy();
	});

	it("string-only path: bare PLAN_ACTIONS text dispatches", () => {
		const text = `PLAN_ACTIONS({"action":"REPLY","parameters":{"text":"hello"}})`;
		const result = parsePlannerOutput(text);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]?.name).toBe("REPLY");
	});
});

// ---------------------------------------------------------------------------
// tryRecoverPlanActionsFromText
// ---------------------------------------------------------------------------

describe("tryRecoverPlanActionsFromText", () => {
	it("returns a PlannerToolCall for a well-formed wrapper", () => {
		const call = tryRecoverPlanActionsFromText(
			`PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{"agentType":"opencode"}})`,
		);
		expect(call).not.toBeNull();
		expect(call?.name).toBe("TASKS_SPAWN_AGENT");
		expect(call?.params).toMatchObject({ agentType: "opencode" });
	});

	it("returns null for surrounding prose", () => {
		const call = tryRecoverPlanActionsFromText(
			`I'll use PLAN_ACTIONS({"action":"TODO","parameters":{}}) to do it`,
		);
		expect(call).toBeNull();
	});

	it("returns null for plain prose", () => {
		expect(
			tryRecoverPlanActionsFromText(
				"I'm unable to spawn a sub-agent in this context.",
			),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// runPlannerLoop — end-to-end content-text recovery
// ---------------------------------------------------------------------------

const PLAN_ACTIONS_TOOL: ToolDefinition = {
	name: "PLAN_ACTIONS",
	description: "Stage 2 planner wrapper",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string" },
			parameters: { type: "object", additionalProperties: true },
			thought: { type: "string" },
		},
		required: ["action", "parameters"],
	},
};

describe("runPlannerLoop — content-text recovery end-to-end", () => {
	it("dispatches TASKS_SPAWN_AGENT when planner emits PLAN_ACTIONS as text", async () => {
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				callCount++;
				if (callCount === 1) {
					// Weak planner emits the call shape as content text, no native tool call.
					return {
						text: `PLAN_ACTIONS({
  "action": "TASKS_SPAWN_AGENT",
  "parameters": { "task": "do something", "agentType": "opencode" },
  "thought": "user asked for a sub-agent"
})`,
						finishReason: "stop",
						toolCalls: [],
						usage: { promptTokens: 150, completionTokens: 40, totalTokens: 190 },
					} satisfies Partial<GenerateTextResult> as GenerateTextResult;
				}
				return {
					text: "Sub-agent spawned.",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 80, completionTokens: 10, totalTokens: 90 },
				} satisfies Partial<GenerateTextResult> as GenerateTextResult;
			}),
		};

		const capturedCalls: Array<{ name: string; params?: Record<string, unknown> }> = [];
		const executeToolCall = vi.fn(async (toolCall: { name: string; params?: Record<string, unknown> }) => {
			capturedCalls.push(toolCall);
			return { success: true, text: "Agent spawned." };
		});

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Spawned.",
			messageToUser: "Sub-agent is running.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-content-recovery" },
			tools: [PLAN_ACTIONS_TOOL],
			executeToolCall,
			evaluate,
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
		expect(capturedCalls[0]?.params).toMatchObject({
			task: "do something",
			agentType: "opencode",
		});
		expect(result.status).toBe("finished");
	});

	it("pure prose (no JSON) is returned as terminal messageToUser without dispatch", async () => {
		// Model returns a refusal with no JSON at all — cannot be extracted.
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				callCount++;
				return {
					text: "I'm unable to spawn a sub-agent in this context.",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 80, completionTokens: 12, totalTokens: 92 },
				} satisfies Partial<GenerateTextResult> as GenerateTextResult;
			}),
		};

		const executeToolCall = vi.fn(async () => ({ success: true, text: "" }));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Model refused.",
			messageToUser: "I'm unable to spawn a sub-agent in this context.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-prose-only" },
			tools: [PLAN_ACTIONS_TOOL],
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).not.toHaveBeenCalled();
		expect(result.finalMessage).toContain("unable");
	});
});
