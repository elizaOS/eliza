/**
 * Turn-delivery floor: an addressed turn must never end with zero user-facing
 * delivery, and every delivery must be observable. Pins the two silent-exit
 * classes found in the dropped-turn incident:
 *
 *   1. Race discard — a finished response superseded by a newer same-room
 *      message is kept (not silently dropped) whenever the turn addressed the
 *      agent, while unaddressed responses still discard. Keeping never
 *      double-replies: each inbound message gets at most one reply.
 *   2. Delivery observability — a transient/doNotPersist structured failure
 *      reply skips the memory write but still emits MESSAGE_SENT, so a
 *      delivered fallback is distinguishable from a drop in logs, activity
 *      streams, and trajectory closure.
 *
 * Drives the real `DefaultMessageService.handleMessage` pipeline end to end —
 * Stage 1 dispatch, the failure catch, the race check, and delivery — with
 * only the runtime I/O surface mocked (no live model, no network). Stage-1
 * outcomes are deterministic HANDLE_RESPONSE envelopes or provider errors.
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
import type { IAgentRuntime, ModelCallProvenance } from "../types/runtime";
import type { State } from "../types/state";
import {
	DefaultMessageService,
	resolveSupersededResponseKeepReason,
} from "./message";
import { drainPostDeliveryTasks } from "./post-delivery-task-tracker";

const RATE_LIMIT_ERROR = new Error(
	"[cli-inference:sdk] subscription rate limit reached: You've hit your session limit",
);

function stage1DirectReply(replyText: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Direct answer.",
					contexts: ["general"],
					intents: [],
					candidateActionNames: [],
					replyText,
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function stage1ActionPlan(actionName: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-action",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "The requested operation needs a registered action.",
					contexts: ["general"],
					intents: ["perform requested operation"],
					candidateActionNames: [actionName],
					replyText: "Working on it.",
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

interface Harness {
	runtime: IAgentRuntime;
	service: DefaultMessageService;
	agentId: UUID;
	roomId: UUID;
	entityId: UUID;
	runId: UUID;
	makeMessage: (text: string) => Memory;
	emittedEvents: () => Array<{ event: string; payload: unknown }>;
	persistedTexts: () => string[];
}

/**
 * Real DefaultMessageService over a mock runtime with a caller-provided
 * Stage-1 `useModel`. Fresh agent/room UUIDs per harness so the module-level
 * response-id race bookkeeping never bleeds between tests.
 */
function createHarness(
	useModelImpl: (
		harness: () => Harness,
		modelType: string,
		callIndex: number,
	) => Promise<unknown>,
): Harness {
	const agentId = asUUID(v4());
	const entityId = asUUID(v4());
	const roomId = asUUID(v4());
	const runId = asUUID(v4());
	const room: Room = {
		id: roomId,
		source: "discord",
		type: ChannelType.DM,
	} as Room;

	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}

	const emitted: Array<{ event: string; payload: unknown }> = [];
	const persisted: Memory[] = [];
	let useModelCalls = 0;

	const runtime = createMockRuntime({
		agentId,
		character: { name: "TestAgent", bio: "test agent" },
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
		useModel: vi.fn(
			async (
				modelType: unknown,
				_params: unknown,
				_provider: string | undefined,
				provenance: ModelCallProvenance | undefined,
			) => {
				useModelCalls += 1;
				const result = await useModelImpl(
					() => harness,
					String(modelType),
					useModelCalls,
				);
				if (provenance) provenance.resolvedProvider = "test-provider";
				return result;
			},
		),
		composeState: vi.fn(
			async (): Promise<State> => ({ values: {}, data: {}, text: "" }),
		),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async (event: unknown, payload: unknown) => {
			emitted.push({ event: String(event), payload });
		}),
		reportError: vi.fn(),
		startRun: vi.fn(() => runId),
		getCurrentRunId: vi.fn(() => runId),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async (memory: Memory) => {
			persisted.push(memory);
			return asUUID(v4());
		}),
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
	} as never);

	const harness: Harness = {
		runtime,
		service: new DefaultMessageService(),
		agentId,
		roomId,
		entityId,
		runId,
		makeMessage: (text: string): Memory => ({
			id: asUUID(v4()),
			entityId,
			agentId,
			roomId,
			content: {
				text,
				source: "discord",
				channelType: ChannelType.DM,
			},
			createdAt: Date.now(),
		}),
		emittedEvents: () => emitted,
		persistedTexts: () =>
			persisted
				.map((memory) =>
					typeof memory.content?.text === "string" ? memory.content.text : "",
				)
				.filter((text) => text.length > 0),
	};
	return harness;
}

