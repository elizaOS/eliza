/**
 * Failure-reply gating when the v5 message runtime dies BEFORE any
 * RESPOND/IGNORE decision exists.
 *
 * Rate limits and provider outages throw from the Stage 1 model call itself,
 * so no shouldRespond decision was ever made for the turn. The old behavior
 * unconditionally sent the canned "something went wrong" reply — observed
 * live as 91 canned-failure sends in 2 days into group relay rooms that never
 * addressed the agent. The pipeline must:
 *
 *   1. stay SILENT (terminal IGNORE, no user-visible text) when the failing
 *      turn was ambiguous group traffic the agent would have ignored, and
 *   2. still surface the failure text when the turn deterministically
 *      addressed the agent (platform mention/reply, DM/API channel).
 *
 * These tests drive the real `DefaultMessageService.handleMessage` pipeline —
 * memory persistence, room fetch, Stage 1 dispatch, the failure catch, and
 * terminal delivery — with only the runtime I/O surface mocked. The Stage 1
 * `useModel` call rejects with a real provider rate-limit error, exactly like
 * the live incident.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { DefaultMessageService } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000000a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000000b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000000c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000000d" as UUID;

const RATE_LIMIT_ERROR = new Error(
	"[cli-inference:sdk] subscription rate limit reached: You've hit your session limit",
);

function makeMessage(overrides: Partial<Content> = {}): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "anyone up for a raid tonight?",
			source: "discord",
			channelType: ChannelType.GROUP,
			...overrides,
		},
		createdAt: Date.now(),
	};
}

function makeState(): State {
	return { values: {}, data: {}, text: "" };
}

function makeFailingRuntime(room: Room): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Remilio",
			bio: "test agent",
		},
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getModel: vi.fn(() => async () => {
			throw RATE_LIMIT_ERROR;
		}),
		// Stage 1 RESPONSE_HANDLER dies with a provider rate limit — the same
		// shape as the live incident. Every other model call (the failure-reply
		// generator retries TEXT_* models) fails the same way, which routes
		// buildStructuredFailureReply onto its rate-limited template path.
		useModel: vi.fn(async () => {
			throw RATE_LIMIT_ERROR;
		}),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => room),
		getRoomsByIds: vi.fn(async () => [room]),
		getMemories: vi.fn(async () => []),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
}

function makeRoom(type: ChannelType): Room {
	return {
		id: ROOM,
		source: "discord",
		type,
	} as Room;
}

async function runTurn(message: Memory, room: Room) {
	const runtime = makeFailingRuntime(room);
	const service = new DefaultMessageService();
	const deliveries: Content[] = [];
	const result = await service.handleMessage(
		runtime,
		message,
		async (content) => {
			deliveries.push(content);
			return [];
		},
	);
	// Everything the callback delivered with visible text — what a connector
	// would actually post to the channel.
	const visibleTexts = deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
	return { runtime, result, deliveries, visibleTexts };
}

describe("v5 runtime failure before a respond decision", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("stays silent on ambiguous group traffic the agent would have ignored", async () => {
		const { result, deliveries, visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
		);

		// No user-visible text may leave the pipeline — the canned failure
		// reply into an unaddressed relay room was the bug.
		expect(visibleTexts).toEqual([]);
		expect(result.didRespond).toBe(false);
		// The turn resolves as a terminal IGNORE, exactly like the decision the
		// agent would have made had Stage 1 survived.
		const terminal = deliveries.find((content) =>
			Array.isArray(content.actions),
		);
		expect(terminal?.actions).toEqual(["IGNORE"]);
	});

	it("still surfaces the failure reply when the agent was platform-mentioned", async () => {
		const { result, visibleTexts } = await runTurn(
			makeMessage({
				text: "@Remilio what's the plan?",
				mentionContext: { isMention: true },
			}),
			makeRoom(ChannelType.GROUP),
		);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
		// buildStructuredFailureReply lands on the rate-limited template since
		// every model call in this turn is rate-limited.
		expect(visibleTexts[0].toLowerCase()).toContain("rate-limit");
	});

	it("still surfaces the failure reply on private DM channels", async () => {
		const { result, visibleTexts } = await runTurn(
			makeMessage({ channelType: ChannelType.DM }),
			makeRoom(ChannelType.DM),
		);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
	});
});

describe("planner failure after a promoted stage-1 answer", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const SUBSTANTIVE =
		"The top 3 contributors are lalalune, shakkernerd, and odilitime.";

	it("surfaces the preserved stage-0 answer instead of the canned failure", async () => {
		// Stage 1 answers the question, a response-handler evaluator promotes the
		// turn to planning while overwriting the reply with a progress ack, and
		// the planner model then dies with a rate limit. The turn already HAS the
		// answer — it must reach the user, not a transient-failure apology.
		const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			responseHandlerFieldRegistry.register(evaluator);
		}
		const modelCallTypes: string[] = [];
		let stage1Served = false;
		const runtime = createMockRuntime({
			agentId: AGENT,
			character: { name: "Remilio", bio: "test agent" },
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
			} as unknown as IAgentRuntime["logger"],
			getSetting: vi.fn(() => undefined),
			getService: vi.fn(() => null),
			getModel: vi.fn(() => async () => {
				throw RATE_LIMIT_ERROR;
			}),
			// Stage 1 succeeds with the substantive answer; every later model call
			// (the planner) hits the provider rate limit.
			useModel: vi.fn(async (modelType: unknown) => {
				modelCallTypes.push(String(modelType));
				if (String(modelType) === "RESPONSE_HANDLER" && !stage1Served) {
					stage1Served = true;
					return {
						text: "",
						toolCalls: [
							{
								id: "handle-response-1",
								name: "HANDLE_RESPONSE",
								arguments: {
									shouldRespond: "RESPOND",
									thought: "",
									contexts: ["general"],
									intents: [],
									candidateActionNames: [],
									replyText: SUBSTANTIVE,
									facts: [],
									relationships: [],
									addressedTo: [],
								},
							},
						],
					};
				}
				throw RATE_LIMIT_ERROR;
			}),
			composeState: vi.fn(async () => makeState()),
			runActionsByMode: vi.fn(async () => undefined),
			applyPipelineHooks: vi.fn(async () => undefined),
			emitEvent: vi.fn(async () => undefined),
			startRun: vi.fn(() => RUN_ID),
			getCurrentRunId: vi.fn(() => RUN_ID),
			endRun: vi.fn(),
			getMemoryById: vi.fn(async () => null),
			createMemory: vi.fn(async () => asUUID(v4())),
			updateMemory: vi.fn(async () => true),
			queueEmbeddingGeneration: vi.fn(async () => undefined),
			getParticipantUserState: vi.fn(async () => null),
			getRoom: vi.fn(async () => makeRoom(ChannelType.DM)),
			getRoomsByIds: vi.fn(async () => [makeRoom(ChannelType.DM)]),
			getMemories: vi.fn(async () => []),
			isCheckShouldRespondEnabled: vi.fn(() => true),
			turnControllers: new TurnControllerRegistry(),
			responseHandlerFieldRegistry,
			responseHandlerFieldEvaluators: [
				...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
			],
			responseHandlerEvaluators: [
				{
					name: "test-clobber-to-ack",
					priority: 100,
					shouldRun: () => true,
					evaluate: () => ({ reply: "On it.", requiresTool: true }),
				},
			],
		} as never);

		const service = new DefaultMessageService();
		const deliveries: Content[] = [];
		const result = await service.handleMessage(
			runtime,
			makeMessage({ channelType: ChannelType.DM }),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);

		const visibleTexts = deliveries
			.map((content) => (typeof content.text === "string" ? content.text : ""))
			.filter((text) => text.trim().length > 0);

		expect(result.didRespond).toBe(true);
		// The preserved stage-0 answer reaches the user; the canned rate-limit
		// apology does not replace an answer the turn already produced.
		expect(visibleTexts.join("\n"), modelCallTypes.join(",")).toContain(
			"lalalune",
		);
		expect(visibleTexts.join("\n").toLowerCase()).not.toContain("rate-limit");
	});
});
