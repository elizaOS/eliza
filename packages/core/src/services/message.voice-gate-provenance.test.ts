/**
 * Voice-gate provenance at the connector transport (#14873): a genuine
 * Stage-1 model reply leaves `DefaultMessageService.handleMessage` marked
 * `agentVoiced: true` and passes `AgentRuntime.sendMessageToTarget` with NO
 * TEXT_SMALL re-voice call (the ~771ms/turn regression this locks out), while
 * a synthetic transient-failure template and a raw hardcoded literal stay
 * unmarked and are still rephrased by the gate. The message pipeline and the
 * runtime transport are real; only the model surface is stubbed
 * (deterministic — no live model, no network).
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { createMockRuntime } from "../testing/mock-runtime";
import type { Character, IAgentRuntime, TargetInfo } from "../types";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import { DefaultMessageService } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000002a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000002b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000002c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000002d" as UUID;

function makeMessage(text: string): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text,
			source: "discord",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

function makeRoom(): Room {
	return {
		id: ROOM,
		source: "discord",
		type: ChannelType.DM,
	} as Room;
}

/** The Stage-1 HANDLE_RESPONSE tool-call envelope a live model emits. */
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
					contexts: ["simple"],
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

function makePipelineRuntime(
	useModel: IAgentRuntime["useModel"],
): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	const room = makeRoom();
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
		// hasTextGenerationHandler only checks registration; actual calls go
		// through the stubbed useModel.
		getModel: vi.fn(() => async () => ""),
		useModel,
		composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
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

/** Run one real handleMessage turn and capture what a connector would send. */
async function runTurn(
	message: Memory,
	useModel: IAgentRuntime["useModel"],
): Promise<Content[]> {
	const runtime = makePipelineRuntime(useModel);
	const service = new DefaultMessageService();
	const deliveries: Content[] = [];
	await service.handleMessage(runtime, message, async (content) => {
		deliveries.push(content);
		return [];
	});
	return deliveries;
}

/**
 * A REAL AgentRuntime (in-memory adapter, stub send handler) so the test
 * exercises the actual `sendMessageToTarget` → `ensureAgentVoice` transport
 * chokepoint, not a reimplementation of it.
 */
function makeTransportRuntime(gateModel: ReturnType<typeof vi.fn>): {
	runtime: AgentRuntime;
	target: TargetInfo;
	sent: Content[];
} {
	const runtime = new AgentRuntime({
		character: {
			name: `Voice Gate Transport ${v4()}`,
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	const sent: Content[] = [];
	runtime.registerSendHandler("discord", async (_rt, _target, content) => {
		sent.push(content);
		return undefined;
	});
	runtime.useModel = gateModel as unknown as AgentRuntime["useModel"];
	const target: TargetInfo = { source: "discord", roomId: ROOM };
	return { runtime, target, sent };
}

describe("voice-gate provenance end to end (#14873)", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("delivers a genuine model reply through sendMessageToTarget with NO re-voice model call", async () => {
		const replyText = `The build finished clean, 981 tests green. probe-${v4()}`;
		const deliveries = await runTurn(
			makeMessage("how did the build go?"),
			vi.fn(async () => stage1DirectReply(replyText)),
		);

		// The pipeline marked the model's own reply as already-voiced.
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].text).toBe(replyText);
		expect(deliveries[0].agentVoiced).toBe(true);

		// At the transport chokepoint the gate short-circuits: the reply is
		// delivered verbatim and useModel is NEVER called — this is the
		// ~771ms-per-turn TEXT_SMALL that used to sit between reply generation
		// and delivery.
		const gateModel = vi.fn(async () => {
			throw new Error("voice gate must not re-voice a genuine model reply");
		});
		const { runtime, target, sent } = makeTransportRuntime(gateModel);
		await runtime.sendMessageToTarget(target, deliveries[0]);

		expect(gateModel).not.toHaveBeenCalled();
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toBe(replyText);
	});

	it("still voices a synthetic transient-failure template through the gate", async () => {
		// Every model call fails with a generic transient error, so the pipeline
		// falls back to the hardcoded transient-failure template.
		const deliveries = await runTurn(
			makeMessage("hey are you there?"),
			vi.fn(async () => {
				throw new Error("upstream provider 500");
			}),
		);

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].text).toBe(
			"Something went wrong on my end. Please try again.",
		);
		expect(deliveries[0].elizaSyntheticFailure).toBe(true);
		// The synthetic template must NOT inherit the provenance flag — it is a
		// hardcoded string the gate still owns.
		expect(deliveries[0].agentVoiced).toBeUndefined();

		const rephrased = `ugh, something glitched on my side. try me again? probe-${v4()}`;
		const gateModel = vi.fn(async () => rephrased);
		const { runtime, target, sent } = makeTransportRuntime(gateModel);
		await runtime.sendMessageToTarget(target, deliveries[0]);

		expect(gateModel).toHaveBeenCalledTimes(1);
		expect(gateModel.mock.calls[0][0]).toBe(ModelType.TEXT_SMALL);
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toBe(rephrased);
		expect(sent[0].agentVoiced).toBe(true);
	});

	it("still voices a raw hardcoded outbound literal (scheduled/error-string path)", async () => {
		const rephrased = `heads up, the connector dropped for a moment. probe-${v4()}`;
		const gateModel = vi.fn(async () => rephrased);
		const { runtime, target, sent } = makeTransportRuntime(gateModel);

		await runtime.sendMessageToTarget(target, {
			text: `Error: connector not connected. probe-${v4()}`,
			source: "discord",
		});

		expect(gateModel).toHaveBeenCalledTimes(1);
		expect(gateModel.mock.calls[0][0]).toBe(ModelType.TEXT_SMALL);
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toBe(rephrased);
	});
});
