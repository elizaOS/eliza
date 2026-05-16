import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import type { ResponseHandlerFieldEvaluator } from "../runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import {
	messageHandlerFromFieldResult,
	runV5MessageRuntimeStage1,
} from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeMessage(content: Partial<Memory["content"]> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Can you check my calendar?",
			source: "test",
			...content,
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
			maxTokens?: number;
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
		expect(params.maxTokens).toBe(2048);
		expect(params.signal).toBeInstanceOf(AbortSignal);
		expect(params.responseSchema).toBeUndefined();
		expect(params.responseFormat).toBeUndefined();
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
		}
	});

	it("uses a compact response-handler schema for direct channels", async () => {
		const runtime = makeRuntime([
			stage1Response({
				contexts: ["simple"],
				replyText: "Hi.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage({ channelType: ChannelType.DM }),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			tools?: Array<{ parameters?: { required?: string[] } }>;
			maxTokens?: number;
			responseSkeleton?: { spans?: Array<{ key?: string }> };
			grammar?: string;
		};
		const required = params.tools?.[0]?.parameters?.required ?? [];
		expect(required).toEqual([
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
		]);
		expect(required).not.toContain("shouldRespond");
		expect(required).not.toContain("facts");
		expect(params.maxTokens).toBe(384);
		expect(
			params.responseSkeleton?.spans?.some((s) => s.key === "shouldRespond"),
		).toBe(false);
		expect(params.grammar).not.toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
	});

	it("uses a compact direct-channel prompt catalog", async () => {
		const runtime = makeRuntime([
			stage1Response({
				contexts: ["simple"],
				replyText: "Hi.",
			}),
		]);
		const longDescription =
			"Very long context description. ".repeat(80) +
			"This should not be in direct-channel Stage 1 prompts.";
		runtime.contexts = {
			listAvailable: vi.fn(() => [
				{
					id: "simple",
					label: "Simple",
					description: longDescription,
					sensitivity: "public",
				},
				{
					id: "calendar",
					label: "Calendar",
					description: longDescription,
					roleGate: { minRole: "ADMIN" },
					sensitivity: "private",
				},
				{
					id: "terminal",
					label: "Terminal",
					aliases: ["shell"],
					description: longDescription,
					roleGate: { minRole: "OWNER" },
					sensitivity: "private",
				},
			]),
		} as IAgentRuntime["contexts"];

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage({ channelType: ChannelType.DM }),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const systemContent = params.messages?.[0]?.content ?? "";
		expect(systemContent).toContain("task: Plan this direct message.");
		expect(systemContent).toContain("- calendar [label=Calendar");
		expect(systemContent).toContain("role>=ADMIN");
		expect(systemContent).not.toContain(longDescription);
		expect(systemContent.length).toBeLessThan(3_500);
	});

	it("uses the fast direct reply path for simple private chat", async () => {
		const runtime = makeRuntime(["Hi, I am here."]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage({
				channelType: ChannelType.DM,
				text: "hi, can you say hi back?",
			}),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		const firstCall = useModelCalls(runtime)[0];
		expect(firstCall?.[0]).toBe(ModelType.TEXT_SMALL);
		const params = firstCall?.[1] as {
			prompt?: string;
			maxTokens?: number;
			grammar?: string;
			responseSkeleton?: unknown;
		};
		expect(params.prompt).toContain("task: Write one direct reply");
		expect(params.prompt).toContain("hi, can you say hi back?");
		expect(params.maxTokens).toBe(96);
		expect(params.grammar).toBeUndefined();
		expect(params.responseSkeleton).toBeUndefined();
	});

	it("keeps tool-like direct messages on the structured routing path", async () => {
		const runtime = makeRuntime([
			stage1Response({
				contexts: ["general"],
				replyText: "Looking into it.",
			}),
			JSON.stringify({
				thought: "No tool is registered in this fixture.",
				toolCalls: [],
				messageToUser: "I would need a web tool to check current prices.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage({
				channelType: ChannelType.DM,
				text: "search the web for current GPU prices",
			}),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		const firstCall = useModelCalls(runtime)[0];
		expect(firstCall?.[0]).toBe(ModelType.RESPONSE_HANDLER);
	});

	it("parses provider-native message-handler calls that use args instead of arguments", async () => {
		const runtime = makeRuntime([
			{
				text: "",
				toolCalls: [
					{
						id: "mh-args-1",
						name: "HANDLE_RESPONSE",
						args: {
							shouldRespond: "RESPOND",
							thought: "Direct answer.",
							replyText: "Hello from args.",
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
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello from args.");
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

	it("uses a direct reply fallback when an explicitly addressed simple Stage 1 turn stays empty", async () => {
		const runtime = makeRuntime([
			"",
			"",
			"",
			"elizaOS is an open-source agent runtime for building agents with memory, tools, plugins, and chat integrations.",
		]);
		const message = makeMessage({
			text: "Test Agent (@000000000000000000) BASH_EXECUTE FETCH_URL TASKS_SPAWN_AGENT Can you tell me what elizaOS is?",
			currentMessageText: "Can you tell me what elizaOS is?",
		} as Partial<Memory["content"]>);

		message.content.mentionContext = { isMention: true } as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
		expect(runtime.useModel).toHaveBeenLastCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("Can you tell me what elizaOS is?"),
				maxTokens: 96,
			}),
		);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toContain(
				"open-source agent runtime",
			);
		}
	});

	it("keeps polluted rendered text out of empty Stage 1 planner fallback candidates", async () => {
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
		const message = makeMessage({
			text: "Test Agent (@000000000000000000) BASH_EXECUTE FETCH_URL TASKS_SPAWN_AGENT Can you tell me what elizaOS is?",
			currentMessageText: "Can you check my calendar?",
		});
		message.content.mentionContext = { isMention: true } as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
		const plannerCall = useModelCalls(runtime)[3];
		const plannerParams = plannerCall?.[1] as {
			messages?: Array<{ content?: string | null }>;
		};
		const plannerPrompt = plannerParams.messages?.[1]?.content ?? "";
		expect(plannerPrompt).toContain("Can you check my calendar?");
		expect(plannerPrompt).not.toContain("BASH_EXECUTE");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Recovered through planner fallback.",
			);
		}
	});

	it("preserves direct app-build routing when explicitly addressed Stage 1 stays empty", async () => {
		const runtime = makeRuntime([
			"",
			"",
			"",
			{
				thought: "A coding task should be delegated.",
				toolCalls: [
					{
						id: "spawn-app-builder",
						name: "TASKS_SPAWN_AGENT",
						args: { task: "Build a random tweet app." },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "The app-build task was delegated.",
				messageToUser: "Started the app build.",
			}),
		]);
		const fileHandler = vi.fn(async () => ({
			success: true,
			text: "File should not be selected first.",
			data: { actionName: "FILE" },
		}));
		const taskHandler = vi.fn(async () => ({
			success: true,
			text: "Spawned coding agent.",
			data: { actionName: "TASKS_SPAWN_AGENT" },
		}));
		runtime.actions = [
			{
				name: "FILE",
				similes: ["WRITE_FILE"],
				description: "Read or write files directly.",
				examples: [],
				validate: async () => true,
				handler: fileHandler,
			},
			{
				name: "TASKS_SPAWN_AGENT",
				similes: ["SPAWN_AGENT"],
				description: "Spawn a coding task agent.",
				parameters: [
					{
						name: "task",
						description: "Coding task to perform",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: taskHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "build an app that generates a random tweet",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(taskHandler).toHaveBeenCalledTimes(1);
		expect(fileHandler).not.toHaveBeenCalled();
		const calls = useModelCalls(runtime);
		expect(calls[3]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerCall = calls[3]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
		expect(plannerUserContent).toContain(
			'"candidateActions":["TASKS_SPAWN_AGENT"]',
		);
		expect(plannerUserContent).toContain(
			'"tierAParents":["TASKS_SPAWN_AGENT"]',
		);
	});

	it("executes an umbrella action directly when the planner supplies its dispatcher enum", async () => {
		const runtime = makeRuntime([
			stage1Response({
				thought: "A coding task should be delegated.",
				contexts: ["general"],
				candidateActionNames: ["TASKS"],
				extra: { requiresTool: true },
			}),
			{
				thought: "A coding task should be delegated.",
				toolCalls: [
					{
						id: "spawn-app-builder",
						name: "TASKS",
						args: {
							action: "spawn_agent",
							task: "Build a random tweet app.",
						},
					},
				],
			},
		]);
		const parentHandler = vi.fn(async (_runtime, _message, _state, options) => {
			expect(options.parameters).toMatchObject({
				action: "spawn_agent",
				task: "Build a random tweet app.",
			});
			return {
				success: true,
				text: "Spawned coding agent.",
				continueChain: false,
				data: { actionName: "TASKS" },
			};
		});
		const childHandler = vi.fn(async () => ({
			success: true,
			text: "Child should not be selected by a sub-planner.",
			data: { actionName: "TASKS_SPAWN_AGENT" },
		}));
		runtime.actions = [
			{
				name: "TASKS",
				similes: ["SPAWN_AGENT"],
				description: "Planner surface for coding task delegation.",
				parameters: [
					{
						name: "action",
						description: "Task operation",
						required: false,
						schema: { type: "string", enum: ["create", "spawn_agent"] },
					},
					{
						name: "task",
						description: "Coding task to perform",
						required: false,
						schema: { type: "string" },
					},
				],
				subActions: ["TASKS_SPAWN_AGENT"],
				examples: [],
				validate: async () => true,
				handler: parentHandler,
			},
			{
				name: "TASKS_SPAWN_AGENT",
				similes: ["SPAWN_AGENT"],
				description: "Spawn a coding task agent.",
				parameters: [
					{
						name: "task",
						description: "Coding task to perform",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: childHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "build an app that generates a random tweet",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(parentHandler).toHaveBeenCalledTimes(1);
		expect(childHandler).not.toHaveBeenCalled();
		expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
		]);
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe("Spawned coding agent.");
		}
	});

	it("preserves direct current-info candidates when explicitly addressed Stage 1 stays empty", async () => {
		const runtime = makeRuntime([
			"",
			"",
			"",
			{
				thought: "Fallback planner can use search.",
				toolCalls: [
					{
						id: "search-current-price",
						name: "SEARCH",
						args: { query: "current Bitcoin price USD" },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Search returned current market data.",
				messageToUser: "Current BTC price fetched from search.",
			}),
		]);
		const searchHandler = vi.fn(async () => ({
			success: true,
			text: "BTC current price: 1 USD",
			data: { actionName: "SEARCH" },
		}));
		runtime.actions = [
			{
				name: "SEARCH",
				similes: ["WEB_SEARCH", "SEARCH_WEB"],
				description: "Search current public data.",
				parameters: [
					{
						name: "query",
						description: "Search query",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: searchHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "What is the current Bitcoin price in USD right now?",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(searchHandler).toHaveBeenCalledTimes(1);
		const calls = useModelCalls(runtime);
		expect(calls[3]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerCall = calls[3]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
		expect(plannerUserContent).toContain('"candidateActions":["SEARCH"]');
		expect(plannerUserContent).toContain('"requiresTool":true');
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Current BTC price fetched from search.",
			);
		}
	});

	it("routes text HANDLE_RESPONSE acknowledgements for current-info requests through web search", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				shouldRespond: "RESPOND",
				contexts: [],
				intents: ["check btc price"],
				candidateActionNames: [],
				replyText: "On it.",
				facts: [],
				relationships: [],
				addressedTo: [],
			}),
			{
				thought: "Search can fetch the current market price.",
				toolCalls: [
					{
						id: "search-current-price",
						name: "WEB_SEARCH",
						args: { query: "current BTC price in USD" },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Search returned current market data.",
				messageToUser: "Current BTC price fetched from search.",
			}),
		]);
		const searchHandler = vi.fn(async () => ({
			success: true,
			text: "BTC current price: 1 USD",
			data: { actionName: "WEB_SEARCH" },
		}));
		runtime.actions = [
			{
				name: "WEB_SEARCH",
				similes: ["SEARCH", "SEARCH_WEB"],
				description: "Search current public data.",
				parameters: [
					{
						name: "query",
						description: "Search query",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: searchHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "What is the current BTC price in USD right now? Use a current source if needed.",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(searchHandler).toHaveBeenCalledTimes(1);
		const calls = useModelCalls(runtime);
		expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerCall = calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
		expect(plannerUserContent).toContain('"candidateActions":["WEB_SEARCH"]');
		expect(plannerUserContent).toContain('"requiresTool":true');
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Current BTC price fetched from search.",
			);
		}
	});

	it("routes legacy Stage 1 current-info acknowledgements to shell when no web search action is registered", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				processMessage: "RESPOND",
				thought: "",
				plan: {
					contexts: [],
					reply: "On it.",
					simple: false,
					requiresTool: true,
					candidateActions: [],
				},
				extract: {
					facts: [],
					relationships: [],
					addressedTo: ["e2e"],
				},
			}),
			{
				thought: "Shell can fetch a current market quote.",
				toolCalls: [
					{
						id: "shell-current-price",
						name: "SHELL",
						args: { command: "curl -s https://api.coingecko.com/api/v3/ping" },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Shell returned current market data.",
				messageToUser: "BTC current price fetched from shell.",
			}),
		]);
		const shellHandler = vi.fn(async () => ({
			success: true,
			text: "BTC current price: 1 USD",
			data: { actionName: "SHELL" },
		}));
		runtime.actions = [
			{
				name: "SHELL",
				similes: ["RUN_COMMAND", "TERMINAL"],
				description: "Run a shell command.",
				parameters: [
					{
						name: "command",
						description: "Shell command",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: shellHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "what is btc at rn?",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(shellHandler).toHaveBeenCalledTimes(1);
		const calls = useModelCalls(runtime);
		expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerCall = calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
		expect(plannerUserContent).toContain('"candidateActions":["SHELL"]');
		expect(plannerUserContent).toContain('"requiresTool":true');
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"BTC current price fetched from shell.",
			);
		}
	});

	it("routes synthetic current-price Stage 1 candidates to a real shell lookup action", async () => {
		const runtime = makeRuntime([
			stage1Response({
				contexts: [],
				candidateActionNames: ["GET_CRYPTO_PRICE"],
				replyText: "On it.",
			}),
			{
				thought: "Shell can fetch the current market quote.",
				toolCalls: [
					{
						id: "shell-current-price",
						name: "SHELL",
						args: { command: "curl -s https://api.coingecko.com/api/v3/ping" },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Shell returned current market data.",
				messageToUser: "BTC current price fetched from shell.",
			}),
		]);
		const shellHandler = vi.fn(async () => ({
			success: true,
			text: "BTC current price: 1 USD",
			data: { actionName: "SHELL" },
		}));
		const browserHandler = vi.fn(async () => ({
			success: true,
			text: "Browser was not needed.",
			data: { actionName: "BROWSER" },
		}));
		runtime.actions = [
			{
				name: "BROWSER",
				similes: ["USE_BROWSER"],
				description: "Control a browser tab.",
				examples: [],
				validate: async () => true,
				handler: browserHandler,
			},
			{
				name: "SHELL",
				similes: ["RUN_COMMAND", "TERMINAL"],
				description: "Run a shell command.",
				parameters: [
					{
						name: "command",
						description: "Shell command",
						required: true,
						schema: { type: "string" },
					},
				],
				examples: [],
				validate: async () => true,
				handler: shellHandler,
			},
		] as never;
		const message = makeMessage();
		message.content = {
			...message.content,
			text: "what is btc at rn?",
			mentionContext: { isMention: true },
		};

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message,
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(shellHandler).toHaveBeenCalledTimes(1);
		expect(browserHandler).not.toHaveBeenCalled();
		const calls = useModelCalls(runtime);
		expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		const plannerCall = calls[1]?.[1] as {
			messages?: Array<{ role?: string; content?: string | null }>;
		};
		const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
		expect(plannerUserContent).toContain(
			'"candidateActions":["GET_CRYPTO_PRICE","SHELL"]',
		);
		expect(plannerUserContent).toContain('"tierAParents":["SHELL"]');
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"BTC current price fetched from shell.",
			);
		}
	});

	it("routes progress-only coding delegation replies through the planner", () => {
		const routed = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				intents: ["build static app"],
				replyText: "Spawning the sub-agent now.",
				candidateActionNames: [],
				facts: [],
				relationships: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [{ name: "TASKS" }],
				messageText:
					"Use the OpenCode coding sub-agent to build a tiny static app with index.html, style.css, app.js, and verify the public URL.",
			},
		);

		expect(routed.plan.simple).toBe(false);
		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.contexts).toContain("general");
		expect(routed.plan.candidateActions).toEqual(["TASKS"]);
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
									agentId: "00000000-0000-0000-0000-000000000003" as UUID,
									roomId: "00000000-0000-0000-0000-000000001111" as UUID,
									createdAt: 1,
									content: { text: longUserText },
								},
								{
									id: "00000000-0000-0000-0000-00000000aaab" as UUID,
									entityId: "00000000-0000-0000-0000-00000000fffe" as UUID,
									roomId: "00000000-0000-0000-0000-000000001111" as UUID,
									createdAt: 2,
									content: {
										text: "[sub-agent: old build (opencode) — task_complete]\n[tool output: ls]\nstale raw transcript",
										source: "acpx:sub-agent-router",
										metadata: { subAgent: true },
									},
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
					RUNTIME_MODEL_CONTEXT: {
						text: "# Runtime Model Context\n- Response handler model: gpt-oss-120b",
						providerName: "RUNTIME_MODEL_CONTEXT",
					},
				},
			},
			text: "fallback text should not be needed",
		};
		state.data.providerOrder = [
			"RECENT_MESSAGES",
			"RUNTIME_MODEL_CONTEXT",
			"PROVIDERS",
			"CHARACTER",
		];

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
		// Stage 1 uses structured prior messages when RECENT_MESSAGES exposes
		// data.recentMessages. Rendering the provider text too would duplicate the
		// dialogue and can leak stored assistant thought/action metadata.
		expect(userContent).not.toContain("provider:RECENT_MESSAGES:");
		expect(userContent).not.toContain("# Conversation Messages");
		expect(userContent).not.toContain("full recent provider text");
		expect(userContent).toContain("prior_message:user:");
		expect(userContent).toContain("current_turn_boundary:");
		expect(userContent).toContain("message:user:");
		expect(userContent).toContain(longUserText);
		expect(userContent).not.toContain("[sub-agent: old build");
		expect(userContent).not.toContain("stale raw transcript");
		expect(userContent).toContain("Can you check my calendar?");
		expect(userContent.indexOf("prior_message:user:")).toBeLessThan(
			userContent.indexOf("current_turn_boundary:"),
		);
		expect(userContent.indexOf("current_turn_boundary:")).toBeLessThan(
			userContent.lastIndexOf("message:user:"),
		);
		expect(userContent).not.toContain("user_role:");
		const fullPrompt = `${params.prompt ?? ""}\n${systemContent}\n${userContent}`;
		expect(fullPrompt).toContain("# Runtime Model Context");
		expect(fullPrompt).toContain("Response handler model: gpt-oss-120b");
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
		expect(providerNames).toContain("RUNTIME_MODEL_CONTEXT");
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
