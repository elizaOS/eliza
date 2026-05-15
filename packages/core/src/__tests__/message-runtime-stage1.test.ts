import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import type { ResponseHandlerFieldEvaluator } from "../runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import { ChannelType, type UUID } from "../types/primitives";
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

function stage1Response(fields: {
	shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
	thought?: string;
	contexts?: string[];
	intents?: string[];
	candidateActionNames?: string[];
	replyText?: string;
	facts?: string[];
	relationships?: unknown[];
	addressedTo?: string[];
	extra?: Record<string, unknown>;
}) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: fields.shouldRespond ?? "RESPOND",
					thought: fields.thought ?? "",
					contexts: fields.contexts ?? [],
					intents: fields.intents ?? [],
					candidateActionNames: fields.candidateActionNames ?? [],
					replyText: fields.replyText ?? "",
					facts: fields.facts ?? [],
					relationships: fields.relationships ?? [],
					addressedTo: fields.addressedTo ?? [],
					...(fields.extra ?? {}),
				},
			},
		],
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
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
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
							shouldRespond: "RESPOND",
							thought: "Direct answer.",
							replyText: "Hello.",
							contexts: ["simple"],
							intents: [],
							candidateActionNames: [],
							facts: [],
							relationships: [],
							addressedTo: [],
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
			signal?: AbortSignal;
		};
		expect(params.tools?.[0]?.name).toBe("HANDLE_RESPONSE");
		expect(params.tools?.[0]?.parameters?.required).toContain(
			"candidateActionNames",
		);
		expect(params.tools?.[0]?.parameters?.required).toContain("facts");
		expect(params.toolChoice).toBe("required");
		expect(params.signal).toBeInstanceOf(AbortSignal);
		expect(params.responseSchema).toBeUndefined();
		expect(params.responseFormat).toBeUndefined();
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
		}
	});

	it("retries empty Stage 1 completions until a usable response arrives", async () => {
		const runtime = makeRuntime([
			"",
			{ text: "", toolCalls: [] },
			stage1Response({
				contexts: ["simple"],
				replyText: "Recovered after provider empty completions.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Recovered after provider empty completions.",
			);
		}
	});

	it("keeps quoted prose with braces as a direct reply", async () => {
		const runtime = makeRuntime([
			'"Here is an empty object: {} - it has no keys."',
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe(
				'"Here is an empty object: {} - it has no keys."',
			);
		}
	});

	it("reports a precise Stage 1 error after the empty-completion retry budget is exhausted", async () => {
		const runtime = makeRuntime(["", "", ""]);

		await expect(
			runV5MessageRuntimeStage1({
				runtime,
				message: makeMessage(),
				state: makeState(),
				responseId: "00000000-0000-0000-0000-000000000005" as UUID,
			}),
		).rejects.toThrow(
			"v5 messageHandler returned empty Stage 1 result after 3 attempts",
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
	});

	it("falls back to the planner when an explicitly addressed Stage 1 turn stays empty", async () => {
		const runtime = makeRuntime([
			"",
			"",
			"",
			JSON.stringify({
				thought: "Fallback planner can answer.",
				toolCalls: [],
				messageToUser: "Recovered through planner fallback.",
			}),
		]);
		const message = makeMessage();
		message.content.mentionContext = { isMention: true } as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(3);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Recovered through planner fallback.",
			);
		}
	});

	it("falls back to the planner when an explicitly addressed Stage 1 turn is unparseable", async () => {
		const runtime = makeRuntime([
			"{not valid HANDLE_RESPONSE",
			JSON.stringify({
				thought: "Fallback planner can answer.",
				toolCalls: [],
				messageToUser: "Recovered from malformed Stage 1.",
			}),
		]);
		const message = makeMessage();
		message.content.mentionContext = { isMention: true } as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(1);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Recovered from malformed Stage 1.",
			);
		}
	});

	it("parses Stage 1 output from GenerateTextResult content parts when text is blank", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							shouldRespond: "RESPOND",
							thought: "Provider returned content parts.",
							replyText: "Parsed from content.",
							contexts: ["simple"],
							candidateActions: [],
							facts: [],
							relationships: [],
							addressedTo: [],
						}),
					},
				],
			},
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Parsed from content.");
		}
	});

	it("derives a span sampler plan that forces T=0/topK=1 on the shouldRespond enum (and other argmax-eligible spans)", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-1",
						name: "HANDLE_RESPONSE",
						arguments: {
							shouldRespond: "RESPOND",
							thought: "Direct answer.",
							replyText: "Hello.",
							contexts: ["simple"],
							intents: [],
							candidateActionNames: [],
							facts: [],
							relationships: [],
							addressedTo: [],
						},
					},
				],
				finishReason: "tool_calls",
			},
		]);

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			responseSkeleton?: {
				spans: Array<{ kind: string; key?: string; enumValues?: string[] }>;
			};
			spanSamplerPlan?: {
				overrides: Array<{
					spanIndex: number;
					temperature: number;
					topK?: number;
				}>;
			};
		};
		// Skeleton is present and contains the canonical shouldRespond enum.
		expect(params.responseSkeleton?.spans).toBeDefined();
		const shouldRespondSpan = params.responseSkeleton?.spans.find(
			(s) => s.key === "shouldRespond",
		);
		expect(shouldRespondSpan?.kind).toBe("enum");
		// The span-sampler plan was derived and contains an override for shouldRespond.
		expect(params.spanSamplerPlan).toBeDefined();
		expect(params.spanSamplerPlan?.overrides.length).toBeGreaterThan(0);
		const overrides = params.spanSamplerPlan?.overrides ?? [];
		const overriddenKeys = overrides.map(
			(o) => params.responseSkeleton?.spans[o.spanIndex].key,
		);
		expect(overriddenKeys).toContain("shouldRespond");
		// Every override is T=0/topK=1 (the canonical argmax policy).
		for (const o of overrides) {
			expect(o.temperature).toBe(0);
			expect(o.topK).toBe(1);
		}
		// Free-string spans like replyText / thought are NOT in the plan —
		// the user's free prose keeps the call-level temperature.
		expect(overriddenKeys).not.toContain("replyText");
		expect(overriddenKeys).not.toContain("thought");
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
							shouldRespond: "RESPOND",
							thought: "Direct answer.",
							replyText: "Hello.",
							contexts: ["simple"],
							intents: [],
							candidateActionNames: [],
							facts: [],
							relationships: [],
							addressedTo: [],
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
						text: "# Providers\nproviders: giant catalog",
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
		expect(systemContent).toContain("available_contexts");
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
			stage1Response({
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

	it("emits a response-handler reply before planner recomposition when provided", async () => {
		const order: string[] = [];
		const runtime = makeRuntime([
			stage1Response({
				thought: "Acknowledge first, then inspect.",
				contexts: ["general"],
				replyText: "I'll check that now.",
				extra: { requiresTool: true },
			}),
			JSON.stringify({
				thought: "Finished the follow-up.",
				toolCalls: [],
				messageToUser: "The follow-up is complete.",
			}),
		]);
		runtime.composeState = vi.fn(async () => {
			order.push("compose-planner-state");
			return makeState();
		});

		const earlyReply = vi.fn(async () => {
			order.push("early-reply");
		});
		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
			onResponseHandlerEarlyReply: earlyReply,
		});

		expect(earlyReply).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "I'll check that now.",
			}),
		);
		expect(order).toEqual(["early-reply", "compose-planner-state"]);
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"The follow-up is complete.",
			);
		}
	});

	it("voice turn signal can force IGNORE before early reply/planning", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "The model would otherwise answer.",
				contexts: ["general"],
				replyText: "I'll jump in.",
			}),
		]);
		const earlyReply = vi.fn(async () => undefined);
		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: {
				...makeMessage(),
				content: {
					...makeMessage().content,
					channelType: ChannelType.VOICE_DM,
					voiceTurnSignal: {
						endOfTurnProbability: 0.08,
						nextSpeaker: "user",
						agentShouldSpeak: false,
						source: "livekit-turn-detector",
					},
				},
			},
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
			onResponseHandlerEarlyReply: earlyReply,
		});

		expect(result.kind).toBe("terminal");
		if (result.kind === "terminal") {
			expect(result.action).toBe("IGNORE");
		}
		expect(earlyReply).not.toHaveBeenCalled();
	});

	it("preserves the parsed response-handler reply for early delivery even when a repair clears plan.reply", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "Acknowledge first.",
				contexts: ["simple"],
				replyText: "I'll start on that.",
			}),
			JSON.stringify({
				thought: "Planner should not repeat the acknowledgement.",
				toolCalls: [],
				messageToUser: "I found the extra detail.",
			}),
		]);
		runtime.responseHandlerEvaluators = [
			{
				name: "test.clear_reply_but_plan",
				priority: 5,
				shouldRun: () => true,
				evaluate: () => ({
					requiresTool: true,
					clearReply: true,
					addContexts: ["general"],
				}),
			} satisfies ResponseHandlerEvaluator,
		];
		const earlyReply = vi.fn(async () => undefined);

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
			onResponseHandlerEarlyReply: earlyReply,
		});

		expect(earlyReply).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "I'll start on that.",
			}),
		);
	});

	it("exposes only validated actions as native tools and enforces tool-required routing", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "The current request needs runtime inspection.",
				contexts: ["general"],
				candidateActionNames: ["CHECK_RUNTIME"],
				extra: { requiresTool: true },
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
						name: "CHECK_RUNTIME",
						arguments: {},
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
		const firstPlannerToolNames =
			firstPlannerParams.tools?.map((tool) => tool.name) ?? [];
		expect(firstPlannerToolNames).toContain("CHECK_RUNTIME");
		expect(firstPlannerToolNames).not.toContain("SKIP_RUNTIME");
		expect(firstPlannerToolNames).toContain("REPLY");
		const firstPlannerPrompt = JSON.stringify(firstPlannerParams.messages);
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

	it("keeps stale prior assistant tool answers out of tool-planner context", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "The current request needs fresh runtime inspection.",
				contexts: ["general"],
				candidateActionNames: ["CHECK_RUNTIME"],
				extra: { requiresTool: true },
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "CHECK_RUNTIME",
						arguments: {},
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Fresh check completed.",
				messageToUser: "Fresh check completed.",
			}),
		]);
		const staleAssistantAnswer =
			"Root partition '/' is 58% used. The three largest safe cleanup candidates are /home/zo and /home/ubuntu.";
		const priorUserPrompt =
			"Can you check VPS disk usage and name cleanup candidates?";
		const currentMessage: Memory = {
			...makeMessage(),
			content: {
				...makeMessage().content,
				text: "Check VPS disk usage again and inspect deeper this time.",
			},
		};
		const plannerState: State = {
			values: { availableContexts: "general" },
			data: {
				providerOrder: ["RECENT_MESSAGES"],
				providers: {
					RECENT_MESSAGES: {
						text: `# Conversation Messages\nuser: ${priorUserPrompt}\nassistant: ${staleAssistantAnswer}`,
						providerName: "RECENT_MESSAGES",
						data: {
							recentMessages: [
								{
									id: "00000000-0000-0000-0000-00000000aaa1" as UUID,
									entityId: "00000000-0000-0000-0000-000000000002" as UUID,
									roomId: "00000000-0000-0000-0000-000000000004" as UUID,
									createdAt: 1,
									content: { text: priorUserPrompt },
								},
								{
									id: "00000000-0000-0000-0000-00000000aaa2" as UUID,
									entityId: "00000000-0000-0000-0000-000000000003" as UUID,
									agentId: "00000000-0000-0000-0000-000000000003" as UUID,
									roomId: "00000000-0000-0000-0000-000000000004" as UUID,
									createdAt: 2,
									content: { text: staleAssistantAnswer },
								},
								currentMessage,
							],
						},
					},
				},
			},
			text: "",
		};
		runtime.composeState = vi.fn(async () => plannerState);
		const handler = vi.fn(async () => ({
			success: true,
			text: "fresh output",
		}));
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
			message: currentMessage,
			state: plannerState,
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		const firstPlannerParams = useModelCalls(runtime)[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const firstPlannerPrompt = JSON.stringify(firstPlannerParams.messages);
		expect(firstPlannerPrompt).toContain(priorUserPrompt);
		expect(firstPlannerPrompt).toContain(currentMessage.content.text);
		expect(firstPlannerPrompt).toContain("prior_dialogue_policy");
		expect(firstPlannerPrompt).not.toContain("provider:RECENT_MESSAGES");
		expect(firstPlannerPrompt).not.toContain(staleAssistantAnswer);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("returns a simple no-context reply without calling the planner", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "Direct answer.",
				contexts: ["simple"],
				replyText: "Hello.",
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
			stage1Response({
				candidateActionNames: ["CHECK_RUNTIME"],
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "CHECK_RUNTIME",
						arguments: {},
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
			stage1Response({
				thought: "Direct answer before patching.",
				contexts: ["simple"],
				replyText: "Inline answer.",
			}),
			{
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "CHECK_RUNTIME",
						arguments: {},
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
			stage1Response({
				contexts: ["general"],
				intents: ["stop work"],
				candidateActionNames: ["CHECK_RUNTIME"],
				extra: { abortTest: true },
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
			stage1Response({
				thought: "Calendar context is needed.",
				contexts: ["simple", "calendar"],
				replyText: "I can check.",
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
			stage1Response({
				shouldRespond: action,
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
