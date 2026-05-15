import { type AgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({ mode: "local" }));
const engineState = vi.hoisted(() => ({
	activeBackendId: vi.fn(() => "llama-server"),
	available: vi.fn(async () => true),
	canEmbed: vi.fn(() => false),
	conversation: vi.fn(() => null),
	currentModelPath: vi.fn(() => null),
	embed: vi.fn(async () => [[0.1, 0.2]]),
	ensureActiveBundleVoiceReady: vi.fn(async () => undefined),
	generate: vi.fn(async () => "ok"),
	generateInConversation: vi.fn(async () => ({
		slotId: "slot-0",
		text: "ok",
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	})),
	hasLoadedModel: vi.fn(() => false),
	load: vi.fn(async () => undefined),
	openConversation: vi.fn(() => ({ id: "conversation" })),
	prewarmConversation: vi.fn(async () => true),
	synthesizeSpeech: vi.fn(async () => new Uint8Array([1, 2, 3])),
	transcribePcm: vi.fn(async () => "transcribed"),
	warnIfParallelTooLow: vi.fn(),
}));
const arbiterState = vi.hoisted(() => ({
	hasCapability: vi.fn(
		(capability: string) => capability === "vision-describe",
	),
	requestVisionDescribe: vi.fn(async () => ({
		title: "A small image",
		description: "A tiny synthetic image.",
	})),
}));

vi.mock("../services/active-model", () => ({
	resolveLocalInferenceLoadArgs: vi.fn(async (target) => target),
}));

vi.mock("../services/assignments", () => ({
	autoAssignAtBoot: vi.fn(async () => null),
	readEffectiveAssignments: vi.fn(async () => ({})),
}));

vi.mock("../services/cache-bridge", () => ({
	extractConversationId: vi.fn(() => null),
	extractPromptCacheKey: vi.fn(() => null),
	resolveLocalCacheKey: vi.fn(() => null),
}));

vi.mock("../services/device-bridge", () => ({
	deviceBridge: {
		currentModelPath: vi.fn(() => null),
		embed: vi.fn(),
		generate: vi.fn(),
		loadModel: vi.fn(),
		unloadModel: vi.fn(),
	},
}));

vi.mock("../services/engine", () => ({
	localInferenceEngine: engineState,
}));

vi.mock("../services/handler-registry", () => ({
	handlerRegistry: {
		installOn: vi.fn(),
	},
}));

vi.mock("../services/memory-arbiter", () => ({
	tryGetMemoryArbiter: vi.fn(() => arbiterState),
}));

vi.mock("../services/registry", () => ({
	listInstalledModels: vi.fn(async () => []),
}));

vi.mock("../services/router-handler", () => ({
	installRouterHandler: vi.fn(),
}));

vi.mock("../services/voice", () => ({
	decodeMonoPcm16Wav: vi.fn(() => ({
		pcm: new Float32Array([0]),
		sampleRate: 16_000,
	})),
}));

import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler";

interface Registration {
	modelType: string | number;
	provider: string;
	priority?: number;
	handler: unknown;
}

function makeRuntime(): {
	registrations: Registration[];
	runtime: AgentRuntime;
} {
	const registrations: Registration[] = [];
	const runtime = {
		agentId: "agent-test",
		getModel: vi.fn(() => undefined),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_RUNTIME_MODE" ? modeState.mode : undefined,
		),
		getService: vi.fn(() => null),
		setSetting: vi.fn(),
		registerModel: vi.fn(
			(
				modelType: string | number,
				_handler: unknown,
				provider: string,
				priority?: number,
			) => {
				registrations.push({
					modelType,
					provider,
					priority,
					handler: _handler,
				});
			},
		),
		registerService: vi.fn(),
	} as unknown as AgentRuntime;
	return { registrations, runtime };
}

beforeEach(() => {
	vi.clearAllMocks();
	modeState.mode = "local";
	delete process.env.ELIZA_LOCAL_LLAMA;
	delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
	delete process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS;
	engineState.available.mockResolvedValue(true);
	engineState.currentModelPath.mockReturnValue(null);
	engineState.canEmbed.mockReturnValue(false);
	engineState.hasLoadedModel.mockReturnValue(false);
	arbiterState.hasCapability.mockImplementation(
		(capability: string) => capability === "vision-describe",
	);
	arbiterState.requestVisionDescribe.mockResolvedValue({
		title: "A small image",
		description: "A tiny synthetic image.",
	});
});