function visibleTexts(deliveries: Content[]): string[] {
	return deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
}

function messageSentTexts(harness: Harness): string[] {
	return harness
		.emittedEvents()
		.filter(({ event }) => event === "MESSAGE_SENT")
		.map(({ payload }) => {
			const message = (payload as { message?: Memory }).message;
			return typeof message?.content?.text === "string"
				? message.content.text
				: "";
		})
		.filter((text) => text.length > 0);
}

describe("delivery observability floor for transient failure replies", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("delivers an honest reply AND emits MESSAGE_SENT when the planner phase ends without a delivered message", async () => {
		// The incident shape: Stage 1 (and every fallback model call) dies, so
		// the turn produces no planned reply. The addressed DM must still get
		// an honest structured failure reply, and — although the reply is
		// transient/doNotPersist and skips the memory write — its delivery must
		// be observable through MESSAGE_SENT. Before the floor, the event was
		// only emitted inside the persistence loop, so this delivered turn was
		// indistinguishable from a drop.
		const h = createHarness(async () => {
			throw RATE_LIMIT_ERROR;
		});
		const deliveries: Content[] = [];

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("whats my favorite color?"),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(result.didRespond).toBe(true);
		const delivered = visibleTexts(deliveries);
		expect(delivered).toHaveLength(1);

		// Delivery is observable: MESSAGE_SENT carries the delivered text.
		expect(messageSentTexts(h)).toContain(delivered[0]);
		// The reply stays transient: no memory row was written for it.
		expect(h.persistedTexts()).not.toContain(delivered[0]);
	});

	it("keeps MESSAGE_SENT and persistence for a normal delivered reply (single event, single row)", async () => {
		const replyText = `crimson. probe-${v4()}`;
		const h = createHarness(async (_h, modelType) => {
			if (modelType === "RESPONSE_HANDLER") return stage1DirectReply(replyText);
			throw RATE_LIMIT_ERROR;
		});
		const deliveries: Content[] = [];

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("whats my favorite color?"),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts(deliveries)).toEqual([replyText]);
		// Exactly one MESSAGE_SENT and exactly one persisted row — the floor
		// must not double-emit or double-persist the normal path.
		expect(
			messageSentTexts(h).filter((text) => text === replyText),
		).toHaveLength(1);
		expect(
			h.persistedTexts().filter((text) => text === replyText),
		).toHaveLength(1);
	});
});

