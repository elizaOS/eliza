import { describe, expect, it, vi } from "vitest";
import { plannerTemplate } from "../../prompts/planner";
import { type ChatMessage, ModelType } from "../../types/model";
import { TrajectoryLimitExceeded } from "../limits";
import { parsePlannerOutput, runPlannerLoop } from "../planner-loop";
import type { RecordedStage, TrajectoryRecorder } from "../trajectory-recorder";

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

	it("parses local strict planner JSON as a tool call", () => {
		const output = parsePlannerOutput(
			`{"action":"SEND_MESSAGE","parameters":{"channelId":"c1","text":"hi"},"thought":"replying"}`,
		);

		expect(output.thought).toBe("replying");
		expect(output.toolCalls).toEqual([
			{
				name: "SEND_MESSAGE",
				params: { channelId: "c1", text: "hi" },
			},
		]);
	});

	it("preserves primitive planner parameters for enum short-form expansion", () => {
		const output = parsePlannerOutput(
			`{"action":"SET_MODE","parameters":"fast","thought":"switching"}`,
		);

		expect(output.toolCalls).toEqual([
			{
				name: "SET_MODE",
				params: { parameters: "fast" },
			},
		]);
	});

	it("treats non-JSON planner text as a terminal message", () => {
		const output = parsePlannerOutput("Done from the model.");

		expect(output.toolCalls).toEqual([]);
		expect(output.messageToUser).toBe("Done from the model.");
	});

	it("recovers a non-terminal call the native extraction dropped after REPLY", () => {
		// gpt-oss narrated two `{type, args}` objects in the text channel, but
		// the provider's native extraction only surfaced the first — the
		// terminal REPLY ack — so the real action would otherwise be lost.
		const output = parsePlannerOutput({
			text:
				'{"type":"REPLY","args":{"text":"On it."}}\n' +
				'{"type":"TASKS_SPAWN_AGENT","args":{"action":"spawn_agent","agentType":"opencode"}}',
			toolCalls: [{ id: "tc1", name: "REPLY", arguments: { text: "On it." } }],
		});

		expect(output.toolCalls.map((call) => call.name)).toEqual([
			"REPLY",
			"TASKS_SPAWN_AGENT",
		]);
		expect(output.toolCalls[1].params).toEqual({
			action: "spawn_agent",
			agentType: "opencode",
		});
		// The text was tool-call JSON, not prose — the reply comes from the
		// REPLY call, never the raw JSON blob.
		expect(output.messageToUser).toBe("On it.");
	});

	it("does not duplicate a call present in both the native and text channels", () => {
		const output = parsePlannerOutput({
			text: '{"type":"TASKS_SPAWN_AGENT","args":{"action":"spawn_agent"}}',
			toolCalls: [
				{
					id: "tc1",
					name: "TASKS_SPAWN_AGENT",
					arguments: { action: "spawn_agent" },
				},
			],
		});

		expect(output.toolCalls.map((call) => call.name)).toEqual([
			"TASKS_SPAWN_AGENT",
		]);
	});

	it("preserves same-name recovered calls when their parameters differ", () => {
		const output = parsePlannerOutput({
			text:
				'{"type":"WRITE_FILE","args":{"path":"a.txt","contents":"a"}}' +
				'{"type":"WRITE_FILE","args":{"path":"b.txt","contents":"b"}}',
			toolCalls: [
				{
					id: "tc1",
					name: "WRITE_FILE",
					arguments: { path: "a.txt", contents: "a" },
				},
			],
		});

		expect(
			output.toolCalls.map((call) => ({
				name: call.name,
				params: call.params,
			})),
		).toEqual([
			{
				name: "WRITE_FILE",
				params: { path: "a.txt", contents: "a" },
			},
			{
				name: "WRITE_FILE",
				params: { path: "b.txt", contents: "b" },
			},
		]);
	});

	it("recovers concatenated bare-object calls from a JSON string", () => {
		const output = parsePlannerOutput(
			'{"type":"REPLY","args":{"text":"On it."}}' +
				'{"type":"TASKS_SPAWN_AGENT","args":{"action":"spawn_agent"}}',
		);

		expect(output.toolCalls.map((call) => call.name)).toEqual([
			"REPLY",
			"TASKS_SPAWN_AGENT",
		]);
	});

	it("instructs planners to use exposed tools for unresolved current work", () => {
		expect(plannerTemplate).toContain(
			"incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try",
		);
		expect(plannerTemplate).toContain(
			"attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now",
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

	it("applies the derived per-model reserve when no reserve override is configured", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "Done.",
  "messageToUser": "Final answer.",
  "toolCalls": []
}`,
			),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: {
				contextWindowModelName: "gpt-oss-120b",
			},
		});

		const plannerParams = runtime.useModel.mock.calls[0]?.[1];
		expect(plannerParams?.providerOptions.eliza.modelInputBudget).toMatchObject(
			{
				contextWindowTokens: 131_000,
				reserveTokens: 26_200,
				compactionThresholdTokens: 104_800,
				resolvedModelKey: "gpt-oss-120b",
			},
		);
	});

	it("keeps explicit compactionReserveTokens overrides with a model lookup", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "Done.",
  "messageToUser": "Final answer.",
  "toolCalls": []
}`,
			),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: {
				contextWindowModelName: "gpt-oss-120b",
				compactionReserveTokens: 5_000,
			},
		});

		const plannerParams = runtime.useModel.mock.calls[0]?.[1];
		expect(plannerParams?.providerOptions.eliza.modelInputBudget).toMatchObject(
			{
				contextWindowTokens: 131_000,
				reserveTokens: 5_000,
				compactionThresholdTokens: 126_000,
				resolvedModelKey: "gpt-oss-120b",
			},
		);
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

	it("retries planner calls to tools that are not exposed this turn", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "bad-call",
							name: "GET_PRICE",
							arguments: { symbol: "BTC" },
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "SHELL",
							arguments: { command: "curl -s https://example.com/btc" },
						},
					],
				}),
			logger: { warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "btc price",
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
					name: "SHELL",
					description: "Run a shell command.",
				},
			],
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		const retryParams = runtime.useModel.mock.calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(retryParams.messages?.[1]?.content).toContain(
			"unavailable_tool_calls",
		);
		expect(retryParams.messages?.[1]?.content).toContain("GET_PRICE");
		expect(retryParams.messages?.[1]?.content).toContain("SHELL");
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(executeToolCall).toHaveBeenCalledWith(
			{
				id: "call-1",
				name: "SHELL",
				params: { command: "curl -s https://example.com/btc" },
			},
			expect.objectContaining({ iteration: 2 }),
		);
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				invalidToolCalls: ["GET_PRICE"],
				iteration: 1,
			}),
			"Planner called unavailable tools; retrying without executing them",
		);
		expect(result.finalMessage).toBe("Checked.");
	});

	it("bounds repeated unavailable planner tool retries even without usage metadata", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "bad-call",
						name: "GET_PRICE",
						arguments: { symbol: "BTC" },
					},
				],
			})),
			logger: { warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "should not execute",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Done.",
		}));

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [
					{
						name: "SHELL",
						description: "Run a shell command.",
					},
				],
				executeToolCall,
				evaluate,
				config: { maxUnavailableToolCallRetries: 1 },
			}),
		).rejects.toMatchObject({
			kind: "unavailable_tool_calls",
			max: 1,
			observed: 2,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(executeToolCall).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
	});

	it("replans once when a failed tool is finished without a user-visible message", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "SHELL",
							arguments: { command: "curl https://stale.example.invalid" },
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-2",
							name: "SHELL",
							arguments: { command: "curl https://backup.example.com" },
						},
					],
				}),
		};
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: DNS lookup failed",
			})
			.mockResolvedValueOnce({
				success: true,
				text: "backup source returned a result",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The first lookup failed, but I forgot to include a reply.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				thought: "Done.",
				messageToUser: "The backup source returned a result.",
			});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		const retryParams = runtime.useModel.mock.calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(retryParams.messages?.[1]?.content).toContain(
			"silent_failed_finish",
		);
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(executeToolCall).toHaveBeenLastCalledWith(
			{
				id: "call-2",
				name: "SHELL",
				params: { command: "curl https://backup.example.com" },
			},
			expect.objectContaining({ iteration: 2 }),
		);
		expect(result.finalMessage).toBe("The backup source returned a result.");
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

	it("throws TrajectoryLimitExceeded(trajectory_token_budget) when cumulative prompt tokens exceed config.maxTrajectoryPromptTokens", async () => {
		// Each planner call reports 60_000 prompt tokens. With a 100_000
		// budget the loop should survive call 1 (60k) and abort on call 2
		// (cumulative 120k > 100k) before tool execution recurses.
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
				usage: {
					promptTokens: 60_000,
					completionTokens: 100,
					totalTokens: 60_100,
				},
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "ok",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Keep going.",
		}));

		let thrown: unknown;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxTrajectoryPromptTokens: 100_000 },
				executeToolCall,
				evaluate,
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(TrajectoryLimitExceeded);
		expect((thrown as TrajectoryLimitExceeded).kind).toBe(
			"trajectory_token_budget",
		);
		// Bounded at the call that crossed the line — 2 model calls, not 3+.
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("does not fire trajectory_token_budget when usage stays under the limit", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "done.",
				toolCalls: [],
				messageToUser: "done.",
				usage: {
					promptTokens: 1_000,
					completionTokens: 50,
					totalTokens: 1_050,
				},
			})),
		};
		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxTrajectoryPromptTokens: 100_000 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).resolves.toBeDefined();
	});

	it("tolerates missing usage on the model response (back-compat with older adapters)", async () => {
		// Some adapter shims emit no `usage` field. The token guard should
		// silently no-op rather than crash the loop.
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "done.",
				toolCalls: [],
				messageToUser: "done.",
				// no usage field
			})),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTrajectoryPromptTokens: 100 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});
		expect(result).toBeDefined();
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

	it("does not count different failed tool parameters as the same repeated failure", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "SHELL",
							arguments: { command: "curl https://stale.example.invalid" },
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-2",
							name: "SHELL",
							arguments: { command: "curl https://backup.example.invalid" },
						},
					],
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "command_failed: command exited with code 1",
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "Try a different source.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "No source worked.",
				messageToUser: "I could not retrieve that from the available sources.",
			});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxRepeatedFailures: 1 },
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(
			"I could not retrieve that from the available sources.",
		);
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
		const recorder: TrajectoryRecorder = {
			startTrajectory: vi.fn(() => "trajectory-1"),
			recordStage,
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};

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

