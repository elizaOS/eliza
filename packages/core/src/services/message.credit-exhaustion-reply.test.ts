/**
 * Connector-path failure reply when the model provider is out of credits.
 *
 * A 402 insufficient-credits failure is a permanent condition until the user
 * tops up — the direct API path already classifies it and answers with the
 * actionable "credits are depleted, top up" reply, but the connector delivery
 * path (Discord/Telegram turns through `DefaultMessageService.handleMessage`)
 * used to fall through to the generic "something went wrong, try again"
 * template, telling users to retry an unretryable failure.
 *
 * These tests drive the real `handleMessage` pipeline with only the runtime
 * I/O surface mocked. `useModel` rejects with the exact error shape
 * plugin-elizacloud throws on a cloud 402 (`Error` + `.status = 402` +
 * `.error = { code: "insufficient_credits" }`), and the assertions read what
 * a connector would actually post to the channel.
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
import { DefaultMessageService, INSUFFICIENT_CREDITS_REPLY } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000001a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000001b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000001c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000001d" as UUID;

/** The error shape plugin-elizacloud throws when Eliza Cloud returns 402. */
function makeCreditExhaustionError(): Error {
	return Object.assign(
		new Error("Insufficient credits. Required: $0.0014, Available: $0.0000"),
		{
			status: 402,
			error: {
				code: "insufficient_credits",
				message: "Insufficient credits. Required: $0.0014, Available: $0.0000",
			},
		},
	);
}

function makeMessage(overrides: Partial<Content> = {}): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "@Remilio what's the plan?",
			source: "discord",
			channelType: ChannelType.GROUP,
			mentionContext: { isMention: true },
			...overrides,
		},
		createdAt: Date.now(),
	};
}

function makeState(): State {
	return { values: {}, data: {}, text: "" };
}

function makeFailingRuntime(room: Room, failure: Error): IAgentRuntime {
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
			throw failure;
		}),
		// Stage 1 dies with the cloud 402, and every failure-reply fallback
		// model call fails the same way — exactly what a fully drained cloud
		// account produces.
		useModel: vi.fn(async () => {
			throw failure;
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

async function runTurn(message: Memory, room: Room, failure: Error) {
	const runtime = makeFailingRuntime(room, failure);
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
	const visibleTexts = deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
	return { runtime, result, deliveries, visibleTexts };
}

describe("connector turn failing on 402 credit exhaustion", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("delivers the actionable top-up reply, not the generic retry", async () => {
		const { result, visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
			makeCreditExhaustionError(),
		);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
		// The user must learn the real, actionable condition — same reply the
		// direct API path sends — instead of "try again" (retrying a drained
		// account can never succeed) or the rate-limited "give it a few
		// seconds" template.
		expect(visibleTexts[0]).toBe(INSUFFICIENT_CREDITS_REPLY);
	});

	it("marks the synthetic reply with the structural insufficient_credits kind", async () => {
		const { deliveries } = await runTurn(
			makeMessage({ channelType: ChannelType.DM }),
			makeRoom(ChannelType.DM),
			makeCreditExhaustionError(),
		);

		const failureReply = deliveries.find(
			(content) => content.elizaSyntheticFailure === true,
		);
		// Downstream consumers (chat DTO failureKind gate, recent-messages
		// synthetic-failure filter) key on the structural kind, so the credits
		// case must not masquerade as a transient failure.
		expect(failureReply?.failureKind).toBe("insufficient_credits");
	});

	it("keeps a bare 429 on the rate-limited reply, not the top-up reply", async () => {
		const { visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
			Object.assign(new Error("Rate limit exceeded. Try again shortly."), {
				status: 429,
				error: { code: "rate_limit_exceeded" },
			}),
		);

		expect(visibleTexts).toHaveLength(1);
		expect(visibleTexts[0].toLowerCase()).toContain("rate-limit");
		expect(visibleTexts[0]).not.toBe(INSUFFICIENT_CREDITS_REPLY);
	});

	it("classifies a 402 hidden inside the AI SDK retry envelope", async () => {
		const { visibleTexts } = await runTurn(
			makeMessage({ channelType: ChannelType.DM }),
			makeRoom(ChannelType.DM),
			Object.assign(new Error("Failed after 3 attempts"), {
				lastError: Object.assign(new Error("Payment Required"), {
					statusCode: 402,
				}),
			}),
		);

		expect(visibleTexts).toHaveLength(1);
		expect(visibleTexts[0]).toBe(INSUFFICIENT_CREDITS_REPLY);
	});
});
