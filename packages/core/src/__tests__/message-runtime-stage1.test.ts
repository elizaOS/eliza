import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerFieldEvaluator } from "../runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Can you check my calendar?",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {
			availableContexts: "general, calendar",
		},
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with calendars.",
		},
		actions: [],
		providers: [],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS],
		responseHandlerEvaluators: [],
	} as IAgentRuntime;
}

describe("runV5MessageRuntimeStage1", () => {
	it("requests the required native message-handler tool and parses tool arguments", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-1",
						name: "HANDLE_RESPONSE",
						arguments: {
							plan: {
								contexts: ["simple"],
								reply: "Hello.",
							},
							thought: "Direct answer.",
						},
					},
				],
				finishReason: "tool_calls",
			},
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			tools?: Array<{ name?: string; parameters?: { required?: string[] } }>;
			toolChoice?: string;
			responseSchema?: unknown;
			responseFormat?: unknown;
		};
		expect(params.tools?.[0]?.name).toBe("HANDLE_RESPONSE");
		expect(params.tools?.[0]?.parameters?.required).toContain(
			"candidateActionNames",
		);
		expect(params.tools?.[0]?.parameters?.required).toContain("facts");
		expect(params.toolChoice).toBe("required");
		expect(params.responseSchema).toBeUndefined();
		expect(params.responseFormat).toBeUndefined();
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
		}
	});

	it("falls back to message-handler text when the provider emits an empty native tool call", async () => {
		const runtime = makeRuntime([
			{
				text: JSON.stringify({
					processMessage: "RESPOND",
					thought: "Calendar context is needed.",
					plan: { contexts: ["calendar"], requiresTool: true },
				}),
				toolCalls: [
					{
						id: "mh-empty",
						name: "HANDLE_RESPONSE",
						input: {},
					},
				],
			},
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "I can help schedule that.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
	});

	it("packages Stage 1 as stable system plus dynamic user context without provider internals", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-1",
						toolName: "HANDLE_RESPONSE",
						input: {
							plan: {
								contexts: ["simple"],
								reply: "Hello.",
							},
							thought: "Direct answer.",
						},
					},
				],
			},
		]);
		const longUserText = "x".repeat(12_000);
		const state: State = {
			values: {
				availableContexts: "simple, general",
			},
			data: {
				providerOrder: ["RECENT_MESSAGES", "PROVIDERS", "CHARACTER"],
				providers: {
					RECENT_MESSAGES: {
						text: "# Conversation Messages\nfull recent provider text",
						values: { shouldNotRender: "value leak" },
						data: {
							secret: "secret leak",
							recentMessages: [
								{
									id: "00000000-0000-0000-0000-00000000aaaa" as UUID,
									entityId: "00000000-0000-0000-0000-00000000ffff" as UUID,
									roomId: "00000000-0000-0000-0000-000000001111" as UUID,
									createdAt: 1,
									content: { text: longUserText },
								},
							],
						},
						providerName: "RECENT_MESSAGES",
					},
					PROVIDERS: {
						text: "# Providers\nproviders[99]: giant catalog",
						providerName: "PROVIDERS",
					},
					CHARACTER: {
						text: "# About Test Agent",
						data: { secrets: { API_KEY: "secret leak" } },
						providerName: "CHARACTER",
					},
				},
			},
			text: "fallback text should not be needed",
		};

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state,
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
			prompt?: string;
			promptSegments?: Array<{ content?: string; stable?: boolean }>;
			providerOptions?: {
				eliza?: {
					modelInputBudget?: {
						reserveTokens?: number;
						shouldCompact?: boolean;
					};
				};
			};
		};
		expect(params.messages?.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		const systemContent = params.messages?.[0]?.content ?? "";
		const userContent = params.messages?.[1]?.content ?? "";
		expect(systemContent.startsWith("You are concise.")).toBe(true);
		expect(systemContent.indexOf("# About Test Agent")).toBeGreaterThan(
			systemContent.indexOf("You are concise."),
		);
		expect(systemContent.indexOf("user_role: USER")).toBeGreaterThan(
			systemContent.indexOf("# About Test Agent"),
		);
		expect(systemContent).toContain("message_handler_stage:");
		expect(systemContent).toContain("available_contexts:");
		// Stage 1 keeps both provider text and structured prior messages. This
		// preserves long provider payloads while still giving the model clean
		// chat-message-shaped prior turns.
		expect(userContent).toContain("provider:RECENT_MESSAGES:");
		expect(userContent).toContain("# Conversation Messages");
		expect(userContent).toContain("full recent provider text");
		expect(userContent).toContain("message:user:");
		expect(userContent).toContain(longUserText);
		expect(userContent).toContain("Can you check my calendar?");
		expect(userContent).not.toContain("user_role:");
		const fullPrompt = `${params.prompt ?? ""}\n${systemContent}\n${userContent}`;
		expect(fullPrompt).not.toContain("values:");
		expect(fullPrompt).not.toContain("data:");
		expect(fullPrompt).not.toContain("provider: PROVIDERS");
		expect(fullPrompt).not.toContain("provider: CHARACTER");
		expect(fullPrompt).not.toContain("secret leak");
		expect(params.promptSegments?.some((segment) => segment.stable)).toBe(true);
		expect(params.promptSegments?.some((segment) => !segment.stable)).toBe(
			true,
		);
		expect(params.providerOptions?.eliza?.modelInputBudget).toMatchObject({
			reserveTokens: 10_000,
			shouldCompact: false,
		});
	});

	it("recomposes planner state with selected context providers but excludes catalogs", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: false,
				contexts: ["documents"],
				thought: "Documents context is needed.",
			}),
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "I found the relevant documents.",
			}),
		]);
		runtime.providers = [
			{
				name: "DOCUMENTS",
				contexts: ["documents"],
				get: vi.fn(),
			},
			{
				name: "PROVIDERS",
				contexts: ["documents"],
				get: vi.fn(),
			},
			{
				name: "CHARACTER",
				contexts: ["documents"],
				get: vi.fn(),
			},
		] as IAgentRuntime["providers"];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: {
				values: { availableContexts: "documents" },
				data: {},
				text: "",
			},
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		const composeState = runtime.composeState as {
			mock: { calls: unknown[][] };
		};
		expect(composeState.mock.calls).toHaveLength(1);
		const providerNames = composeState.mock.calls[0]?.[1] as string[];
		expect(providerNames).toContain("DOCUMENTS");
		expect(providerNames).toContain("RECENT_MESSAGES");
		expect(providerNames).not.toContain("PROVIDERS");
		expect(providerNames).not.toContain("CHARACTER");
	});

	it("exposes only validated actions and enforces tool-required routing through PLAN_ACTIONS", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				processMessage: "RESPOND",
				thought: "The current request needs runtime inspection.",
				plan: {
					contexts: ["general"],
					requiresTool: true,
					candidateActions: ["CHECK_RUNTIME"],
				},
			}),
			JSON.stringify({
				thought: "I can answer directly.",
				toolCalls: [],
				messageToUser: "Looks fine.",
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "PLAN_ACTIONS",
						arguments: {
							action: "CHECK_RUNTIME",
							parameters: {},
						},
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Checked.",
				messageToUser: "Checked.",
			}),
		]);
		const handler = vi.fn(async () => ({ success: true, text: "checked" }));
		const validateAllowed = vi.fn(async () => true);
		const validateDenied = vi.fn(async () => false);
		runtime.actions = [
			{
				name: "CHECK_RUNTIME",
				description: "Check current runtime state.",
				contexts: ["general"],
				validate: validateAllowed,
				handler,
			},
			{
				name: "SKIP_RUNTIME",
				description: "Unavailable runtime check.",
				contexts: ["general"],
				validate: validateDenied,
				handler: vi.fn(),
			},
		] as IAgentRuntime["actions"];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(validateAllowed).toHaveBeenCalledTimes(2);
		expect(validateDenied).toHaveBeenCalledTimes(1);
		const firstPlannerParams = useModelCalls(runtime)[1]?.[1] as {
			tools?: Array<{ name?: string }>;
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(firstPlannerParams.tools?.map((tool) => tool.name)).toEqual([
			"PLAN_ACTIONS",
		]);
		const firstPlannerPrompt = JSON.stringify(firstPlannerParams.messages);
		expect(firstPlannerPrompt).toContain("CHECK_RUNTIME");
		expect(firstPlannerPrompt).not.toContain("SKIP_RUNTIME");
		expect(firstPlannerPrompt).toContain(
			"Stage 1 router marked this current turn as requiring a tool",
		);
		const retryPlannerParams = useModelCalls(runtime)[2]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(JSON.stringify(retryPlannerParams.messages)).toContain(
			"previous planner response was not valid",
		);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe("Checked.");
		}
	});

	it("returns a simple no-context reply without calling the planner", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: [],
				thought: "Direct answer.",
				reply: "Hello.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
			expect(result.result.mode).toBe("simple");
		}
	});

	it("routes to the planner when field registry emits candidate actions without contexts", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				shouldRespond: "RESPOND",
				contexts: [],
				intents: [],
				replyText: "",
				candidateActionNames: ["CHECK_RUNTIME"],
				facts: [],
				relationships: [],
				addressedTo: [],
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "PLAN_ACTIONS",
						arguments: {
							action: "CHECK_RUNTIME",
							parameters: {},
						},
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Checked.",
			}),
		]);
		const handler = vi.fn(async () => ({ success: true, text: "checked" }));
		runtime.actions = [
			{
				name: "CHECK_RUNTIME",
				description: "Check current runtime state.",
				contexts: ["general"],
				validate: vi.fn(async () => true),
				handler,
			},
		] as IAgentRuntime["actions"];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerParams = useModelCalls(runtime)[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		expect(JSON.stringify(plannerParams.messages)).toContain("CHECK_RUNTIME");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("lets a registered response-handler evaluator force planner routing without another Stage 1 call", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: [],
				thought: "Direct answer before patching.",
				reply: "Inline answer.",
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "PLAN_ACTIONS",
						arguments: {
							action: "CHECK_RUNTIME",
							parameters: {},
						},
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Evaluator accepted the tool result.",
				messageToUser: "Checked through the planner.",
			}),
		]);
		const handler = vi.fn(async () => ({ success: true, text: "checked" }));
		runtime.actions = [
			{
				name: "CHECK_RUNTIME",
				description: "Check current runtime state.",
				contexts: ["general"],
				validate: vi.fn(async () => true),
				handler,
			},
		] as IAgentRuntime["actions"];
		runtime.responseHandlerEvaluators = [
			{
				name: "test.force_planner",
				priority: 5,
				shouldRun: () => true,
				evaluate: () => ({
					requiresTool: true,
					simple: false,
					clearReply: true,
					addContexts: ["general"],
					addCandidateActions: ["CHECK_RUNTIME"],
					addParentActionHints: ["CHECK_RUNTIME"],
				}),
			} satisfies ResponseHandlerEvaluator,
		];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		expect(useModelCalls(runtime)[2]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		const plannerParams = useModelCalls(runtime)[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerPrompt = JSON.stringify(plannerParams.messages);
		expect(plannerPrompt).toContain("CHECK_RUNTIME");
		expect(plannerPrompt).toContain(
			"Stage 1 router marked this current turn as requiring a tool",
		);
		expect(handler).toHaveBeenCalledTimes(1);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Checked through the planner.",
			);
		}
	});

	it("dispatches response-handler field preemption before planner routing", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				shouldRespond: "RESPOND",
				contexts: ["general"],
				intents: ["stop work"],
				replyText: "",
				candidateActionNames: ["CHECK_RUNTIME"],
				facts: [],
				relationships: [],
				addressedTo: [],
				abortTest: true,
			}),
		]);
		const handle = vi.fn(async () => ({
			mutateResult: (result) => {
				result.replyText = "Stopped.";
				result.contexts = ["simple"];
				result.candidateActionNames = [];
			},
			preempt: { mode: "ack-and-stop" as const, reason: "test_abort" },
		}));
		const abortField: ResponseHandlerFieldEvaluator<boolean> = {
			name: "abortTest",
			description: "Test-only abort field.",
			priority: 25,
			schema: { type: "boolean" },
			parse: (value) => value === true,
			handle,
		};
		runtime.responseHandlerFieldRegistry.register(abortField);
		runtime.responseHandlerFieldEvaluators.push(abortField);
		runtime.responseHandlerEvaluators = [
			{
				name: "test.should_not_run_after_preempt",
				priority: 1,
				shouldRun: () => true,
				evaluate: () => ({
					addContexts: ["general"],
					requiresTool: true,
				}),
			} satisfies ResponseHandlerEvaluator,
		];

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(handle).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Stopped.");
		}
	});

	it("runs planning when contexts are selected even when simple is true", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: ["calendar"],
				thought: "Calendar context is needed.",
				reply: "I can check.",
			}),
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "Your calendar is clear.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		expect(useModelCalls(runtime)[1]?.[2]).toBeUndefined();
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Your calendar is clear.",
			);
		}
	});

	it.each([
		"IGNORE",
		"STOP",
	] as const)("stops immediately for %s", async (action) => {
		const runtime = makeRuntime([
			JSON.stringify({
				action,
				simple: false,
				contexts: [],
				thought: "Terminal decision.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result).toMatchObject({
			kind: "terminal",
			action,
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
});
