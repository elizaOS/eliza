/**
 * Live-drop regressions through the REAL Stage-1 pipeline seam
 * (runV5MessageRuntimeStage1): on 2026-08-26 (room f26fec5e) two bot-stamped
 * owner probes whose Stage-1 plans committed to tool work — "can you re-run
 * that binary matrix thing and paste the output here when it lands?"
 * (contexts=["general"], requiresTool=true; trajectory tj-b014fedf6c8211) and
 * "hows the quiz master build going? is it done?" (candidates
 * GET_TASK_STATUS/CHECK_BUILD_STATUS, uncorroborated addressedTo tag;
 * trajectory tj-bcb32b4ffbba84) — were terminally silenced by the engagement
 * gate's agent-chatter damping arm: single messageHandler stage, no
 * toolSearch, no planner, nothing delivered. These tests drive the exact live
 * shapes through the service seam and pin the invariant that a tool-committed
 * plan reaches the planner, while simple-path chatter damping and the
 * verified-addressing arms (#9874) keep their coverage. The suite also pins
 * the two adjacent shapes: a field-evaluator preempt terminally ships its ack
 * even when the model routed planning contexts and candidates, and the
 * core.stage1_execution_claim_guard promotion provably reaches the planner
 * end-to-end. Fabricated runtime, queued model responses — no live model, no
 * database.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Entity, Memory } from "../types/index";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const BOT_SENDER = "00000000-0000-0000-0000-0000000000bb" as UUID;
const OTHER_PARTICIPANT = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

let idCounter = 0;
function nextId(): UUID {
	idCounter += 1;
	return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}` as UUID;
}

function stage1Response(fields: {
	shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
	contexts?: string[];
	candidateActionNames?: string[];
	replyText?: string;
	addressedTo?: string[];
}) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: fields.shouldRespond ?? "RESPOND",
					thought: "",
					contexts: fields.contexts ?? [],
					intents: [],
					candidateActionNames: fields.candidateActionNames ?? [],
					replyText: fields.replyText ?? "",
					facts: [],
					relationships: [],
					addressedTo: fields.addressedTo ?? [],
				},
			},
		],
	};
}

function plannerReply(messageToUser: string): string {
	return JSON.stringify({
		thought: "Answer the user.",
		toolCalls: [],
		messageToUser,
	});
}

/** Prior room message authored by this agent (counts toward an agent run). */
function agentHistoryMessage(createdAt: number): Memory {
	return {
		id: nextId(),
		entityId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt,
		content: { text: "here's what you've got.", channelType: "GROUP" },
	} as Memory;
}

/** Prior room message from the bot-stamped probe sender. */
function botHistoryMessage(createdAt: number, text: string): Memory {
	return {
		id: nextId(),
		entityId: BOT_SENDER,
		roomId: ROOM_ID,
		createdAt,
		content: {
			text,
			channelType: "GROUP",
			metadata: { fromBot: true },
		},
	} as Memory;
}

/** Incoming group message from the bot-stamped sender (the live probe shape). */
function botGroupMessage(text: string): Memory {
	return {
		id: nextId(),
		entityId: BOT_SENDER,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt: 100,
		content: {
			text,
			source: "discord",
			channelType: ChannelType.GROUP,
			metadata: { fromBot: true },
		},
	} as Memory;
}

