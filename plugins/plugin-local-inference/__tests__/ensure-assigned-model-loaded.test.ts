import { type AgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({ mode: "local" }));
const assignmentsState = vi.hoisted(() => ({
	value: {} as Record<string, string>,
}));
const installedState = vi.hoisted(() => ({
	value: [] as Array<{
		id: string;
		path: string;
		sizeBytes: number;
		source: string;
	}>,
}));
const loaderState = vi.hoisted(() => ({
	currentPath: null as string | null,
	loadCalls: [] as unknown[],
	unloadCalls: 0,
	generateCalls: [] as unknown[],
}));
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

vi.mock("../src/services/active-model", () => ({
	resolveLocalInferenceLoadArgs: vi.fn(async (target) => ({
		modelPath: target.path,
	})),
}));

vi.mock("../src/services/assignments", async () => {
	const actual = await vi.importActual<
		typeof import("../src/services/assignments")
	>("../src/services/assignments");
	return {
		...actual,
		autoAssignAtBoot: vi.fn(async () => null),
		readEffectiveAssignments: vi.fn(async () => ({ ...assignmentsState.value })),
	};
});

vi.mock("../src/services/cache-bridge", () => ({
	extractConversationId: vi.fn(() => null),
	extractPromptCacheKey: vi.fn(() => null),
	resolveLocalCacheKey: vi.fn(() => null),
}));

vi.mock("../src/services/device-bridge", () => ({
	deviceBridge: {
		currentModelPath: vi.fn(() => null),
		embed: vi.fn(),
		generate: vi.fn(),
		loadModel: vi.fn(),
		unloadModel: vi.fn(),
	},
}));

vi.mock("../src/services/engine", () => ({
	localInferenceEngine: engineState,
}));

vi.mock("../src/services/handler-registry", () => ({
	handlerRegistry: { installOn: vi.fn() },
}));

vi.mock("../src/services/registry", () => ({
	listInstalledModels: vi.fn(async () => installedState.value),
}));

vi.mock("../src/services/router-handler", () => ({
	installRouterHandler: vi.fn(),
}));

vi.mock("../src/services/voice", () => ({
	decodeMonoPcm16Wav: vi.fn(() => ({
		pcm: new Float32Array([0]),
		sampleRate: 16_000,
	})),
}));

import { ensureLocalInferenceHandler } from "../src/runtime/ensure-local-inference-handler.ts";

interface Registration {
	modelType: string | number;
	provider: string;
	priority?: number;
	handler: unknown;
}

function makeRuntime(): {
	registrations: Registration[];
	runtime: AgentRuntime;
	loader: {
		currentModelPath: () => string | null;
		loadModel: (args: unknown) => Promise<void>;
		unloadModel: () => Promise<void>;
		generate: (args: unknown) => Promise<string>;
		embed: (args: unknown) => Promise<{ embedding: number[]; tokens: number }>;
	};
} {
	const registrations: Registration[] = [];
	const loader = {
		currentModelPath: vi.fn(() => loaderState.currentPath),
		loadModel: vi.fn(async (args: unknown) => {
			loaderState.loadCalls.push(args);
			const a = args as { modelPath?: string };
			if (a.modelPath) loaderState.currentPath = a.modelPath;
		}),
		unloadModel: vi.fn(async () => {
			loaderState.unloadCalls += 1;
			loaderState.currentPath = null;
		}),
		generate: vi.fn(async (args: unknown) => {
			loaderState.generateCalls.push(args);
			return "ok";
		}),
		embed: vi.fn(async () => ({ embedding: [0.1, 0.2], tokens: 2 })),
	};
	const runtime = {
		agentId: "agent-test",
		getModel: vi.fn(() => undefined),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_RUNTIME_MODE" ? modeState.mode : undefined,
		),
		getService: vi.fn((name: string) =>
			name === "localInferenceLoader" ? loader : null,
		),
		registerModel: vi.fn(
			(
				modelType: string | number,
				handler: unknown,
				provider: string,
				priority?: number,
			) => {
				registrations.push({ modelType, provider, priority, handler });
			},
		),
		registerService: vi.fn(),
	} as unknown as AgentRuntime;
	return { registrations, runtime, loader };
}

