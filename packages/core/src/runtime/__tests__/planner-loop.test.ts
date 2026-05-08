import { describe, expect, it, vi } from "vitest";
import { type ChatMessage, ModelType } from "../../types/model";
import { TrajectoryLimitExceeded } from "../limits";
import { parsePlannerOutput, runPlannerLoop } from "../planner-loop";
import type { TrajectoryRecorder } from "../trajectory-recorder";

describe("v5 planner loop skeleton", () => {
	it("parses planner tool calls", () => {
		const output = parsePlannerOutput(`{
  "thought": "Fetch state.",
  "toolCalls": [
    {
      "name": "LOOKUP",
      "args": { "query": "status" }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "LOOKUP",
				params: { query: "status" },
			},
		]);
	});

	it("parses OpenAI-compatible function tool call records from text", () => {
		const output = parsePlannerOutput(`{
  "toolCalls": [
    {
      "function": "AUTOFILL",
      "arguments": { "domain": "github.com", "field": "password" }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "AUTOFILL",
				params: { domain: "github.com", field: "password" },
			},
		]);
	});

	it("parses function-prefixed action records with parameters from text", () => {
		const output = parsePlannerOutput(`{
  "action": "functions.DRAFT_REPLY",
  "parameters": {
    "messageId": "gmail:1",
    "body": "Thanks."
  }
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "DRAFT_REPLY",
				params: { messageId: "gmail:1", body: "Thanks." },
			},
		]);
	});

	it("parses fenced JSON arrays of tool calls from markdown output", () => {
		const output = parsePlannerOutput(`**Tool Calls**

\`\`\`json
[
  {
    "name": "COMPUTER_USE",
    "arguments": { "subaction": "screenshot" }
  }
]
\`\`\`
`);

		expect(output.toolCalls).toEqual([
			{
				name: "COMPUTER_USE",
				params: { subaction: "screenshot" },
			},
		]);
	});

	it("calls ACTION_PLANNER, executes the first queued tool, then evaluates", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "LOOKUP",
						arguments: { query: "status" },
					},
					{
						id: "call-2",
						name: "FOLLOW_UP",
						arguments: { id: "next" },
					},
				],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "all good",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [
					{
						id: "provider:RECENT_MESSAGES",
						type: "provider",
						name: "RECENT_MESSAGES",
						text: "Recent: user asked for status.",
					},
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: { text: "Check status." },
						},
					},
				],
			},
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.ACTION_PLANNER,
			expect.objectContaining({
				messages: expect.any(Array),
				promptSegments: expect.any(Array),
			}),
			undefined,
		);
		const plannerParams = runtime.useModel.mock.calls[0][1];
		// Wire-shape contract: planner emits ONLY `messages`. No legacy
		// `prompt: string` is sent on v5 calls — adapters consume `messages`.
		expect(plannerParams.prompt).toBeUndefined();
		expect(plannerParams.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(plannerParams.messages[0].content).toContain("planner_stage:");
		expect(plannerParams.messages[0].content).toContain("agent_name: Eliza");
		// Provider events render as `provider:NAME:\n<text>` (label + content).
		// The previous shape baked an extra `provider: <name>` line into the
		// content body, doubling up with the label. The new render drops that.
		expect(plannerParams.messages[1].content).toContain(
			"provider:RECENT_MESSAGES:",
		);
		expect(plannerParams.messages[1].content).toContain("Check status.");
		expect(plannerParams.messages[1].content).not.toMatch(
			/provider:RECENT_MESSAGES:\nprovider: RECENT_MESSAGES/,
		);
		// After the stacking fix, trajectory steps are conveyed as assistant/tool
		// message pairs, NOT as a JSON dump in the user message. The user message
		// (messages[1]) should no longer contain "trajectory:\n[".
		expect(plannerParams.messages[1].content).not.toMatch(/^trajectory:\n\[/);
		expect(plannerParams.providerOptions.eliza.modelInputBudget).toMatchObject({
			reserveTokens: 10_000,
			shouldCompact: false,
		});
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 1 }),
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	it("evaluates terminal-only planner output without executing tools", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "Done.",
  "messageToUser": "Final answer.",
  "toolCalls": []
}`,
			),
		};
		const executeToolCall = vi.fn();
		const evaluate = vi.fn();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.finalMessage).toBe("Final answer.");
	});

	it("does not finish with terminal planner text after tool work when the evaluator asks to continue", async () => {
		let plannerCallCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				plannerCallCount++;
				if (plannerCallCount === 1) {
					return {
						text: "",
						toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
					};
				}
				if (plannerCallCount === 2) {
					return {
						text: "We need to call FOLLOW_UP now: to=functions.FOLLOW_UP",
						toolCalls: [],
					};
				}
				return {
					text: "",
					toolCalls: [{ id: "call-2", name: "FOLLOW_UP", arguments: {} }],
				};
			}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "tool ok",
		}));
		let evaluationCount = 0;
		const evaluate = vi.fn(async () => {
			evaluationCount++;
			if (evaluationCount < 3) {
				return {
					success: false,
					decision: "CONTINUE" as const,
					thought: "More tool work remains.",
				};
			}
			return {
				success: true,
				decision: "FINISH" as const,
				thought: "Done.",
				messageToUser: "Done.",
			};
		});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(executeToolCall).toHaveBeenLastCalledWith(
			{ id: "call-2", name: "FOLLOW_UP", params: {} },
			expect.objectContaining({ iteration: 3 }),
		);
		expect(result.finalMessage).toBe("Done.");
		expect(result.finalMessage).not.toContain("to=functions");
	});

	it("throws when the same tool failure repeats beyond the configured limit", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "boom",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Retry.",
		}));

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall,
				evaluate,
			}),
		).rejects.toBeInstanceOf(TrajectoryLimitExceeded);
	});

	it("compacts old assistant/tool suffixes when the planner input crosses the budget threshold", async () => {
		const capturedMessages: ChatMessage[][] = [];
		const longPayload = `generated file content: ${"x".repeat(20_000)}`;
		let plannerCallCount = 0;
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				const messages =
					(params as { messages?: ChatMessage[] }).messages ?? [];
				capturedMessages.push(JSON.parse(JSON.stringify(messages)));
				plannerCallCount++;
				if (plannerCallCount === 1) {
					return {
						text: "",
						toolCalls: [{ id: "call-1", name: "GENERATE", arguments: {} }],
					};
				}
				return {
					text: "",
					toolCalls: [
						{
							id: "call-final",
							name: "REPLY",
							arguments: { text: "done" },
						},
					],
				};
			}),
			logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		};
		const recordStage = vi.fn(async () => undefined);
		const recorder = {
			recordStage,
		} as unknown as TrajectoryRecorder;

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: {
				contextWindowTokens: 2_000,
				compactionReserveTokens: 500,
				compactionKeepSteps: 0,
			},
			recorder,
			trajectoryId: "trajectory-1",
			executeToolCall: vi.fn(async () => ({
				success: true,
				text: longPayload,
			})),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Continue after generated content.",
			})),
		});

		expect(plannerCallCount).toBe(2);
		const secondCall = capturedMessages[1];
		if (!secondCall) throw new Error("Expected a second planner call");
		const secondPayload = JSON.stringify(secondCall);
		expect(secondPayload).toContain("compaction");
		expect(secondPayload).toContain("GENERATE success");
		expect(secondPayload).not.toContain("x".repeat(1_000));

		const recordedKinds = recordStage.mock.calls.map((call) => call[1]?.kind);
		expect(recordedKinds).toContain("compaction");
		expect(recordedKinds).toContain("planner");
	});
});
