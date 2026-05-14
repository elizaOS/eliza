import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../types/components";
import type { AgentContext } from "../types/contexts";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { getActiveRoutingContextsForTurn } from "../utils/context-routing";

const MSG_ID = "00000000-0000-0000-0000-100000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-100000000002" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-100000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-100000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-100000000005" as UUID;

function makeMessage(text: string): Memory {
	return {
		id: MSG_ID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "test" },
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {},
		data: {},
		text: "Recent conversation summary",
	};
}

interface CannedResponse {
	body: unknown;
}

function createResponseHandlerFieldRegistry(): ResponseHandlerFieldRegistry {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return responseHandlerFieldRegistry;
}

function makeRuntime(opts: {
	actions: Action[];
	responses: CannedResponse[];
}): IAgentRuntime {
	const queue = [...opts.responses];
	const responseHandlerFieldRegistry = createResponseHandlerFieldRegistry();
	const calls: Array<{
		modelType: unknown;
		params: unknown;
		provider: unknown;
	}> = [];
	const runtime = {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I route actions.",
		},
		actions: opts.actions,
		providers: [],
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		composeState: vi.fn(async () => makeState()),
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => undefined),
		useModel: vi.fn(
			async (modelType: unknown, params: unknown, provider: unknown) => {
				calls.push({ modelType, params, provider });
				if (queue.length === 0) {
					throw new Error(`Unexpected useModel call: ${String(modelType)}`);
				}
				return queue.shift()?.body;
			},
		),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as IAgentRuntime & { __calls: typeof calls };
	runtime.__calls = calls;
	return runtime;
}

function getCalls(runtime: IAgentRuntime): Array<{
	modelType: unknown;
	params: unknown;
	provider: unknown;
}> {
	return (
		runtime as {
			__calls: Array<{
				modelType: unknown;
				params: unknown;
				provider: unknown;
			}>;
		}
	).__calls;
}

function makeAction(opts: {
	name: string;
	description?: string;
	contexts?: AgentContext[];
	subActions?: Array<string | Action>;
	validate?: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options?: HandlerOptions,
	) => Promise<boolean>;
	handler?: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options: HandlerOptions,
		callback?: HandlerCallback,
	) => Promise<ActionResult>;
}): Action {
	return {
		name: opts.name,
		description: opts.description ?? `${opts.name} action`,
		similes: [],
		examples: [],
		parameters: [],
		contexts: opts.contexts,
		subActions: opts.subActions,
		validate: opts.validate ?? (async () => true),
		handler:
			opts.handler ??
			(async () => ({
				success: true,
				text: `${opts.name} completed`,
				data: { actionName: opts.name },
			})),
	} as Action;
}

function stage1Response(fields: {
	shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
	contexts?: string[];
	intents?: string[];
	candidateActionNames?: string[];
	replyText?: string;
}): CannedResponse {
	return {
		body: {
			text: "",
			toolCalls: [
				{
					id: "handle-response-1",
					name: "HANDLE_RESPONSE",
					arguments: {
						shouldRespond: fields.shouldRespond ?? "RESPOND",
						contexts: fields.contexts ?? [],
						intents: fields.intents ?? [],
						candidateActionNames: fields.candidateActionNames ?? [],
						replyText: fields.replyText ?? "",
						facts: [],
						relationships: [],
						addressedTo: [],
					},
				},
			],
		},
	};
}

function plannerToolResponse(
	name: string,
	args: Record<string, unknown> = {},
): CannedResponse {
	return {
		body: {
			text: "",
			toolCalls: [{ id: `${name.toLowerCase()}-1`, name, args }],
		},
	};
}

function finishEvaluatorResponse(messageToUser = "Done."): CannedResponse {
	return {
		body: JSON.stringify({
			success: true,
			decision: "FINISH",
			thought: messageToUser,
			messageToUser,
		}),
	};
}

function plannerUserContent(runtime: IAgentRuntime): string {
	const plannerCall = getCalls(runtime).find(
		(call) => call.modelType === ModelType.ACTION_PLANNER,
	);
	const params = plannerCall?.params as
		| { messages?: Array<{ role?: string; content?: string }> }
		| undefined;
	return (
		params?.messages?.map((message) => message.content ?? "").join("\n") ?? ""
	);
}

