/**
 * Connector-path failure reply when a model call is rejected at the provider's
 * context limit (live: Cerebras 400 "Please reduce the length of the messages
 * or completion. Current length is 202427 while limit is 131072"). The turn
 * must not die to the generic "something went wrong" template: the classified
 * `context_overflow` cause delivers the honest "needed more context than my
 * model can take in one call" reply, both for a raw provider rejection and for
 * the typed PROVIDER_CONTEXT_OVERFLOW ElizaError the planner loop throws once
 * its substitution recovery is exhausted.
 *
 * Deterministic — drives the real `DefaultMessageService.handleMessage`
 * pipeline with a mocked runtime whose `useModel` always throws the failure
 * shape, so every failure-reply fallback slot also fails and the canned
 * cause-specific default is what a connector would post.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaError } from "../errors";
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
import { PROVIDER_CONTEXT_OVERFLOW } from "../utils/model-errors";
import { DefaultMessageService } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000002a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000002b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000002c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000002d" as UUID;

/** The exact AI_APICallError shape from the live Cerebras overflow incident. */
function makeLiveOverflowError(): Error {
	return Object.assign(
		new Error(
			"Bad Request: Please reduce the length of the messages or completion. " +
				"Current length is 202427 while limit is 131072",
		),
		{
			name: "AI_APICallError",
			statusCode: 400,
			responseBody:
				'{"message":"Please reduce the length of the messages or completion. Current length is 202427 while limit is 131072","type":"invalid_request_error","param":"validation_error","code":"context_length_exceeded"}',
			url: "https://api.cerebras.ai/v1/chat/completions",
		},
	);
}

/** The typed error the planner loop throws when substitution recovery fails. */
function makeTypedOverflowError(): ElizaError {
	return new ElizaError(
		"Planner model input exceeded the provider's context limit and could not " +
			"be recovered by tool-result substitution.",
		{ code: PROVIDER_CONTEXT_OVERFLOW, cause: makeLiveOverflowError() },
	);
}

function makeMessage(overrides: Partial<Content> = {}): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "@Remilio recap everything from the last 500 messages",
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

function makeFailingRuntime(
	room: Room,
	failure: Error,
	templates: Record<string, string> = {},
): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Remilio",
			bio: "test agent",
			templates,
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
		// Upstream's pre-emptive input budget (responseHandlerContextWindow) reads
		// the model registry unconditionally before Stage 1 dispatches. An empty
		// registry means no advertised context window — the budget path stands
		// down and the provider rejection stays the boundary under test.
		getModelRegistrations: vi.fn(() => []),
		// Stage 1 dies at the provider context boundary, and every failure-reply
		// fallback slot fails the same way — the canned cause default must land.
		useModel: vi.fn(async () => {
			throw failure;
		}),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
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

async function runTurn(
	message: Memory,
	room: Room,
	failure: Error,
	templates: Record<string, string> = {},
) {
	const runtime = makeFailingRuntime(room, failure, templates);
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

describe("connector turn failing on a provider context overflow", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("delivers the honest smaller-range reply for the raw live rejection", async () => {
		const failure = makeLiveOverflowError();
		const { runtime, result, visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
			failure,
		);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
		expect(visibleTexts[0]).toMatch(
			/more context than my model can take in one call/i,
		);
		expect(visibleTexts[0]).toMatch(/smaller range|narrower/i);
		expect(visibleTexts[0]).not.toMatch(/something went wrong/i);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"MessageService.v5Runtime",
			failure,
			expect.objectContaining({ roomId: ROOM }),
		);
	});

	it("delivers the same honest reply for the typed PROVIDER_CONTEXT_OVERFLOW error", async () => {
		const { visibleTexts } = await runTurn(
			makeMessage({ channelType: ChannelType.DM }),
			makeRoom(ChannelType.DM),
			makeTypedOverflowError(),
		);

		expect(visibleTexts).toHaveLength(1);
		expect(visibleTexts[0]).toMatch(
			/more context than my model can take in one call/i,
		);
	});

	it("marks the synthetic reply with the structural context_overflow kind", async () => {
		const { deliveries } = await runTurn(
			makeMessage({ channelType: ChannelType.DM }),
			makeRoom(ChannelType.DM),
			makeLiveOverflowError(),
		);

		const failureReply = deliveries.find(
			(content) => content.elizaSyntheticFailure === true,
		);
		// Retrying the identical request cannot succeed at the same boundary, so
		// the reply must not carry retryable-transient semantics.
		expect(failureReply).toMatchObject({
			failureKind: "context_overflow",
			transient: false,
			doNotPersist: true,
		});
	});

	it("uses the character contextOverflowFailureReply override", async () => {
		const localized =
			"Eso necesita mas contexto del que puedo leer de una vez - pide un rango mas pequeno.";
		const { visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
			makeTypedOverflowError(),
			{ contextOverflowFailureReply: localized },
		);

		expect(visibleTexts).toEqual([localized]);
	});
});
