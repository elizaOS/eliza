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

	it("forbids using SHELL as a fallback for chat-message search/recall", () => {
		// Regression for elizaOS/eliza#7935: Stage 1 hinted
		// candidateActions=["SEARCH_MESSAGES"], but no matching action was
		// registered. The planner fell back to echo placeholders and grep
		// commands, burning iterations without a real chat-history capability.
		expect(plannerTemplate).toContain(
			"SHELL is for filesystem/process work, not a fallback for chat-message search/recall",
		);
		expect(plannerTemplate).toContain(
			"do not run shell greps, echo placeholders, or simulate the search",
		);
		expect(plannerTemplate).toContain(
			"memory queries, or agent-history lookups",
		);
	});

	it("forbids spawning coding sub-agents for chat-message recall tasks", () => {
		expect(plannerTemplate).toContain(
			"TASKS_SPAWN_AGENT is for delegating coding/build/repo work",
		);
		expect(plannerTemplate).toContain(
			"not a fallback for chat-message recall, memory queries, or agent-history lookups",
		);
		expect(plannerTemplate).toContain(
			"routinely ends in sub-agent error/timeout",
		);
	});

	it("forbids inventing tool workarounds for dead candidateActions hints", () => {
		expect(plannerTemplate).toContain(
			"candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint",
		);
		expect(plannerTemplate).toContain(
			"do not invent SHELL/BROWSER/TASKS workarounds to fulfill it",
		);
		expect(plannerTemplate).toContain(
			"placeholder echoes burn cost and produce no progress",
		);
	});

	it("forbids phantom in-flight investigative claims in messageToUser/REPLY (planner side)", () => {
		// Live regression on 2026-05-26: user asked
		// "look it up bitch" after the bot honestly declined a current-news
		// question. Stage 1 routed simple=false + requiresTool=true with
		// candidateActions=[WEB_SEARCH, SHELL]. The planner ran 4 SHELL curl
		// iterations against duckduckgo/google-news/etc — all blocked by
		// anti-scraping. Iter 5 REPLY then emitted:
		//   "I'm fetching the latest info on 'big Yahu'. Please hold..."
		// — a phantom present-continuous claim. iters=5 tools=4 but no
		// further fetch was queued. The planner does not run in the
		// background after returning; the user was promised data that
		// would never arrive.
		//
		// The phantom-action-claim ban already lives in
		// messageHandlerTemplate (Stage 1). This regression covers the
		// SAME ban in plannerTemplate — the planner's messageToUser /
		// REPLY text path that runs after every tool iteration.
		expect(plannerTemplate).toContain(
			"messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening",
		);
		expect(plannerTemplate).toContain('"I\'m fetching X, please hold"');
		expect(plannerTemplate).toContain(
			"The planner does not run in the background after returning",
		);
		expect(plannerTemplate).toContain("set messageToUser saying so plainly");
		expect(plannerTemplate).toContain(
			'"please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases',
		);
		// The ban now also covers task-execution claims (working on / fixing /
		// wrapping up), not just investigative ones. Live regression 2026-06-28:
		// in a multi-bot arena the bot claimed it was "wrapping the runtime-identity
		// fix" with zero TASKS_SPAWN_AGENT this turn — pure narration.
		expect(plannerTemplate).toContain('"I\'m working on it"');
		expect(plannerTemplate).toContain(
			"A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call",
		);
	});

	it("appends mandatory chat-recall fallback policy to optimized planner prompts", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({ text: "No chat search is available." })),
			getService: vi.fn(() => ({
				getPrompt: vi.fn(() => ({
					prompt:
						"task: Optimized planner without bundled safety policy.\n\ncontext_object:\n{{contextObject}}\n\ntrajectory:\n{{trajectory}}",
				})),
			})),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx", events: [] },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		const plannerParams = runtime.useModel.mock.calls[0]?.[1] as {
			messages?: Array<{ role?: string; content?: string }>;
		};
		const systemContent =
			plannerParams.messages?.find((message) => message.role === "system")
				?.content ?? "";
		expect(systemContent).toContain(
			"Optimized planner without bundled safety policy",
		);
		expect(systemContent).toContain("mandatory planner policy:");
		expect(systemContent).toContain(
			"SHELL is for filesystem/process work, not a fallback for chat-message search/recall",
		);
		expect(systemContent).toContain(
			"candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint",
		);
		expect(systemContent).toContain(
			"TASKS_SPAWN_AGENT is for delegating coding/build/repo work",
		);
		expect(systemContent).toContain(
			"messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening",
		);
		expect(systemContent).toContain(
			'"please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases',
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
		expect(plannerParams.maxTokens).toBe(1024);
		expect(plannerParams.providerOptions.eliza.thinking).toBe("off");
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 1 }),
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	// #10132: in chat mode the planner's 1024-token output cap is fine, but a
	// coding sub-agent (ELIZA_PLANNER_FULL_ACTION_SURFACE=1) must emit a whole
	// file as a single FILE/WRITE tool-call argument — a real single-file app is
	// ~4.6k+ tokens once JSON-escaped, so 1024 truncates it mid-stream and the
	// build silently fails. Coding mode lifts the cap.
	const buildCodingPlannerRuntime = () => ({
		useModel: vi.fn(async () => ({
			text: "",
			toolCalls: [
				{ id: "call-1", name: "REPLY", arguments: { text: "Built it." } },
			],
		})),
	});
	const codingPlannerContext = {
		id: "ctx",
		events: [
			{
				id: "msg",
				type: "message" as const,
				message: {
					role: "user" as const,
					content: { text: "Build a tip calculator app." },
				},
			},
		],
	};
	const codingPlannerTools = [
		{ name: "FILE", description: "Write a file." },
		{ name: "REPLY", description: "Reply to the user." },
	];
	const codingReply = (id: string, text: string) => ({
		text: "",
		toolCalls: [{ id, name: "REPLY", arguments: { text } }],
	});
	const codingFileWrite = () => ({
		text: "",
		toolCalls: [
			{
				id: "file-1",
				name: "FILE",
				arguments: {
					path: "dice.html",
					content: "<button>Roll</button>",
				},
			},
		],
	});
	const withCodingRequiredToolDefaults = async <T>(
		run: () => Promise<T>,
	): Promise<T> => {
		const prevSurface = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
		const prevMisses = process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES;
		process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
		delete process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES;
		try {
			return await run();
		} finally {
			if (prevSurface === undefined)
				delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
			else process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = prevSurface;
			if (prevMisses === undefined)
				delete process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES;
			else process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES = prevMisses;
		}
	};

	it("raises the planner output-token cap in coding/full-surface mode (#10132)", async () => {
		const prevSurface = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
		const prevMax = process.env.ELIZA_CODING_PLANNER_MAX_TOKENS;
		process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
		delete process.env.ELIZA_CODING_PLANNER_MAX_TOKENS;
		try {
			const runtime = buildCodingPlannerRuntime();
			await runPlannerLoop({
				runtime,
				context: codingPlannerContext,
				executeToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "FINISH" as const,
					thought: "Done.",
					messageToUser: "Done.",
				})),
			});
			const plannerParams = runtime.useModel.mock.calls[0][1];
			expect(plannerParams.maxTokens).toBe(16384);
		} finally {
			if (prevSurface === undefined)
				delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
			else process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = prevSurface;
			if (prevMax === undefined)
				delete process.env.ELIZA_CODING_PLANNER_MAX_TOKENS;
			else process.env.ELIZA_CODING_PLANNER_MAX_TOKENS = prevMax;
		}
	});

	it("honors ELIZA_CODING_PLANNER_MAX_TOKENS in coding mode (#10132)", async () => {
		const prevSurface = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
		const prevMax = process.env.ELIZA_CODING_PLANNER_MAX_TOKENS;
		process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
		process.env.ELIZA_CODING_PLANNER_MAX_TOKENS = "32768";
		try {
			const runtime = buildCodingPlannerRuntime();
			await runPlannerLoop({
				runtime,
				context: codingPlannerContext,
				executeToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "FINISH" as const,
					thought: "Done.",
					messageToUser: "Done.",
				})),
			});
			const plannerParams = runtime.useModel.mock.calls[0][1];
			expect(plannerParams.maxTokens).toBe(32768);
		} finally {
			if (prevSurface === undefined)
				delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
			else process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = prevSurface;
			if (prevMax === undefined)
				delete process.env.ELIZA_CODING_PLANNER_MAX_TOKENS;
			else process.env.ELIZA_CODING_PLANNER_MAX_TOKENS = prevMax;
		}
	});

	it("requires a non-terminal tool before accepting terminal REPLY in coding mode (#10132)", async () => {
		await withCodingRequiredToolDefaults(async () => {
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce(
						codingReply("reply-1", "Creating the app now."),
					)
					.mockResolvedValueOnce(codingFileWrite())
					.mockResolvedValueOnce(codingReply("reply-2", "Built dice.html.")),
				logger: { warn: vi.fn() },
			};
			const executeToolCall = vi.fn(async () => ({
				success: true,
				text: "wrote dice.html",
			}));
			const evaluate = vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				thought: "Done.",
				messageToUser: "Built dice.html.",
			}));

			const result = await runPlannerLoop({
				runtime,
				context: codingPlannerContext,
				tools: codingPlannerTools,
				executeToolCall,
				evaluate,
			});

			expect(runtime.useModel).toHaveBeenCalledTimes(3);
			expect(executeToolCall).toHaveBeenCalledWith(
				{
					id: "file-1",
					name: "FILE",
					params: { path: "dice.html", content: "<button>Roll</button>" },
				},
				expect.objectContaining({ iteration: 2 }),
			);
			expect(result.finalMessage).toBe("Built dice.html.");
		});
	});

	it("lifts the required-tool miss budget in coding mode (#10132)", async () => {
		await withCodingRequiredToolDefaults(async () => {
			const terminalReply = codingReply("reply-1", "Creating the app now.");
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce(terminalReply)
					.mockResolvedValueOnce(terminalReply)
					.mockResolvedValueOnce(codingFileWrite())
					.mockResolvedValueOnce(codingReply("reply-2", "Built dice.html.")),
				logger: { warn: vi.fn() },
			};
			const executeToolCall = vi.fn(async () => ({
				success: true,
				text: "wrote dice.html",
			}));
			const evaluate = vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				thought: "Done.",
				messageToUser: "Built dice.html.",
			}));

			const result = await runPlannerLoop({
				runtime,
				context: codingPlannerContext,
				tools: codingPlannerTools,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall,
				evaluate,
			});

			expect(runtime.useModel).toHaveBeenCalledTimes(4);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(result.finalMessage).toBe("Built dice.html.");
		});
	});

	it("uses owner-declared action summaries for coding fallback replies", async () => {
		await withCodingRequiredToolDefaults(async () => {
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce({
						text: "",
						toolCalls: [
							{
								id: "custom-1",
								name: "CUSTOM_BUILD_TOOL",
								arguments: { target: "dice" },
							},
						],
					})
					.mockResolvedValueOnce(codingReply("reply-1", "None")),
				logger: { warn: vi.fn() },
			};
			const executeToolCall = vi.fn(async (toolCall) =>
				toolCall.name === "CUSTOM_BUILD_TOOL"
					? {
							success: true,
							text: "custom build tool completed",
							summary: "assembled dice app",
						}
					: {
							success: true,
							text: "None",
							continueChain: false,
						},
			);

			const result = await runPlannerLoop({
				runtime,
				context: codingPlannerContext,
				tools: [
					{ name: "CUSTOM_BUILD_TOOL", description: "Builds something." },
					{ name: "REPLY", description: "Reply to the user." },
				],
				executeToolCall,
				evaluate: vi.fn(),
			});

			expect(result.finalMessage).toBe("Done — Assembled dice app.");
		});
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

	it("surfaces captured REPLY refusal text when required-tool cap is hit, instead of throwing", async () => {
		// Live regression: trajectory tj-3bb6dc66be0c16.json on 2026-05-25
		// showed that when Stage 1 set requiresTool=true but no exposed tool
		// could fulfill the task (chat-history search with no SEARCH_MESSAGES
		// action), the planner emitted REPLY with valid honest refusals each
		// iteration. The loop discarded every REPLY, hit maxRequiredToolMisses,
		// threw TrajectoryLimitExceeded, and the caller emitted a generic
		// apology ("Sorry, something went wrong—please try again"). The fix
		// captures the most recent terminal-only refusal across iterations and
		// returns it as the final user-facing message when the cap is reached.
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-1",
							name: "REPLY",
							arguments: {
								text: "I'm not able to search the chat history directly from here.",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-2",
							name: "REPLY",
							arguments: {
								text: "I don't have a way to search the Discord message history.",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-3",
							name: "REPLY",
							arguments: {
								text: "I still can't search the Discord message history from here.",
							},
						},
					],
				}),
			logger: { warn: vi.fn() },
		};

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
			config: { maxRequiredToolMisses: 2 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(
			"I still can't search the Discord message history from here.",
		);
		// maxRequiredToolMisses=2 allows two misses; the third exhausts the cap
		// and returns the most recent captured refusal.
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("does not surface a captured refusal before the required-tool retry budget is exhausted", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply-1",
							name: "REPLY",
							arguments: {
								text: "I can't answer without checking first.",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "lookup-1",
							name: "LOOKUP",
							arguments: { query: "status" },
						},
					],
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "status ok",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Status is ok.",
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
			config: { maxRequiredToolMisses: 1 },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe("Status is ok.");
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "lookup-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 2 }),
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("stops re-executing an identical successful call and forces a terminal synthesis", async () => {
		// Live regression: gpt-5.5 re-issued the SAME WEB_FETCH (same url) every
		// iteration; each succeeded, the evaluator said CONTINUE, and the loop ran
		// until maxTrajectoryPromptTokens aborted the turn with a generic apology.
		// The redundant-call breaker executes the call once, skips the identical
		// repeats, and after maxRepeatedToolCalls forces one tool-less synthesis.
		const sameCall = {
			id: "fetch-1",
			name: "WEB_FETCH",
			arguments: { url: "https://api.example.test/price" },
		};
		const runtime = {
			useModel: vi
				.fn()
				// iter 1 (fresh) → executes; iters 2-3 repeat it → redundant
				.mockResolvedValueOnce({ text: "", toolCalls: [sameCall] })
				.mockResolvedValueOnce({ text: "", toolCalls: [sameCall] })
				.mockResolvedValueOnce({ text: "", toolCalls: [sameCall] })
				// forced synthesis (no tools) → terminal answer
				.mockResolvedValueOnce(
					'{"thought":"I already have the price.","messageToUser":"The price is 42.","toolCalls":[]}',
				),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "price=42",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Keep going.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "WEB_FETCH", description: "Fetch a URL." }],
			config: { maxRepeatedToolCalls: 1 },
			executeToolCall,
			evaluate,
		});

		// The identical call ran exactly once; the repeats were skipped, not re-run.
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("42");
	});

	it("does not capture native text fallback as a required-tool refusal", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "I should answer after thinking through the tool choice.",
				toolCalls: [],
			})),
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [
					{
						name: "LOOKUP",
						description: "Lookup current status.",
					},
				],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("captures a SAFE native-text refusal at required-tool exhaustion instead of a generic apology (#9874)", async () => {
		// Companion to the guard above. When Stage 1 forced requiresTool but no
		// exposed tool can satisfy the request, a native-mode model emits an
		// honest refusal as `text` with no REPLY call / explicit messageToUser.
		// That text is a genuine user-facing reply (not a pre-tool thought), so it
		// must reach the user — gated through the user-safe refusal check — rather
		// than throwing into the caller's generic "something went wrong".
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "I'm not able to search the chat history directly from here.",
				toolCalls: [],
			})),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "LOOKUP", description: "Lookup current status." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 1 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(
			"I'm not able to search the chat history directly from here.",
		);
		// maxRequiredToolMisses=1: the 2nd miss exhausts the cap and returns the
		// captured native refusal.
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("never surfaces a leaked tool-call as a native refusal at exhaustion (#9874)", async () => {
		// Negative control: native text that is a reasoning/leak must be rejected
		// by the user-safe gate, so the loop throws rather than leaking it.
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "I need to call SEARCH_MESSAGES to find that.",
				toolCalls: [],
			})),
			logger: { warn: vi.fn() },
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "LOOKUP", description: "Lookup current status." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it.each([
		"Let me check the database for that information.",
		"Let me pull up your recent messages.",
		"I'm reviewing the conversation history to answer.",
		"I'll look that up and get back to you.",
		"Pulling up the info now, one sec.",
	])("never surfaces native intent-narration as a refusal: %s (#9874)", async (text) => {
		// Regression: a native pre-tool/intent-narration text carries no leak
		// markup and no "thinking through" marker, so a denylist would let it
		// through and the agent would falsely claim it is doing work it never
		// did. The positive-allowlist gate (must read as an inability) rejects
		// it → the loop throws → caller emits the generic apology, never the
		// phantom action claim.
		const runtime = {
			useModel: vi.fn(async () => ({ text, toolCalls: [] })),
			logger: { warn: vi.fn() },
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "LOOKUP", description: "Lookup current status." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
	});

	it("does not surface explicit messageToUser intent-narration at required-tool exhaustion (#9874)", async () => {
		const runtime = {
			useModel: vi.fn(async () =>
				JSON.stringify({
					messageToUser: "Let me check the database for that information.",
					toolCalls: [],
				}),
			),
			logger: { warn: vi.fn() },
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "LOOKUP", description: "Lookup current status." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("does not surface terminal REPLY intent-narration at required-tool exhaustion (#9874)", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "reply-1",
						name: "REPLY",
						arguments: {
							text: "Let me check the database for that information.",
						},
					},
				],
			})),
			logger: { warn: vi.fn() },
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "LOOKUP", description: "Lookup current status." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("surfaces an explicit honest refusal at required-tool exhaustion (#9874)", async () => {
		const runtime = {
			useModel: vi.fn(async () =>
				JSON.stringify({
					messageToUser: "That capability is not available this turn.",
					toolCalls: [],
				}),
			),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "LOOKUP", description: "Lookup current status." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 1 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(
			"That capability is not available this turn.",
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
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

	it("collapses repeated parameter-validation failures on the same tool even when args vary", async () => {
		// Regression for runaway loops where the model retries a single
		// tool repeatedly with shifting argument shapes that every time
		// fail `validateToolArgs`. Without canonical signing of these
		// validation failures, the repeatKey + error message both diverge
		// per call and `maxRepeatedFailures` never trips. Observed live as
		// a 27-iteration runaway against TASKS where the model alternated
		// between `action=spawn_agent` / `action=create` / `action=update`
		// with the same set of unrecognized arguments.
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "TASKS",
							arguments: { action: "spawn_agent", task: "build a site" },
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-2",
							name: "TASKS",
							arguments: { action: "create", task: "build a site" },
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-3",
							name: "TASKS",
							arguments: { action: "update", task: "build a site" },
						},
					],
				}),
		};
		let callCount = 0;
		const executeToolCall = vi.fn(async () => {
			callCount++;
			return {
				success: false,
				error: `Unexpected argument 'task'; action value '${callCount}' rejected`,
				data: {
					parameterErrors: ["Unexpected argument 'task'", "action not in enum"],
				},
			};
		});
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Retry with a different action.",
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
		// Loop must bail on the second validation rejection, not run forever.
		expect(executeToolCall.mock.calls.length).toBeLessThanOrEqual(2);
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

	it("never surfaces scratch prose accompanying a STOP-only terminal", async () => {
		// Live regression 2026-06-12 (tj-5d0d458b7ad281): after spawning a
		// sub-agent the planner emitted STOP plus the free text "We should wait
		// for the sub-agent result before replying." — and that scratch
		// reasoning was sent to Discord verbatim as the reply.
		const runtime = {
			useModel: vi.fn().mockResolvedValueOnce({
				text: "We should wait for the sub-agent result before replying.",
				toolCalls: [{ id: "stop-1", name: "STOP", arguments: {} }],
			}),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBeUndefined();
	});

	it("keeps the prose fallback for a textless REPLY terminal", async () => {
		// Counterpart contract: when the model DID choose REPLY but put the
		// answer in the text channel instead of the call args, the prose is
		// the reply and must still reach the user.
		const runtime = {
			useModel: vi.fn().mockResolvedValueOnce({
				text: "Here is your answer.",
				toolCalls: [{ id: "reply-1", name: "REPLY", arguments: {} }],
			}),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Here is your answer.");
	});
});
