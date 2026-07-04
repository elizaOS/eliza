/**
 * Tests that `ensureLocalInferenceHandler` registers the TEXT_SMALL/TEXT_LARGE/
 * TEXT_EMBEDDING handlers and wires the router at boot. Routing mode,
 * assignments, and the registry are mocked; no model loads.
 */

import { type AgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({ mode: "local" }));
const assignmentsState = vi.hoisted(() => ({
	assignments: {} as Record<string, string>,
}));
const registryState = vi.hoisted(() => ({
	installed: [] as Array<{ id: string; path: string }>,
}));
const hardwareState = vi.hoisted(() => ({
	probe: { memory: { totalGb: 8 } },
}));
const engineState = vi.hoisted(() => ({
	activeBackendId: vi.fn(() => "llama-server"),
	available: vi.fn(async () => true),
	conversation: vi.fn(() => null),
	currentModelPath: vi.fn(() => null),
	ensureActiveBundleAsrReady: vi.fn(async () => undefined),
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
	readEffectiveAssignments: vi.fn(async () => assignmentsState.assignments),
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

vi.mock("../services/hardware", () => ({
	probeHardware: vi.fn(async () => hardwareState.probe),
}));

vi.mock("../services/memory-arbiter", () => ({
	tryGetMemoryArbiter: vi.fn(() => arbiterState),
}));

vi.mock("../services/registry", () => ({
	listInstalledModels: vi.fn(async () => registryState.installed),
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

import { resolveLocalInferenceLoadArgs } from "../services/active-model";
import { probeHardware } from "../services/hardware";
import { installRouterHandler } from "../services/router-handler";
import { VoiceStartupError } from "../services/voice/errors";
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

function findRegisteredHandler(
	registrations: Registration[],
	modelType: ModelType,
): (runtime: AgentRuntime, params: Record<string, unknown>) => Promise<string> {
	const registration = registrations.find(
		(entry) => entry.modelType === modelType,
	);
	expect(registration).toBeDefined();
	return registration?.handler as (
		runtime: AgentRuntime,
		params: Record<string, unknown>,
	) => Promise<string>;
}

beforeEach(() => {
	vi.clearAllMocks();
	modeState.mode = "local";
	assignmentsState.assignments = {};
	registryState.installed = [];
	hardwareState.probe = { memory: { totalGb: 8 } };
	delete process.env.ELIZA_LOCAL_LLAMA;
	delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
	delete process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS;
	engineState.available.mockResolvedValue(true);
	engineState.currentModelPath.mockReturnValue(null);
	engineState.hasLoadedModel.mockReturnValue(false);
	arbiterState.hasCapability.mockImplementation(
		(capability: string) => capability === "vision-describe",
	);
	arbiterState.requestVisionDescribe.mockResolvedValue({
		title: "A small image",
		description: "A tiny synthetic image.",
	});
	vi.mocked(resolveLocalInferenceLoadArgs).mockImplementation(
		async (target) => target,
	);
});

describe("ensureLocalInferenceHandler", () => {
	it("registers Eliza-1 text, embedding, voice, and transcription handlers in local mode", async () => {
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);

		expect(registrations).toEqual(
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
		expect(installRouterHandler).toHaveBeenCalledWith(runtime, {
			skipSlots: ["TEXT_EMBEDDING"],
		});
	});

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
		const handler = findRegisteredHandler(registrations, ModelType.TEXT_SMALL);

		await handler(runtime, {
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

	it("uses a fine-grained maxTokensPerStep for user-visible streaming, coarse for internal calls", async () => {
		const prior = process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		try {
			const { registrations, runtime } = makeRuntime();
			engineState.hasLoadedModel.mockReturnValue(true);

			await ensureLocalInferenceHandler(runtime);
			const handler = findRegisteredHandler(
				registrations,
				ModelType.TEXT_LARGE,
			);

			// Streaming reply (onStreamChunk wired) → tuned fine-grained step (8).
			await handler(runtime, {
				prompt: "hi",
				stream: true,
				onStreamChunk: () => {},
			});
			expect(engineState.generate).toHaveBeenLastCalledWith(
				expect.objectContaining({ maxTokensPerStep: 8 }),
			);

			// Internal / non-streamed call → no override (runner keeps coarse 32).
			await handler(runtime, { prompt: "hi" });
			expect(engineState.generate).toHaveBeenLastCalledWith(
				expect.objectContaining({ maxTokensPerStep: undefined }),
			);

			// The shared env knob overrides the tuned streaming default.
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "4";
			await handler(runtime, {
				prompt: "hi",
				stream: true,
				onStreamChunk: () => {},
			});
			expect(engineState.generate).toHaveBeenLastCalledWith(
				expect.objectContaining({ maxTokensPerStep: 4 }),
			);
		} finally {
			if (prior === undefined) {
				delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
			} else {
				process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = prior;
			}
		}
	});

	it("passes hardware-aware load args through desktop lazy assignment loads", async () => {
		const installed = {
			id: "eliza-1-2b",
			path: "/models/eliza-1-2b.gguf",
		};
		const resolved = {
			...installed,
			modelPath: installed.path,
			contextSize: 32_768,
		};
		assignmentsState.assignments = { TEXT_SMALL: installed.id };
		registryState.installed = [installed];
		engineState.hasLoadedModel.mockReturnValue(true);
		vi.mocked(resolveLocalInferenceLoadArgs).mockResolvedValueOnce(
			resolved as never,
		);
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(registrations, ModelType.TEXT_SMALL);

		await handler(runtime, {
			messages: [{ role: "user", content: "hello" }],
		});

		expect(probeHardware).toHaveBeenCalledTimes(1);
		expect(resolveLocalInferenceLoadArgs).toHaveBeenCalledWith(
			installed,
			undefined,
			{ hardware: hardwareState.probe },
		);
		expect(engineState.load).toHaveBeenCalledWith(installed.path, resolved);
	});

	it.each([
		[ModelType.TEXT_SMALL, "TEXT_SMALL"],
		[ModelType.TEXT_LARGE, "TEXT_LARGE"],
		[ModelType.RESPONSE_HANDLER, "TEXT_SMALL"],
	])("signals typed local unavailability for %s when no text model is loaded", async (modelType, slot) => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(false);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(registrations, modelType);

		await expect(
			handler(runtime, {
				messages: [{ role: "user", content: "hello" }],
			}),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: slot,
			reason: "backend_unavailable",
		});
	});

	it.each([
		[ModelType.TEXT_SMALL, "TEXT_SMALL"],
		[ModelType.TEXT_LARGE, "TEXT_LARGE"],
		[ModelType.RESPONSE_HANDLER, "TEXT_SMALL"],
	])("signals typed local unavailability for %s when the backend is unavailable", async (modelType, slot) => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		// Register while the backend reports available (the pre-flight gate skips
		// registration otherwise), then drop the binding to exercise the handler's
		// runtime-defensive unavailability check — the real "binding went away
		// after boot" scenario.
		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(registrations, modelType);
		engineState.available.mockResolvedValue(false);

		await expect(
			handler(runtime, {
				messages: [{ role: "user", content: "hello" }],
			}),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: slot,
			reason: "backend_unavailable",
		});
	});

	it("routes image description through the Eliza-1 vision arbiter", async () => {
		const { registrations, runtime } = makeRuntime();
		const signal = new AbortController().signal;
		const onStreamChunk = vi.fn();

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
				stream: true,
				signal,
				onStreamChunk,
			}),
		).resolves.toEqual({
			title: "A small image",
			description: "A tiny synthetic image.",
		});
		expect(arbiterState.requestVisionDescribe).toHaveBeenCalledWith({
			modelKey: "gemma-vl",
			payload: {
				image: { kind: "dataUrl", dataUrl: "data:image/png;base64,AAAA" },
				prompt: "describe this",
				signal,
				onTextChunk: expect.any(Function),
			},
		});
		const payload = arbiterState.requestVisionDescribe.mock.calls[0]?.[0]
			?.payload as { onTextChunk?: (chunk: string) => void | Promise<void> };
		await payload.onTextChunk?.("token");
		expect(onStreamChunk).toHaveBeenCalledWith("token");
		expect(runtime.setSetting).toHaveBeenCalledWith(
			"ELIZA1_VISION_HANDLER_PRESENT",
			"1",
		);
	});

	it("keeps image description buffered unless stream is explicitly true", async () => {
		const { registrations, runtime } = makeRuntime();
		const onStreamChunk = vi.fn();

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

		await handler?.(runtime, {
			imageUrl: "https://example.test/image.png",
			prompt: "describe this",
			onStreamChunk,
		});

		expect(arbiterState.requestVisionDescribe).toHaveBeenCalledWith({
			modelKey: "gemma-vl",
			payload: {
				image: { kind: "url", url: "https://example.test/image.png" },
				prompt: "describe this",
			},
		});
		expect(onStreamChunk).not.toHaveBeenCalled();
	});

	it("arms the active voice bundle before TRANSCRIPTION", async () => {
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);
		const registration = registrations.find(
			(entry) => entry.modelType === ModelType.TRANSCRIPTION,
		);
		const handler = registration?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;
		expect(handler).toBeDefined();

		await expect(
			handler?.(runtime, { audio: new Uint8Array([82, 73, 70, 70]) }),
		).resolves.toBe("transcribed");

		expect(engineState.ensureActiveBundleAsrReady).toHaveBeenCalledTimes(1);
		expect(engineState.ensureActiveBundleVoiceReady).not.toHaveBeenCalled();
		expect(engineState.transcribePcm).toHaveBeenCalledWith(
			{ pcm: new Float32Array([0]), sampleRate: 16_000 },
			undefined,
			undefined,
		);
	});

	it("fails fast when the fused voice bundle is unavailable (no whisper fallback)", async () => {
		// The fused libelizainference ASR runtime is the sole on-device
		// transcriber. A startup failure must propagate (AGENTS.md §3) — there is
		// no whisper.cpp second attempt and no silent empty transcript.
		engineState.ensureActiveBundleAsrReady.mockRejectedValueOnce(
			new VoiceStartupError("missing-bundle-root", "no bundle"),
		);
		const { registrations, runtime } = makeRuntime();

		await ensureLocalInferenceHandler(runtime);
		const registration = registrations.find(
			(entry) => entry.modelType === ModelType.TRANSCRIPTION,
		);
		const handler = registration?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;
		expect(handler).toBeDefined();

		await expect(
			handler?.(runtime, { audio: new Uint8Array([82, 73, 70, 70]) }),
		).rejects.toThrow(VoiceStartupError);

		expect(engineState.ensureActiveBundleAsrReady).toHaveBeenCalledTimes(1);
		expect(engineState.transcribePcm).not.toHaveBeenCalled();
	});

	it("threads structured streaming callbacks through the RESPONSE_HANDLER registration", async () => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(
			registrations,
			ModelType.RESPONSE_HANDLER,
		);

		const onStreamChunk = vi.fn();
		await handler(runtime, {
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

	it("delivers engine onTextChunk tokens to the caller's onStreamChunk per token (chat streaming)", async () => {
		// End-to-end guard for the local chat streaming regression: the registered
		// RESPONSE_HANDLER handler must connect the runtime's `onStreamChunk` to the
		// engine's `onTextChunk` so each generated token is delivered incrementally,
		// not collapsed into one final chunk. The mocked engine fires onTextChunk
		// per token (mirroring NodeLlamaCppBackend/FfiStreamingBackend), and we
		// assert the caller saw multiple distinct chunks in order.
		const tokens = ["On ", "it ", "now."];
		engineState.generate.mockImplementationOnce(
			async (args: { onTextChunk?: (chunk: string) => unknown }) => {
				for (const token of tokens) {
					await args.onTextChunk?.(token);
				}
				return tokens.join("");
			},
		);

		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(
			registrations,
			ModelType.RESPONSE_HANDLER,
		);

		const received: string[] = [];
		await handler(runtime, {
			messages: [{ role: "user", content: "hello" }],
			streamStructured: true,
			responseSkeleton: { spans: [] },
			onStreamChunk: (chunk: string) => {
				received.push(chunk);
			},
		});

		expect(received).toEqual(tokens);
		expect(received.length).toBeGreaterThan(1);
	});

	it("wires onTextChunk for a plain (non-structured) stream request", async () => {
		// The chat path can ask for token streaming via `stream: true` without a
		// response skeleton. The handler must still bridge onStreamChunk →
		// onTextChunk so cloud-parity token streaming works for the local model.
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(
			registrations,
			ModelType.RESPONSE_HANDLER,
		);

		await handler(runtime, {
			messages: [{ role: "user", content: "hello" }],
			stream: true,
			onStreamChunk: vi.fn(),
		});

		expect(engineState.generate).toHaveBeenCalledWith(
			expect.objectContaining({ onTextChunk: expect.any(Function) }),
		);
	});

	it("does not wire onTextChunk for a non-streaming request", async () => {
		// Non-streaming callers must not pay the per-chunk callback overhead:
		// engineGenerateArgsFromParams only bridges the callback when the caller
		// asked for streaming (`stream` or `streamStructured`).
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(
			registrations,
			ModelType.RESPONSE_HANDLER,
		);

		await handler(runtime, {
			messages: [{ role: "user", content: "hello" }],
			onStreamChunk: vi.fn(),
		});

		const args = engineState.generate.mock.calls.at(-1)?.[0] as {
			onTextChunk?: unknown;
		};
		expect(args.onTextChunk).toBeUndefined();
	});

	it("threads eliza thinking provider options into local engine args", async () => {
		const { registrations, runtime } = makeRuntime();
		engineState.hasLoadedModel.mockReturnValue(true);

		await ensureLocalInferenceHandler(runtime);
		const handler = findRegisteredHandler(
			registrations,
			ModelType.RESPONSE_HANDLER,
		);

		await handler(runtime, {
			messages: [{ role: "user", content: "hello" }],
			providerOptions: { eliza: { thinking: "off" } },
		});

		expect(engineState.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				thinking: "off",
			}),
		);
	});
});