function makeState(): State {
	return {
		values: { availableContexts: "general" },
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntime(args: {
	responses: unknown[];
	history?: Memory[];
	participants?: Entity[];
}): IAgentRuntime {
	const queue = [...args.responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Remilio",
			system: "You are concise.",
			bio: "I help with builds.",
		},
		actions: [],
		providers: [],
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		getEntitiesForRoom: vi.fn(
			async () =>
				args.participants ??
				([
					{ id: AGENT_ID, names: ["Remilio"] },
					{ id: BOT_SENDER, names: ["nubs-e2e"] },
				] as Entity[]),
		),
		getMemories: vi.fn(async () => args.history ?? []),
		getRelationships: vi.fn(async () => []),
		createRelationship: vi.fn(async () => true),
		updateRelationship: vi.fn(async () => undefined),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
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
	} as unknown as IAgentRuntime;
}

/** Trailing all-agent run long enough to arm chatter damping (threshold 4). */
function allAgentRunHistory(): Memory[] {
	return [
		botHistoryMessage(1, "Remilio show me the logs of everything running"),
		agentHistoryMessage(2),
		botHistoryMessage(3, "Remilio whats my reminder list?"),
		agentHistoryMessage(4),
	];
}

describe("engagement gate vs tool-committed Stage-1 plans (live 2026-08-26 drops)", () => {
	it("serves a requiresTool follow-up from a bot-stamped sender amid an all-agent run (tj-b014fedf6c8211)", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["general"],
					replyText: "On it.",
				}),
				plannerReply("here's the binary matrix output: 0110 1001."),
			],
			history: allAgentRunHistory(),
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: botGroupMessage(
				"can you re-run that binary matrix thing and paste the output here when it lands?",
			),
			state: makeState(),
			responseId: nextId(),
		});

		// The live drop ended here as {kind: "terminal", action: "IGNORE"} with a
		// single model call — the plan (requiresTool=true) never reached the
		// planner and the user got total silence.
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"here's the binary matrix output: 0110 1001.",
			);
		}
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("serves a candidates-present status ask with an uncorroborated addressee tag (tj-bcb32b4ffbba84)", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["general"],
					candidateActionNames: ["GET_TASK_STATUS", "CHECK_BUILD_STATUS"],
					replyText: "Let me check on that for you.",
					addressedTo: ["1gig"],
				}),
				plannerReply("quiz-master is still open — the build session crashed."),
			],
			history: allAgentRunHistory(),
			participants: [
				{ id: AGENT_ID, names: ["Remilio"] },
				{ id: BOT_SENDER, names: ["nubs-e2e"] },
				{ id: OTHER_PARTICIPANT, names: ["1gig"] },
			] as Entity[],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			// The text never names "1gig", so the Stage-1 tag is uncorroborated
			// and must not silence the turn by itself; the damping arm must then
			// stand down because the plan names candidate actions.
			message: botGroupMessage("hows the quiz master build going? is it done?"),
			state: makeState(),
			responseId: nextId(),
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"quiz-master is still open — the build session crashed.",
			);
		}
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("still silences simple-path chatter capping an all-agent run (2026-08-24 damping coverage)", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["simple"],
					replyText:
						"fair. a lot of noise just to figure out who was talking to who.",
				}),
			],
			history: allAgentRunHistory(),
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: botGroupMessage("what a waste of tokens or compute"),
			state: makeState(),
			responseId: nextId(),
		});

		expect(result.kind).toBe("terminal");
		if (result.kind === "terminal") {
			expect(result.action).toBe("IGNORE");
		}
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});

	it("still silences a tool-shaped turn verifiably addressed to another participant (#9874)", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["general"],
					candidateActionNames: ["SHELL"],
					replyText: "On it.",
					addressedTo: ["bob"],
				}),
			],
			participants: [
				{ id: AGENT_ID, names: ["Remilio"] },
				{ id: BOT_SENDER, names: ["nubs-e2e"] },
				{ id: OTHER_PARTICIPANT, names: ["bob"] },
			] as Entity[],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			// The text corroborates the tag (it names bob), so the VERIFIED
			// addressing arm silences the turn even though the plan commits to
			// tool work — the ask belongs to bob, not to this agent.
			message: botGroupMessage(
				"bob can you re-run the deploy and paste what it prints?",
			),
			state: makeState(),
			responseId: nextId(),
		});

		expect(result.kind).toBe("terminal");
		if (result.kind === "terminal") {
			expect(result.action).toBe("IGNORE");
		}
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});
});

describe("field-evaluator preempt routing (adjacent shape a)", () => {
	it("terminally ships the preempt ack even when the model routed contexts and candidates", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["general"],
					candidateActionNames: ["SHELL"],
					replyText: "On it.",
				}),
			],
		});
		// A preempting field handler (the threadOps-abort shape): it stages its
		// own ack and preempts. The turn must end with that ack as the final
		// reply — no planner, no promotion resurrecting the leftover "general"
		// context or the SHELL candidate.
		runtime.responseHandlerFieldRegistry.register({
			name: "testAbortOps",
			description: "Test-only preempting field (abort shape).",
			priority: 30,
			schema: { type: "array", items: { type: "string" } },
			handle: () => ({
				mutateResult: (result) => {
					result.replyText = "stopping that now.";
				},
				preempt: { mode: "ack-and-stop", reason: "user retracted request" },
			}),
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: {
				id: nextId(),
				entityId: BOT_SENDER,
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				createdAt: 100,
				content: {
					text: "wait, stop that",
					source: "test",
					channelType: ChannelType.DM,
				},
			} as Memory,
			state: makeState(),
			responseId: nextId(),
		});

		expect(result.kind).toBe("direct_reply");
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("stopping that now.");
		}
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});
});

describe("execution-claim guard promotion end-to-end (adjacent shape b)", () => {
	it("routes the guard's requiresTool promotion into the planner through message.ts", async () => {
		const runtime = makeRuntime({
			responses: [
				stage1Response({
					contexts: ["simple"],
					replyText: "i'll re-run the t=3 action now, one second.",
				}),
				plannerReply("ran it: t=3 finished clean."),
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: {
				id: nextId(),
				entityId: BOT_SENDER,
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				createdAt: 100,
				content: {
					text: "run the t=3 action again",
					source: "test",
					channelType: ChannelType.DM,
				},
			} as Memory,
			state: makeState(),
			responseId: nextId(),
		});

		// core.stage1_execution_claim_guard must have replaced the promise with
		// the canonical ack and promoted the turn to planning — and the route
		// must honor that promotion with a real planner pass.
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"ran it: t=3 finished clean.",
			);
		}
		expect(result.messageHandler?.plan.requiresTool).toBe(true);
		expect(result.messageHandler?.plan.reply).toBe("On it.");
		expect(
			(runtime.useModel as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});
});
