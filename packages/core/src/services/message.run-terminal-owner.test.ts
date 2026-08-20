/**
 * Run-terminal ownership through the real message pipeline. Model providers are
 * deterministic gates so delivery/terminal ordering is asserted without network.
 */

import { v4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { getStreamingContext } from "../streaming-context";
import { createMockRuntime } from "../testing/mock-runtime";
import type { IAgentRuntime, Memory } from "../types";
import { EventType, ModelType } from "../types";
import { asUUID, ChannelType, type UUID } from "../types/primitives";
import { DefaultMessageService } from "./message";
import { drainPostDeliveryTasks } from "./post-delivery-task-tracker";

const AGENT_ID = "00000000-0000-0000-0000-0000000002a1" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000002b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000002c1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000002d1" as UUID;

function deferred(): {
	promise: Promise<void>;
	release: () => void;
} {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function stage1Reply(replyText: string, facts: string[] = []) {
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
					facts,
					relationships: [],
					addressedTo: [],
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function inputMessage(text: string): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
	};
}

function makeRuntime(options: {
	facts?: string[];
	factsGate?: Promise<void>;
	onFactsStarted?: () => void;
	streamText?: string;
	streamEvents?: Array<{
		chunk: string;
		accumulated: string;
		streamRevision?: number;
	}>;
	ttsGate?: Promise<void>;
	onTtsStarted?: () => void;
}): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
	terminalPayloads: Array<Record<string, unknown>>;
} {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	const terminalPayloads: Array<Record<string, unknown>> = [];
	const useModel = vi.fn(async (modelType: string, _params?: unknown) => {
		if (modelType === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
		if (modelType === ModelType.RESPONSE_HANDLER) {
			if (options.streamEvents) {
				for (const event of options.streamEvents) {
					await getStreamingContext()?.onStreamChunk(
						event.chunk,
						undefined,
						event.accumulated,
						event.streamRevision,
					);
				}
			} else if (options.streamText) {
				await getStreamingContext()?.onStreamChunk(
					options.streamText,
					undefined,
					options.streamText,
				);
			}
			return stage1Reply(
				options.streamText ??
					options.streamEvents?.at(-1)?.accumulated ??
					"Delivery is ready.",
				options.facts,
			);
		}
		if (modelType === ModelType.TEXT_LARGE) {
			options.onFactsStarted?.();
			await options.factsGate;
			return {
				toolCalls: [
					{
						name: "FACTS_AND_RELATIONSHIPS_VALIDATE",
						arguments: {
							facts: options.facts ?? [],
							relationships: [],
							thought: "Keep the explicit fact.",
						},
					},
				],
			};
		}
		if (modelType === ModelType.TEXT_TO_SPEECH) {
			options.onTtsStarted?.();
			await options.ttsGate;
			return Buffer.from("voice");
		}
		throw new Error(`Unexpected model type: ${modelType}`);
	});
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		character: { name: "Eliza", bio: "test agent" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getServicesByType: vi.fn(() => []),
		getModel: vi.fn(() => async () => ""),
		useModel,
		composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async (event: string, payload: unknown) => {
			if (event === EventType.RUN_ENDED) {
				terminalPayloads.push(payload as Record<string, unknown>);
			}
		}),
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		getMemoryById: vi.fn(async () => null),
		getMemories: vi.fn(async () => []),
		getRelationships: vi.fn(async () => []),
		getParticipantsForRoom: vi.fn(async () => []),
		getEntityById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: ChannelType.DM,
			source: "client_chat",
		})),
		getRoomsByIds: vi.fn(async () => []),
		redactSecrets: vi.fn((text: string) => text),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
	return { runtime, useModel, terminalPayloads };
}

describe("DefaultMessageService run-terminal owner", () => {
	it("waits for parallel facts extraction without delaying visible delivery", async () => {
		const gate = deferred();
		const started = deferred();
		const { runtime, useModel, terminalPayloads } = makeRuntime({
			facts: ["The user likes jasmine tea."],
			factsGate: gate.promise,
			onFactsStarted: started.release,
		});
		const deliveries: string[] = [];
		const service = new DefaultMessageService();

		const result = await service.handleMessage(
			runtime,
			inputMessage("I like jasmine tea"),
			async (content) => {
				if (content.text) deliveries.push(content.text);
				return [];
			},
		);
		await started.promise;
		expect(result.trajectoryTerminalOwner).toBe("run");
		expect(deliveries).toContain("Delivery is ready.");
		expect(terminalPayloads).toEqual([]);

		gate.release();
		await drainPostDeliveryTasks(runtime);
		expect(
			useModel.mock.calls.filter(([type]) => type === ModelType.TEXT_LARGE),
		).toHaveLength(1);
		expect(terminalPayloads).toHaveLength(1);
	});

	it("waits for first and trailing speech captures without delaying text delivery", async () => {
		const gate = deferred();
		const started = deferred();
		const streamText = "First sentence. Trailing sentence.";
		const { runtime, useModel, terminalPayloads } = makeRuntime({
			streamText,
			ttsGate: gate.promise,
			onTtsStarted: started.release,
		});
		const deliveries: string[] = [];
		const service = new DefaultMessageService();

		const result = await service.handleMessage(
			runtime,
			inputMessage("speak the result"),
			async (content) => {
				if (content.text) deliveries.push(content.text);
				return [];
			},
			{ onStreamChunk: async () => undefined },
		);
		await started.promise;
		expect(result.trajectoryTerminalOwner).toBe("run");
		expect(deliveries).toContain(streamText);
		expect(terminalPayloads).toEqual([]);

		gate.release();
		await drainPostDeliveryTasks(runtime);
		expect(
			useModel.mock.calls.filter(([type]) => type === ModelType.TEXT_TO_SPEECH),
		).toHaveLength(2);
		expect(terminalPayloads).toHaveLength(1);
	});

	it("replays authoritative first-sentence state after a structured retry", async () => {
		const { runtime, useModel } = makeRuntime({
			streamEvents: [
				{ chunk: "Prof", accumulated: "Prof" },
				{
					chunk: ".) arrived.",
					accumulated: "Okay.) arrived.",
					streamRevision: 1,
				},
			],
		});
		const service = new DefaultMessageService();

		await service.handleMessage(
			runtime,
			inputMessage("speak the retried result"),
			async () => [],
			{ onStreamChunk: async () => undefined },
		);
		await drainPostDeliveryTasks(runtime);

		const speechParams = useModel.mock.calls
			.filter(([type]) => type === ModelType.TEXT_TO_SPEECH)
			.map(([, params]) => params);
		expect(speechParams).toMatchObject([
			{ text: "Okay.)" },
			{ text: "arrived." },
		]);
	});
});