describe("ensureLocalInferenceHandler", () => {
	it("registers Eliza-1 text, embedding, voice, and transcription handlers in local mode", async () => {
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);

		expect(registrations).toEqual(
<<<<<<< HEAD
			expect.arrayContaining([
				expect.objectContaining({
					modelType: ModelType.TEXT_SMALL,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.TEXT_LARGE,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.RESPONSE_HANDLER,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.ACTION_PLANNER,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.TEXT_COMPLETION,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.TEXT_EMBEDDING,
					provider: "eliza-local-inference",
					priority: 0,
				}),
=======
				expect.arrayContaining([
					expect.objectContaining({
						modelType: ModelType.TEXT_SMALL,
						provider: "eliza-local-inference",
						priority: 0,
					}),
					expect.objectContaining({
						modelType: ModelType.TEXT_LARGE,
						provider: "eliza-local-inference",
						priority: 0,
					}),
					expect.objectContaining({
						modelType: ModelType.RESPONSE_HANDLER,
						provider: "eliza-local-inference",
						priority: 0,
					}),
					expect.objectContaining({
						modelType: ModelType.ACTION_PLANNER,
						provider: "eliza-local-inference",
						priority: 0,
					}),
					expect.objectContaining({
						modelType: ModelType.TEXT_COMPLETION,
						provider: "eliza-local-inference",
						priority: 0,
					}),
					expect.objectContaining({
						modelType: ModelType.TEXT_EMBEDDING,
						provider: "eliza-local-inference",
						priority: 0,
					}),
>>>>>>> origin/codex/fused-local-inference-latest-20260515
				expect.objectContaining({
					modelType: ModelType.TEXT_TO_SPEECH,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.TRANSCRIPTION,
					provider: "eliza-local-inference",
					priority: 0,
				}),
				expect.objectContaining({
					modelType: ModelType.IMAGE_DESCRIPTION,
					provider: "eliza-local-inference",
					priority: 0,
				}),
			]),
		);
	});

	it("honors ELIZA_DISABLE_LOCAL_EMBEDDINGS by leaving TEXT_EMBEDDING unregistered", async () => {
		process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);

		expect(
			registrations.some(
				(entry) => entry.modelType === ModelType.TEXT_EMBEDDING,
			),
<<<<<<< HEAD
		).toBe(false);
		expect(registrations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ modelType: ModelType.TEXT_SMALL }),
				expect.objectContaining({ modelType: ModelType.TEXT_LARGE }),
				expect.objectContaining({ modelType: ModelType.RESPONSE_HANDLER }),
				expect.objectContaining({ modelType: ModelType.ACTION_PLANNER }),
				expect.objectContaining({ modelType: ModelType.TEXT_COMPLETION }),
				expect.objectContaining({ modelType: ModelType.TEXT_TO_SPEECH }),
				expect.objectContaining({ modelType: ModelType.TRANSCRIPTION }),
			]),
		);
	});
=======
			).toBe(false);
			expect(registrations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ modelType: ModelType.TEXT_SMALL }),
					expect.objectContaining({ modelType: ModelType.TEXT_LARGE }),
					expect.objectContaining({ modelType: ModelType.RESPONSE_HANDLER }),
					expect.objectContaining({ modelType: ModelType.ACTION_PLANNER }),
					expect.objectContaining({ modelType: ModelType.TEXT_COMPLETION }),
					expect.objectContaining({ modelType: ModelType.TEXT_TO_SPEECH }),
					expect.objectContaining({ modelType: ModelType.TRANSCRIPTION }),
				]),
			);
		});
>>>>>>> origin/codex/fused-local-inference-latest-20260515

	it("skips handler registration outside local modes", async () => {
		modeState.mode = "cloud";
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);

		expect(registrations).toHaveLength(0);
		expect(engineState.available).not.toHaveBeenCalled();
	});

	it("does not duplicate registrations on the same runtime", async () => {
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);
		const firstCount = registrations.length;
		await ensureLocalInferenceHandler(runtime);

		expect(registrations).toHaveLength(firstCount);
	});

	it("renders v5 messages into a non-empty local prompt", async () => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const registration = registrations.find(
			(entry) => entry.modelType === ModelType.TEXT_SMALL,
		);
		const handler = registration?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;
		expect(handler).toBeDefined();

		await handler?.(runtime, {
			messages: [
				{ role: "system", content: "You are Eliza." },
				{ role: "user", content: "hello. say hello back" },
			],
			maxTokens: 32,
			temperature: 0.1,
			topP: 0.9,
		});

		expect(engineState.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "system:\nYou are Eliza.\n\nuser:\nhello. say hello back",
				maxTokens: 32,
				temperature: 0.1,
				topP: 0.9,
			}),
		);
	});

	it("routes image description through the Eliza-1 vision arbiter", async () => {
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);
		const registration = registrations.find(
			(entry) => entry.modelType === ModelType.IMAGE_DESCRIPTION,
		);
		const handler = registration?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<{ title: string; description: string }>)
			| undefined;
		expect(handler).toBeDefined();

		await expect(
			handler?.(runtime, {
				imageUrl: "data:image/png;base64,AAAA",
				prompt: "describe this",
			}),
		).resolves.toEqual({
			title: "A small image",
			description: "A tiny synthetic image.",
		});
		expect(arbiterState.requestVisionDescribe).toHaveBeenCalledWith({
			modelKey: "qwen3-vl",
			payload: {
				image: { kind: "dataUrl", dataUrl: "data:image/png;base64,AAAA" },
				prompt: "describe this",
			},
		});
		expect(runtime.setSetting).toHaveBeenCalledWith(
			"ELIZA1_VISION_HANDLER_PRESENT",
			"1",
		);
	});

	it("threads structured streaming callbacks through the RESPONSE_HANDLER registration", async () => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const registration = registrations.find(
			(entry) => entry.modelType === ModelType.RESPONSE_HANDLER,
		);
		const handler = registration?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;
		expect(handler).toBeDefined();

		const onStreamChunk = vi.fn();
		await handler?.(runtime, {
			messages: [{ role: "user", content: "hello" }],
			streamStructured: true,
			responseSkeleton: { spans: [] },
			onStreamChunk,
		});

		expect(engineState.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "user:\nhello",
				streamStructured: true,
				onTextChunk: expect.any(Function),
			}),
		);
	});
});