function availableActionsSection(runtime: IAgentRuntime): string {
	// Post-PLAN_ACTIONS-wrapper refactor: actions are exposed as native tools
	// on the planner call, not in an `available_actions` text block. Synthesize
	// a section-like view from the tool definitions so the tier-A vs tier-B
	// assertions in this file can still inspect action name presence and order.
	const plannerCall = getCalls(runtime).find(
		(call) => call.modelType === ModelType.ACTION_PLANNER,
	);
	const tools = (
		plannerCall?.params as
			| { tools?: Array<{ name?: string; description?: string }> }
			| undefined
	)?.tools;
	if (!tools || tools.length === 0) {
		return plannerUserContent(runtime);
	}
	return tools
		.map((tool) => `- ${tool.name ?? ""}: ${tool.description ?? ""}`)
		.join("\n");
}

describe("v5 tiered action surface", () => {
	let originalTrajectoryEnv: string | undefined;

	beforeEach(() => {
		originalTrajectoryEnv = process.env.ELIZA_TRAJECTORY_RECORDING;
		process.env.ELIZA_TRAJECTORY_RECORDING = "0";
	});

	afterEach(() => {
		if (originalTrajectoryEnv === undefined) {
			delete process.env.ELIZA_TRAJECTORY_RECORDING;
		} else {
			process.env.ELIZA_TRAJECTORY_RECORDING = originalTrajectoryEnv;
		}
	});

	it("uses Stage 1 hints to promote a parent to Tier A and expose children", async () => {
		const playMusic = makeAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
			contexts: ["music_child" as AgentContext],
		});
		const pauseMusic = makeAction({
			name: "PAUSE_MUSIC",
			description: "Pause the active track.",
			contexts: ["music_child" as AgentContext],
		});
		const music = makeAction({
			name: "MUSIC",
			description: "Music control parent action.",
			contexts: ["music" as AgentContext],
			subActions: ["PLAY_MUSIC", "PAUSE_MUSIC"],
		});
		const email = makeAction({
			name: "SEND_EMAIL",
			description: "Send an email.",
			contexts: ["email" as AgentContext],
		});
		const runtime = makeRuntime({
			actions: [music, playMusic, pauseMusic, email],
			responses: [
				stage1Response({
					contexts: ["music"],
					candidateActionNames: ["play_music", "MUSIC"],
				}),
				plannerToolResponse("PLAY_MUSIC"),
				finishEvaluatorResponse("Playing music."),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("play the new album"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const prompt = availableActionsSection(runtime);
		expect(prompt).toContain("MUSIC");
		expect(prompt).toContain("PLAY_MUSIC");
		expect(prompt).toContain("PAUSE_MUSIC");
		expect(prompt).not.toContain("SEND_EMAIL");
	});

	it("expands strong context matches into callable actions", async () => {
		const createEvent = makeAction({
			name: "CREATE_EVENT",
			description: "Create a calendar event.",
			contexts: ["calendar_write" as AgentContext],
		});
		const calendar = makeAction({
			name: "CALENDAR",
			description: "Calendar scheduling and event management.",
			contexts: ["calendar" as AgentContext],
			subActions: ["CREATE_EVENT"],
		});
		const chat = makeAction({
			name: "CHAT_MESSAGE",
			description: "Send a chat message.",
			contexts: ["calendar" as AgentContext],
		});
		const runtime = makeRuntime({
			actions: [calendar, createEvent, chat],
			responses: [
				stage1Response({ contexts: ["calendar"] }),
				plannerToolResponse("CHAT_MESSAGE"),
				finishEvaluatorResponse("Calendar checked."),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("calendar"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const prompt = availableActionsSection(runtime);
		expect(prompt).toContain("CALENDAR");
		expect(prompt).toContain("CREATE_EVENT");
		expect(prompt).toContain("CHAT_MESSAGE");
	});

	it("carries Stage 1 contexts into action validation and execution", async () => {
		let messageCalls = 0;
		const message = makeAction({
			name: "MESSAGE",
			description:
				"Primary email and messaging action for inbox review and unread email summaries.",
			contexts: ["email"],
			validate: async (_runtime, msg, state) =>
				getActiveRoutingContextsForTurn(state, msg).includes("email"),
			handler: async () => {
				messageCalls++;
				return {
					success: true,
					text: "summarized unread email",
					data: { actionName: "MESSAGE" },
				};
			},
		});
		const runtime = makeRuntime({
			actions: [message],
			responses: [
				stage1Response({
					contexts: ["email"],
					candidateActionNames: ["summarize_unread_emails", "MESSAGE"],
				}),
				{
					body: {
						text: "",
						toolCalls: [
							{
								id: "message-1",
								name: "MESSAGE",
								arguments: {},
							},
						],
					},
				},
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Message action completed.",
						messageToUser: "summarized unread email",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("summarize my unread emails"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(messageCalls).toBe(1);
		expect(availableActionsSection(runtime)).toContain("MESSAGE");
	});

	it("exposes Tier-A sub-actions as first-class planner tools alongside the parent", async () => {
		// This is the core guarantee: when MUSIC is in Tier A, its sub-actions
		// PLAY_MUSIC and PAUSE_MUSIC are first-class entries in the planner's
		// `tools` array (not just hidden behind a "dig into parent" round-trip).
		const playMusic = makeAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
			contexts: ["music_child" as AgentContext],
		});
		const pauseMusic = makeAction({
			name: "PAUSE_MUSIC",
			description: "Pause the active track.",
			contexts: ["music_child" as AgentContext],
		});
		const music = makeAction({
			name: "MUSIC",
			description: "Music control parent action.",
			contexts: ["music" as AgentContext],
			subActions: ["PLAY_MUSIC", "PAUSE_MUSIC"],
		});
		const email = makeAction({
			name: "SEND_EMAIL",
			description: "Send an email.",
			contexts: ["email" as AgentContext],
		});
		const runtime = makeRuntime({
			actions: [music, playMusic, pauseMusic, email],
			responses: [
				stage1Response({
					contexts: ["music"],
					candidateActionNames: ["play_music", "MUSIC"],
				}),
				plannerToolResponse("PLAY_MUSIC"),
				finishEvaluatorResponse("Playing music."),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("play the new album"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const plannerCall = getCalls(runtime).find(
			(call) => call.modelType === ModelType.ACTION_PLANNER,
		);
		const tools = (
			plannerCall?.params as { tools?: Array<{ name?: string }> } | undefined
		)?.tools;
		const toolNames = tools?.map((tool) => tool.name).filter(Boolean) ?? [];
		expect(toolNames).toContain("MUSIC");
		expect(toolNames).toContain("PLAY_MUSIC");
		expect(toolNames).toContain("PAUSE_MUSIC");
		// Universal terminals must still be appended.
		expect(toolNames).toContain("REPLY");
		expect(toolNames).toContain("IGNORE");
		expect(toolNames).toContain("STOP");
		// Sibling-context action that is not in Tier A / Tier B should not leak in.
		expect(toolNames).not.toContain("SEND_EMAIL");
	});

	it("lets a Tier B parent invoke its sub-planner and execute child actions", async () => {
		let createEventCalls = 0;
		const createEvent = makeAction({
			name: "CREATE_EVENT",
			description: "Create a calendar event.",
			contexts: ["calendar_write" as AgentContext],
			handler: async () => {
				createEventCalls++;
				return {
					success: true,
					text: "created event",
					data: { actionName: "CREATE_EVENT" },
				};
			},
		});
		const calendar = makeAction({
			name: "CALENDAR",
			description: "Calendar scheduling and event management.",
			contexts: ["calendar" as AgentContext],
			subActions: ["CREATE_EVENT"],
		});
		const runtime = makeRuntime({
			actions: [calendar, createEvent],
			responses: [
				stage1Response({ contexts: ["calendar"] }),
				{
					body: {
						text: "Using calendar.",
						toolCalls: [{ id: "top-1", name: "CALENDAR", arguments: {} }],
					},
				},
				{
					body: {
						text: "Creating the event.",
						toolCalls: [{ id: "child-1", name: "CREATE_EVENT", arguments: {} }],
					},
				},
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Child action completed.",
						messageToUser: "created event",
					}),
				},
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Calendar task completed.",
						messageToUser: "created event",
					}),
				},
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("calendar"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(createEventCalls).toBe(1);
		expect(
			getCalls(runtime).filter(
				(call) => call.modelType === ModelType.ACTION_PLANNER,
			),
		).toHaveLength(2);
	});
});