beforeEach(() => {
	vi.clearAllMocks();
	modeState.mode = "local";
	assignmentsState.value = {};
	installedState.value = [];
	loaderState.currentPath = null;
	loaderState.loadCalls = [];
	loaderState.unloadCalls = 0;
	loaderState.generateCalls = [];
	delete process.env.ELIZA_LOCAL_LLAMA;
	delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
});

describe("ensureAssignedModelLoaded (via TEXT_LARGE handler)", () => {
	it("throws when slot is unassigned and the loaded model is embedding-role (issue #7687)", async () => {
		// Mirror the on-device failure: an embedding model is the only thing
		// loaded, and no chat slot assignment exists. The old behaviour
		// silently dispatched completion to the embedding model and emitted
		// `[unused{N}]` garbage. The new behaviour throws.
		installedState.value = [
			{
				id: "bge-small-en-v1.5",
				path: "/tmp/bge-small-en-v1.5.gguf",
				sizeBytes: 100_000_000,
				source: "external-scan",
			},
		];
		loaderState.currentPath = "/tmp/bge-small-en-v1.5.gguf";
		assignmentsState.value = {}; // No chat assignment.

		const { registrations, runtime } = makeRuntime();
		await ensureLocalInferenceHandler(runtime);

		const handler = registrations.find(
			(entry) => entry.modelType === ModelType.TEXT_LARGE,
		)?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;
		expect(handler).toBeDefined();

		await expect(
			handler?.(runtime, { prompt: "hello" }),
		).rejects.toThrowError(/No chat model assigned for slot TEXT_LARGE/);
	});

	it("does not throw when slot is unassigned but no embedding model is loaded", async () => {
		// No assignment + no resident embedding model = pre-existing
		// fall-through behaviour for compatibility. Loader runs generate
		// against whatever it has (or nothing, in this mock setup).
		installedState.value = [];
		loaderState.currentPath = null;
		assignmentsState.value = {};

		const { registrations, runtime, loader } = makeRuntime();
		await ensureLocalInferenceHandler(runtime);

		const handler = registrations.find(
			(entry) => entry.modelType === ModelType.TEXT_LARGE,
		)?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;

		await expect(
			handler?.(runtime, { prompt: "hello" }),
		).resolves.toBe("ok");
		// No model swap should have been attempted.
		expect(loader.unloadModel).not.toHaveBeenCalled();
		expect(loader.loadModel).not.toHaveBeenCalled();
	});

	it("loads the assigned model when one is set and not yet resident", async () => {
		installedState.value = [
			{
				id: "llama-3.2-1b-instruct",
				path: "/tmp/llama-3.2-1b-instruct.gguf",
				sizeBytes: 800_000_000,
				source: "external-scan",
			},
		];
		assignmentsState.value = { TEXT_LARGE: "llama-3.2-1b-instruct" };

		const { registrations, runtime, loader } = makeRuntime();
		await ensureLocalInferenceHandler(runtime);

		const handler = registrations.find(
			(entry) => entry.modelType === ModelType.TEXT_LARGE,
		)?.handler as
			| ((
					runtime: AgentRuntime,
					params: Record<string, unknown>,
			  ) => Promise<string>)
			| undefined;

		await handler?.(runtime, { prompt: "hello" });

		expect(loader.unloadModel).toHaveBeenCalledTimes(1);
		expect(loader.loadModel).toHaveBeenCalledTimes(1);
		expect(loaderState.loadCalls[0]).toMatchObject({
			modelPath: "/tmp/llama-3.2-1b-instruct.gguf",
		});
	});
});
