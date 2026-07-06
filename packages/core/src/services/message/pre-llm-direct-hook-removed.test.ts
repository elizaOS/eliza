/**
 * Regression test for #14715: a normal LifeOps-looking owner chat turn must
 * reach the model/planner path. The removed direct-message hook used to match
 * missed-call text before Stage 1 and return a canned approval-shaped reply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../../actions/to-tool";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../../runtime/turn-controller";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Room } from "../../types/environment";
import { EventType } from "../../types/events";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import { ChannelType, type Content, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { DefaultMessageService } from "../message";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

const MISSED_CALL_TEXT =
	"I missed a call from mom - help me follow up, confirm?";
const MODEL_REPLY =
	"I can help draft a follow-up, but I will keep it in the normal planner path.";
const OLD_HOOK_REPLY_PATTERN =
	/Sorry I missed your call earlier|walkthrough|portal_upload_intake|pending-signature-url|pre-LLM direct-message hook/i;

function createResponseHandlerFieldRegistry(): ResponseHandlerFieldRegistry {
	const registry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		registry.register(evaluator);
	}
	return registry;
}

function makeState(): State {
	return {
		values: {},
		data: {},
		text: "Recent conversation summary",
	};
}

function makeMessage(): Memory {
	return {
		id: MESSAGE_ID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: MISSED_CALL_TEXT,
			source: "test",
			channelType: ChannelType.DM,
		},
		createdAt: 1,
	};
}

function stage1DirectReply(replyText: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: "RESPOND",
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					replyText,
					facts: [],
					relationships: [],
					addressedTo: [],
					topics: [],
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function makeRuntime() {
	const createdMemories: Memory[] = [];
	const room: Room = {
		id: ROOM_ID,
		agentId: AGENT_ID,
		source: "test",
		type: ChannelType.DM,
	};
	const useModel = vi.fn(async () => stage1DirectReply(MODEL_REPLY));
	const runActionsByMode = vi.fn(async () => undefined);
	const emitEvent = vi.fn(async () => undefined);

	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		character: {
			name: "Eliza",
			bio: [],
			templates: {},
			messageExamples: [],
			postExamples: [],
			topics: [],
			adjectives: [],
			knowledge: [],
			plugins: [],
			secrets: {},
			settings: {},
		},
		stateCache: new Map(),
		turnControllers: new TurnControllerRegistry(),
		actions: [],
		providers: [],
		responseHandlerFieldRegistry: createResponseHandlerFieldRegistry(),
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		getSetting: vi.fn(() => undefined),
		getModel: vi.fn((modelType: string) =>
			modelType === ModelType.RESPONSE_HANDLER ? useModel : undefined,
		),
		useModel,
		composeState: vi.fn(async () => makeState()),
		applyPipelineHooks: vi.fn(async () => undefined),
		runActionsByMode,
		emitEvent,
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async (memory: Memory) => {
			createdMemories.push(memory);
			return memory.id ?? MESSAGE_ID;
		}),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		updateParticipantUserState: vi.fn(async () => undefined),
		getRoom: vi.fn(async () => room),
		updateRoom: vi.fn(async () => undefined),
		getWorld: vi.fn(async () => null),
		updateWorld: vi.fn(async () => undefined),
		getRoomsByIds: vi.fn(async () => [room]),
		getService: vi.fn(() => null),
		getServiceLoadPromise: vi.fn(async () => null),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as Partial<IAgentRuntime>);

	return { runtime, useModel, runActionsByMode, emitEvent, createdMemories };
}

describe("message service pre-LLM direct hook removed (#14715)", () => {
	let originalTrajectoryRecording: string | undefined;

	beforeEach(() => {
		originalTrajectoryRecording = process.env.ELIZA_TRAJECTORY_RECORDING;
		process.env.ELIZA_TRAJECTORY_RECORDING = "0";
	});

	afterEach(() => {
		if (originalTrajectoryRecording === undefined) {
			delete process.env.ELIZA_TRAJECTORY_RECORDING;
		} else {
			process.env.ELIZA_TRAJECTORY_RECORDING = originalTrajectoryRecording;
		}
	});

	it("routes missed-call owner chat through Stage 1 instead of a canned hook reply", async () => {
		const { runtime, useModel, runActionsByMode, emitEvent, createdMemories } =
			makeRuntime();
		const message = makeMessage();
		const callback = vi.fn(async (_content: Content) => []);

		const result = await new DefaultMessageService().handleMessage(
			runtime,
			message,
			callback,
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(result.didRespond).toBe(true);
		expect(result.mode).toBe("simple");
		expect(result.responseContent?.text).toBe(MODEL_REPLY);
		expect(callback.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ text: MODEL_REPLY }),
		);

		const modes = runActionsByMode.mock.calls.map(([mode]) => mode);
		expect(modes).toEqual(
			expect.arrayContaining([
				"ALWAYS_BEFORE",
				"RESPONSE_HANDLER_BEFORE",
				"RESPONSE_HANDLER_AFTER",
			]),
		);
		expect(
			emitEvent.mock.calls.some(([event]) => event === EventType.RUN_ENDED),
		).toBe(true);

		const deliveredTexts = [
			result.responseContent?.text,
			...callback.mock.calls.map(([content]) => content?.text),
			...createdMemories.map((memory) => memory.content?.text),
		].filter((text): text is string => typeof text === "string");
		expect(deliveredTexts).toContain(MODEL_REPLY);
		for (const text of deliveredTexts) {
			expect(text).not.toMatch(OLD_HOOK_REPLY_PATTERN);
		}
	});
});
