import { describe, expect, it, vi } from "vitest";
import { plannerTemplate } from "../../prompts/planner";
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
  "action": "functions.MESSAGE",
  "parameters": {
    "operation": "draft_reply",
    "messageId": "gmail:1",
    "body": "Thanks."
  }
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "MESSAGE",
				params: {
					operation: "draft_reply",
					messageId: "gmail:1",
					body: "Thanks.",
				},
			},
		]);
	});

	it("parses top-level tool records embedded before user-facing text", () => {
		const output = parsePlannerOutput(`{
  "tool": "create_todo",
  "arguments": {
    "title": "Pick up dry cleaning",
    "due_date": "2026-05-10"
  }
}Your todo has been added.`);

		expect(output.toolCalls).toEqual([
			{
				name: "create_todo",
				params: {
					title: "Pick up dry cleaning",
					due_date: "2026-05-10",
				},
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

	it("parses bare JSON arrays of action records from text", () => {
		const output = parsePlannerOutput(
			`[{"name":"todo_create","arguments":{"title":"pick up dry cleaning","due":"2026-05-10"}}]`,
		);

		expect(output.toolCalls).toEqual([
			{
				name: "todo_create",
				params: {
					title: "pick up dry cleaning",
					due: "2026-05-10",
				},
			},
		]);
		expect(output.messageToUser).toBeUndefined();
	});

	it("treats non-JSON planner text as a terminal message", () => {
		const output = parsePlannerOutput("Done from the model.");

		expect(output.toolCalls).toEqual([]);
		expect(output.messageToUser).toBe("Done from the model.");
	});

	it("instructs planners to use exposed tools for unresolved current work", () => {
		expect(plannerTemplate).toContain(
			"task is not complete while the user still needs live/current/external data",
		);
		expect(plannerTemplate).toContain(
			"prior attachments, memory, or conversation snippets are not a substitute",
		);
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

	it("retries premature terminal output when a non-terminal tool call is required", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(`{
  "thought": "I can answer directly.",
  "messageToUser": "Looks fine.",
  "toolCalls": []
}`)
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "LOOKUP",
							arguments: { query: "status" },
						},
					],
				}),
			logger: { warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "checked",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Checked.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [
				{
					name: "LOOKUP",
					description: "Lookup current status.",
				},
			],
			requireNonTerminalToolCall: true,
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		const retryParams = runtime.useModel.mock.calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(retryParams.messages?.[1]?.content).toContain(
			"previous planner response was not valid",
		);
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 2 }),
		);
		expect(result.finalMessage).toBe("Checked.");
	});

	it("returns a user-visible failure when required tool retries are exhausted", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "I can answer directly.",
  "messageToUser": "Looks fine.",
  "toolCalls": []
}`,
			),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxPlannerIterations: 1 },
			tools: [
				{
					name: "LOOKUP",
					description: "Lookup current status.",
				},
			],
			requireNonTerminalToolCall: true,
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("continued");
		expect(result.finalMessage).toContain("did not select an available tool");
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				maxPlannerIterations: 1,
			}),
			"Planner exhausted retries before satisfying a required tool call",
		);
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