describe("v5 planner loop — evaluator gate", () => {
	// Conservative gate: when a successful tool drained the queue and the most
	// recent planner output supplied an EXPLICIT `messageToUser` field, the
	// planner loop synthesizes a FINISH evaluator output and skips the
	// evaluator's full LLM call. The six tests below pin the fire/withhold
	// contract — including the discriminator that native-mode tool-call returns
	// (which fall back to `text`) do NOT trigger the gate, because `text` can
	// be a pre-tool thought rather than a final answer.

	function plannerJsonWith(opts: {
		messageToUser?: string;
		toolCalls: Array<{ name: string; args?: Record<string, unknown> }>;
	}) {
		// JSON-mode return: parsePlannerOutput goes through parseJsonPlannerOutput
		// which carries `messageToUser` into `raw.messageToUser` — the explicit
		// field the gate requires.
		return vi.fn(async () =>
			JSON.stringify({
				thought: "ready",
				toolCalls: opts.toolCalls,
				...(opts.messageToUser ? { messageToUser: opts.messageToUser } : {}),
			}),
		);
	}

	function plannerNativeWith(opts: {
		text?: string;
		toolCalls: Array<{
			id: string;
			name: string;
			arguments?: Record<string, unknown>;
		}>;
	}) {
		// Native-mode return: parsePlannerOutput's native branch infers
		// messageToUser from `text` but does NOT carry it as an explicit field.
		// The gate must withhold even if `text` is a clean string, because in
		// native mode `text` is ambiguous (thought vs final answer).
		return vi.fn(async () => ({
			text: opts.text ?? "",
			toolCalls: opts.toolCalls,
		}));
	}

	it("FIRES: explicit messageToUser + drained queue + success — evaluator LLM call is skipped", async () => {
		const runtime = {
			useModel: plannerJsonWith({
				messageToUser: "Status check passed.",
				toolCalls: [{ name: "LOOKUP", args: { query: "status" } }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "should not be called",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).not.toHaveBeenCalled();
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Status check passed.");
		expect(result.evaluator?.decision).toBe("FINISH");
		expect(result.evaluator?.success).toBe(true);
		expect(result.evaluator?.thought).toContain("Gated FINISH");

		// Consumer-shape contract: `subPlannerResultToPlannerToolResult` in
		// services/message.ts reads `evaluator.success` and `evaluator.messageToUser`
		// off the loop's return value. The gate's synthesized output must carry both
		// in the shape that consumer expects, so downstream behavior is identical to
		// a model-produced FINISH/success=true result.
		expect(result.evaluator?.success).toBe(true);
		expect(result.evaluator?.messageToUser).toBe("Status check passed.");
		// Trajectory observability: the loop still records the gated decision in
		// `evaluatorOutputs` and as a context event so trajectory dumps and replay
		// tools see the iteration's outcome (just no recorder evaluation stage).
		expect(result.trajectory.evaluatorOutputs).toHaveLength(1);
		expect(result.trajectory.evaluatorOutputs[0]?.thought).toContain(
			"Gated FINISH",
		);
		const evalEvents = (result.trajectory.context.events ?? []).filter(
			(event) => event.type === "evaluation",
		);
		expect(evalEvents).toHaveLength(1);
	});

	it("FIRES: emits a recorder evaluation stage marked gated for trajectory-replay parity", async () => {
		// Gated iterations must still surface on the recorder timeline so replay
		// tools see a stage at the same slot a model-produced evaluation would
		// occupy. The synthesized stage is `kind: "evaluation"` and carries
		// `gated: true` / `llmCallSkipped: true` / `reason: "explicit_terminal_reply"`
		// so reviewers can distinguish gated decisions from real evaluator calls.
		const runtime = {
			useModel: plannerJsonWith({
				messageToUser: "Status check passed.",
				toolCalls: [{ name: "LOOKUP", args: { query: "status" } }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "should not be called",
		}));
		const recordedStages: RecordedStage[] = [];
		const recorder: TrajectoryRecorder = {
			startTrajectory: vi.fn(() => "trj-gated"),
			recordStage: vi.fn(
				async (_trajectoryId: string, stage: RecordedStage) => {
					recordedStages.push(stage);
				},
			),
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
			recorder,
			trajectoryId: "trj-gated",
		});

		// The model evaluator was NOT called.
		expect(evaluate).not.toHaveBeenCalled();

		// The recorder DID receive an evaluation stage for the gated iteration.
		const evalStages = recordedStages.filter((s) => s.kind === "evaluation");
		expect(evalStages).toHaveLength(1);
		const evalStage = evalStages[0];
		if (!evalStage?.evaluation) {
			throw new Error("Expected an evaluation stage payload");
		}
		expect(evalStage.evaluation.gated).toBe(true);
		expect(evalStage.evaluation.llmCallSkipped).toBe(true);
		expect(evalStage.evaluation.reason).toBe("explicit_terminal_reply");
		// The decision and message reach the recorder so timeline UIs render them.
		expect(evalStage.evaluation.decision).toBe("FINISH");
		expect(evalStage.evaluation.messageToUser).toBe("Status check passed.");
		// No `model` block — there was no LLM call to attribute.
		expect(evalStage.model).toBeUndefined();
	});

	it("records a FINISH evaluation when a terminal REPLY ends a continued tool loop", async () => {
		let plannerCallCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				plannerCallCount++;
				if (plannerCallCount === 1) {
					return {
						text: "",
						toolCalls: [
							{ id: "call-1", name: "LOOKUP", arguments: { q: "disk" } },
						],
					};
				}
				return {
					text: "",
					toolCalls: [
						{
							id: "call-final",
							name: "REPLY",
							arguments: { text: "Disk usage checked." },
						},
					],
				};
			}),
		};
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Need the planner to produce the final reply.",
		}));
		const recordedStages: RecordedStage[] = [];
		const recorder: TrajectoryRecorder = {
			startTrajectory: vi.fn(() => "trajectory-terminal"),
			recordStage: vi.fn(
				async (_trajectoryId: string, stage: RecordedStage) => {
					recordedStages.push(stage);
				},
			),
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-terminal" },
			executeToolCall: vi.fn(async () => ({
				success: true,
				text: "df output",
			})),
			evaluate,
			recorder,
			trajectoryId: "trajectory-terminal",
		});

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Disk usage checked.");
		expect(result.evaluator?.decision).toBe("FINISH");
		expect(
			result.trajectory.evaluatorOutputs.map((item) => item.decision),
		).toEqual(["CONTINUE", "FINISH"]);
		const evalStages = recordedStages.filter(
			(stage) => stage.kind === "evaluation",
		);
		expect(evalStages.at(-1)?.evaluation).toMatchObject({
			decision: "FINISH",
			messageToUser: "Disk usage checked.",
			gated: true,
			llmCallSkipped: true,
			reason: "terminal_tool_call",
		});
	});

	it("WITHHOLDS in native-mode (text fallback, no explicit messageToUser) — evaluator IS called", async () => {
		// Native tool-call returns infer messageToUser from `text`. That path is
		// ambiguous (thought vs final answer), so the gate must withhold.
		const runtime = {
			useModel: plannerNativeWith({
				text: "thinking",
				toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Real evaluator decision.",
			messageToUser: "Status: ok.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe("Status: ok.");
	});

	it("WITHHOLDS on tool failure — evaluator IS called", async () => {
		const runtime = {
			useModel: plannerJsonWith({
				messageToUser: "Should not be used because tool failed.",
				toolCalls: [{ name: "LOOKUP", args: {} }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "boom",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Halted after failure.",
			messageToUser: "Could not check status.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.evaluator?.thought).toBe("Halted after failure.");
	});

	it("WITHHOLDS when more tools remain queued — evaluator IS called", async () => {
		const runtime = {
			useModel: plannerJsonWith({
				messageToUser: "Will not be used while plan is incomplete.",
				toolCalls: [
					{ name: "LOOKUP", args: {} },
					{ name: "FOLLOW_UP", args: {} },
				],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Real evaluator called.",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).toHaveBeenCalled();
	});

	it("WITHHOLDS when planner produced no messageToUser — evaluator IS called", async () => {
		const runtime = {
			useModel: plannerJsonWith({
				// No messageToUser field at all.
				toolCalls: [{ name: "LOOKUP", args: {} }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Real evaluator decision.",
			messageToUser: "Status: ok.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe("Status: ok.");
	});

	it("WITHHOLDS when explicit messageToUser contains tool-call syntax — evaluator IS called", async () => {
		// isUnsafeUserVisibleText (reused by the gate) catches tool/function
		// syntax leakage. The evaluator's own prompt rules force CONTINUE on
		// leaked syntax; the gate honors the same constraint.
		const runtime = {
			useModel: plannerJsonWith({
				messageToUser: "I'll need to call to=functions.LOOKUP next to verify.",
				toolCalls: [{ name: "LOOKUP", args: {} }],
			}),
		};
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Real evaluator caught the leaked syntax.",
			messageToUser: "Done.",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(evaluate).toHaveBeenCalled();
	});
});