describe("MESSAGE_SENT commits only after the delivery boundary succeeds", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("a rejected delivery callback produces no durable sent-claim", async () => {
		// The side-effect ordering bug: MESSAGE_SENT fired from the persist
		// pass, which runs concurrently with the delivery callback — a failed
		// delivery still produced a durable sent-claim, so downstream
		// consumers (activity streams, follow-up seeding, trajectory closure)
		// recorded a reply the user never received.
		const replyText = `crimson. probe-${v4()}`;
		const h = createHarness(async (_h, modelType) => {
			if (modelType === "RESPONSE_HANDLER") return stage1DirectReply(replyText);
			throw RATE_LIMIT_ERROR;
		});

		await expect(
			h.service.handleMessage(
				h.runtime,
				h.makeMessage("whats my favorite color?"),
				async () => {
					throw new Error("connector send failed");
				},
			),
		).rejects.toThrow("connector send failed");
		await drainPostDeliveryTasks(h.runtime);

		expect(messageSentTexts(h)).not.toContain(replyText);
		// The delivery failure does not skip persistence — the reply row is
		// stored so the retry path can observe and reconcile it.
		expect(h.persistedTexts()).toContain(replyText);
	});

	it("the retry that delivers claims exactly once", async () => {
		// The failed first attempt must leave the turn unclaimed, and the
		// successful retry must produce exactly one durable claim — never zero
		// (delivery invisible) and never two (double-claimed turn).
		const replyText = `crimson. probe-${v4()}`;
		const h = createHarness(async (_h, modelType) => {
			if (modelType === "RESPONSE_HANDLER") return stage1DirectReply(replyText);
			throw RATE_LIMIT_ERROR;
		});

		await expect(
			h.service.handleMessage(
				h.runtime,
				h.makeMessage("whats my favorite color?"),
				async () => {
					throw new Error("connector send failed");
				},
			),
		).rejects.toThrow("connector send failed");
		await drainPostDeliveryTasks(h.runtime);
		expect(
			messageSentTexts(h).filter((text) => text === replyText),
		).toHaveLength(0);

		const deliveries: Content[] = [];
		const retry = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("whats my favorite color?"),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(retry.didRespond).toBe(true);
		expect(visibleTexts(deliveries)).toEqual([replyText]);
		expect(
			messageSentTexts(h).filter((text) => text === replyText),
		).toHaveLength(1);
	});
});

