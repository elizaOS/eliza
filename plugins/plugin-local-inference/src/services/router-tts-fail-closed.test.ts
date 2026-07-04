/**
 * Router fail-closed contract for TEXT_TO_SPEECH (#12253): a configured voice
 * may fail, but the router must never silently rotate to a different engine.
 * Drives the real router + real policy engine against a fake runtime.models map
 * (the introspection path), with a strong device tier so prefer-local
 * deterministically prefers the local voice regardless of the host.
 */

import {
	type AgentRuntime,
	type IAgentRuntime,
	ModelType,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefsState = {
	policy: {} as Record<string, string>,
	preferredProvider: {} as Record<string, string>,
};

vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: vi.fn(async () => prefsState),
}));

// A CUDA workstation → MAX tier → canRunLocalVoice = true, so prefer-local picks
// the local voice first. Mocking the probe keeps the test host-independent.
const strongProbe = {
	totalRamGb: 64,
	freeRamGb: 48,
	gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
	cpuCores: 16,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "high",
	source: "test",
};

vi.mock("./hardware", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hardware")>()),
	probeHardware: vi.fn(async () => strongProbe),
}));

import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

type Handler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

interface Candidate {
	provider: string;
	priority: number;
	handler: Handler;
}

function installFor(slot: string): Map<string, Handler> {
	const routerHandlers = new Map<string, Handler>();
	const installTarget = {
		registerModel: vi.fn(
			(modelType: string, handler: Handler, provider: string) => {
				if (provider === ROUTER_PROVIDER)
					routerHandlers.set(modelType, handler);
			},
		),
	} as unknown as AgentRuntime;
	installRouterHandler(installTarget, {
		skipSlots: (
			[
				"TEXT_SMALL",
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			] as const
		).filter((s) => s !== slot),
	});
	return routerHandlers;
}

function routerFor(modelType: string, candidates: Candidate[]) {
	const slot =
		modelType === ModelType.TEXT_TO_SPEECH ? "TEXT_TO_SPEECH" : "TEXT_LARGE";
	const routerHandlers = installFor(slot);
	const runtime = {
		models: new Map<string, unknown[]>([[modelType, candidates]]),
	} as unknown as IAgentRuntime;
	const router = routerHandlers.get(modelType);
	if (!router) throw new Error(`router handler for ${modelType} not installed`);
	return { router, runtime };
}

beforeEach(() => {
	vi.clearAllMocks();
	prefsState.policy = {};
	prefsState.preferredProvider = {};
});

describe("router fails closed for TEXT_TO_SPEECH (#12253)", () => {
	it("re-throws the local Kokoro error and never invokes edge-tts (prefer-local)", async () => {
		const kokoroError = new Error(
			"Kokoro artifacts missing: no runtime available",
		);
		const localHandler = vi.fn(async () => {
			throw kokoroError;
		});
		const edgeHandler = vi.fn(async () => new Uint8Array([1, 2, 3]));

		const { router, runtime } = routerFor(ModelType.TEXT_TO_SPEECH, [
			{ provider: "eliza-local-inference", priority: 0, handler: localHandler },
			{ provider: "edge-tts", priority: 0, handler: edgeHandler },
		]);

		await expect(router(runtime, { text: "hi" })).rejects.toBe(kokoroError);
		expect(localHandler).toHaveBeenCalledTimes(1);
		// The whole point: no silent voice swap.
		expect(edgeHandler).not.toHaveBeenCalled();
	});

	it("re-throws even when the picked cloud voice fails (no secondary rotation)", async () => {
		// Explicit cloud TTS config via prefer-local on a box with no local voice
		// candidate: the configured cloud engine is edge; if it fails we must still
		// fail closed rather than rotate to elevenlabs/openai/etc.
		const edgeError = new Error("edge-tts 503");
		const edgeHandler = vi.fn(async () => {
			throw edgeError;
		});
		const elevenHandler = vi.fn(async () => new Uint8Array([9]));

		const { router, runtime } = routerFor(ModelType.TEXT_TO_SPEECH, [
			{ provider: "edge-tts", priority: 10, handler: edgeHandler },
			{ provider: "elevenlabs", priority: 5, handler: elevenHandler },
		]);

		await expect(router(runtime, { text: "hi" })).rejects.toBe(edgeError);
		expect(edgeHandler).toHaveBeenCalledTimes(1);
		expect(elevenHandler).not.toHaveBeenCalled();
	});

	it("allows an explicitly configured manual multi-provider TTS chain to rotate", async () => {
		prefsState.policy.TEXT_TO_SPEECH = "manual"; // user-configured chain

		const primaryError = new Error("elevenlabs down");
		const elevenHandler = vi.fn(async () => {
			throw primaryError;
		});
		const edgeHandler = vi.fn(async () => new Uint8Array([7, 7]));

		const { router, runtime } = routerFor(ModelType.TEXT_TO_SPEECH, [
			{ provider: "elevenlabs", priority: 10, handler: elevenHandler },
			{ provider: "edge-tts", priority: 0, handler: edgeHandler },
		]);

		const result = (await router(runtime, { text: "hi" })) as Uint8Array;
		expect(Array.from(result)).toEqual([7, 7]);
		expect(elevenHandler).toHaveBeenCalledTimes(1);
		expect(edgeHandler).toHaveBeenCalledTimes(1);
	});
});

describe("non-TTS slots keep transient failover", () => {
	it("rotates TEXT_LARGE to the next provider on failure (prefer-local, cloud-only)", async () => {
		const primaryError = new Error("openai 500");
		const openaiHandler = vi.fn(async () => {
			throw primaryError;
		});
		const anthropicHandler = vi.fn(async () => "anthropic-result");

		const { router, runtime } = routerFor(ModelType.TEXT_LARGE, [
			{ provider: "openai", priority: 10, handler: openaiHandler },
			{ provider: "anthropic", priority: 5, handler: anthropicHandler },
		]);

		const result = await router(runtime, { prompt: "hi" });
		expect(result).toBe("anthropic-result");
		expect(openaiHandler).toHaveBeenCalledTimes(1);
		expect(anthropicHandler).toHaveBeenCalledTimes(1);
	});
});
