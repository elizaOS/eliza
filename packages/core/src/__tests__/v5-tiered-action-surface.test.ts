import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeRuntime(opts: {
	actions: Action[];
	responses: CannedResponse[];
}): IAgentRuntime {
	const queue = [...opts.responses];
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
	} as unknown as IAgentRuntime & { __calls: typeof calls };
	runtime.__calls = calls;
	return runtime;
}

function getCalls(runtime: IAgentRuntime): Array<{
	modelType: unknown;
	params: unknown;
	provider: unknown;
}> {
	return (
		runtime as unknown as {
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
		validate: async () => true,
		handler:
			opts.handler ??
			(async () => ({
				success: true,
				text: `${opts.name} completed`,
				data: { actionName: opts.name },
			})),
	} as unknown as Action;
}

function stage1Response(plan: Record<string, unknown>): CannedResponse {
	return {
		body: JSON.stringify({
			processMessage: "RESPOND",
			plan,
			thought: "Planning required.",
		}),
	};
}

function replyPlannerResponse(): CannedResponse {
	return {
		body: {
			text: "ok",
			toolCalls: [{ id: "reply-1", name: "REPLY", args: { text: "ok" } }],
		},
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

describe("v5 tiered action surface", () => {
	let originalTieredEnv: string | undefined;
	let originalTrajectoryEnv: string | undefined;

	beforeEach(() => {
		originalTieredEnv = process.env.MILADY_TIERED_ACTION_SURFACE;
		originalTrajectoryEnv = process.env.MILADY_TRAJECTORY_RECORDING;
		process.env.MILADY_TRAJECTORY_RECORDING = "0";
		delete process.env.MILADY_TIERED_ACTION_SURFACE;
	});

	afterEach(() => {
		if (originalTieredEnv === undefined) {
			delete process.env.MILADY_TIERED_ACTION_SURFACE;
		} else {
			process.env.MILADY_TIERED_ACTION_SURFACE = originalTieredEnv;
		}
		if (originalTrajectoryEnv === undefined) {
			delete process.env.MILADY_TRAJECTORY_RECORDING;
		} else {
			process.env.MILADY_TRAJECTORY_RECORDING = originalTrajectoryEnv;
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
			contexts: ["music" as AgentContext],
		});
		const runtime = makeRuntime({
			actions: [music, playMusic, pauseMusic, email],
			responses: [
				stage1Response({
					contexts: ["music"],
					candidateActions: ["play_music"],
					parentActionHints: ["MUSIC"],
				}),
				replyPlannerResponse(),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("play the new album"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const prompt = plannerUserContent(runtime);
		expect(prompt).toContain("MUSIC");
		expect(prompt).toContain("PLAY_MUSIC");
		expect(prompt).toContain("PAUSE_MUSIC");
		expect(prompt).not.toContain("SEND_EMAIL");
	});

	it("keeps ambiguous BM25 matches at Tier B parent-only", async () => {
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
				replyPlannerResponse(),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("calendar"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const prompt = plannerUserContent(runtime);
		expect(prompt).toContain("CALENDAR");
		expect(prompt).not.toContain("CREATE_EVENT");
		expect(prompt).not.toContain("CHAT_MESSAGE");
	});

	it("falls back to the full gated action surface when disabled", async () => {
		process.env.MILADY_TIERED_ACTION_SURFACE = "0";
		const calendar = makeAction({
			name: "CALENDAR",
			description: "Calendar scheduling.",
			contexts: ["calendar" as AgentContext],
		});
		const chat = makeAction({
			name: "CHAT_MESSAGE",
			description: "Send a chat message.",
			contexts: ["calendar" as AgentContext],
		});
		const runtime = makeRuntime({
			actions: [calendar, chat],
			responses: [
				stage1Response({ contexts: ["calendar"] }),
				replyPlannerResponse(),
			],
		});

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("calendar"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		const prompt = plannerUserContent(runtime);
		expect(prompt).toContain("CALENDAR");
		expect(prompt).toContain("CHAT_MESSAGE");
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
						toolCalls: [{ id: "top-1", name: "CALENDAR", args: {} }],
					},
				},
				{
					body: {
						text: "Creating the event.",
						toolCalls: [{ id: "child-1", name: "CREATE_EVENT", args: {} }],
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