describe("race-superseded turns keep addressed responses", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("delivers both replies exactly once when a newer message supersedes an in-flight addressed turn", async () => {
		// Turn 2 arrives and fully completes while turn 1's Stage-1 model call
		// is still in flight, so turn 1 finishes superseded. The addressed turn
		// keeps its reply — the user sent two messages and gets exactly one
		// reply to each; keeping the older response never double-replies.
		const firstReply = `first answer. probe-${v4()}`;
		const secondReply = `second answer. probe-${v4()}`;
		const firstDeliveries: Content[] = [];
		const secondDeliveries: Content[] = [];
		let secondTurn: Promise<unknown> | null = null;

		let stage1Calls = 0;
		const h = createHarness(async (getHarness, modelType) => {
			if (modelType !== "RESPONSE_HANDLER") throw RATE_LIMIT_ERROR;
			stage1Calls += 1;
			if (stage1Calls === 1) {
				// A newer same-room message arrives and runs to completion while
				// this Stage-1 call is still in flight.
				const inner = getHarness();
				secondTurn = inner.service.handleMessage(
					inner.runtime,
					inner.makeMessage("wait, actually a different question"),
					async (content) => {
						secondDeliveries.push(content);
						return [];
					},
				);
				await secondTurn;
				return stage1DirectReply(firstReply);
			}
			return stage1DirectReply(secondReply);
		});

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("whats my favorite color?"),
			async (content) => {
				firstDeliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(secondTurn).not.toBeNull();
		// Each inbound message got exactly one reply — no drop, no double.
		expect(visibleTexts(firstDeliveries)).toEqual([firstReply]);
		expect(visibleTexts(secondDeliveries)).toEqual([secondReply]);
		expect(result.didRespond).toBe(true);
	});

	it("keeps an addressed action-mode result when a newer message completes first", async () => {
		const actionName = "TEST_ADDRESS_ACTION";
		const firstReply = `action complete. probe-${v4()}`;
		const secondReply = `second answer. probe-${v4()}`;
		const firstDeliveries: Content[] = [];
		const secondDeliveries: Content[] = [];
		let secondTurn: Promise<unknown> | null = null;
		let responseHandlerCalls = 0;
		let actionPlannerCalls = 0;

		const h = createHarness(async (getHarness, modelType) => {
			if (modelType === "RESPONSE_HANDLER") {
				responseHandlerCalls += 1;
				return responseHandlerCalls === 1
					? stage1ActionPlan(actionName)
					: stage1DirectReply(secondReply);
			}
			if (modelType === "ACTION_PLANNER") {
				actionPlannerCalls += 1;
				if (actionPlannerCalls !== 1) throw RATE_LIMIT_ERROR;
				const inner = getHarness();
				secondTurn = inner.service.handleMessage(
					inner.runtime,
					inner.makeMessage("also answer this newer question"),
					async (content) => {
						secondDeliveries.push(content);
						return [];
					},
				);
				await secondTurn;
				return {
					thought: "Run the requested registered action.",
					toolCalls: [
						{
							id: "addressed-action-1",
							name: actionName,
							args: {},
						},
					],
				};
			}
			throw RATE_LIMIT_ERROR;
		});
		const actionHandler = vi.fn(async () => ({
			success: true,
			text: firstReply,
			userFacingText: firstReply,
			verifiedUserFacing: true,
			continueChain: false,
			data: { actionName },
		}));
		h.runtime.actions = [
			{
				name: actionName,
				tags: ["capability:read"],
				similes: [],
				description: "Exercise addressed action-mode race delivery.",
				examples: [],
				validate: async () => true,
				handler: actionHandler,
			},
		] as never;

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("perform the requested operation"),
			async (content) => {
				firstDeliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(secondTurn).not.toBeNull();
		expect(actionHandler).toHaveBeenCalledTimes(1);
		expect(visibleTexts(firstDeliveries)).toEqual([firstReply]);
		expect(visibleTexts(secondDeliveries)).toEqual([secondReply]);
		expect(result.didRespond).toBe(true);
	});

	it("still delivers the honest failure reply when the failing turn was superseded mid-generation", async () => {
		// The dropped-turn incident on a slow backend: turn 1's model call dies
		// AND a newer message already superseded the turn. The failure reply
		// must survive the race check — the user watched the agent engage a DM
		// and silence is not an acceptable terminal state.
		const secondReply = `second answer. probe-${v4()}`;
		const firstDeliveries: Content[] = [];
		const secondDeliveries: Content[] = [];
		let secondTurn: Promise<unknown> | null = null;
		let firstStage1Seen = false;

		const h = createHarness(async (getHarness, modelType, _callIndex) => {
			if (modelType === "RESPONSE_HANDLER" && !firstStage1Seen) {
				firstStage1Seen = true;
				const inner = getHarness();
				secondTurn = inner.service.handleMessage(
					inner.runtime,
					inner.makeMessage("also, are you there?"),
					async (content) => {
						secondDeliveries.push(content);
						return [];
					},
				);
				await secondTurn;
				throw RATE_LIMIT_ERROR;
			}
			if (modelType === "RESPONSE_HANDLER") {
				return stage1DirectReply(secondReply);
			}
			throw RATE_LIMIT_ERROR;
		});

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage("whats my favorite color?"),
			async (content) => {
				firstDeliveries.push(content);
				return [];
			},
		);
		await drainPostDeliveryTasks(h.runtime);

		expect(secondTurn).not.toBeNull();
		expect(visibleTexts(secondDeliveries)).toEqual([secondReply]);
		// The superseded failing turn still delivered exactly one honest reply.
		expect(result.didRespond).toBe(true);
		expect(visibleTexts(firstDeliveries)).toHaveLength(1);
		// And its delivery is observable even though the reply is transient.
		expect(messageSentTexts(h)).toContain(visibleTexts(firstDeliveries)[0]);
	});
});

describe("resolveSupersededResponseKeepReason policy", () => {
	it("keeps an explicit REPLY", () => {
		expect(resolveSupersededResponseKeepReason({ actions: ["REPLY"] })).toBe(
			"explicit REPLY for an addressed message",
		);
	});

	it("keeps RESPOND (the REPLY alias)", () => {
		expect(resolveSupersededResponseKeepReason({ actions: ["RESPOND"] })).toBe(
			"explicit REPLY for an addressed message",
		);
	});

	it("discards non-reply shapes — every deliverable constructor sets REPLY", () => {
		expect(
			resolveSupersededResponseKeepReason({ actions: ["TASKS"] }),
		).toBeNull();
	});

	it("discards when there is no response content to keep", () => {
		expect(resolveSupersededResponseKeepReason(null)).toBeNull();
		expect(resolveSupersededResponseKeepReason(undefined)).toBeNull();
	});
});
