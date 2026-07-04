/**
 * Voice-modality visibility (#12253, WI2): when the device tier cannot run the
 * local voice stack, prefer-local routes TEXT_TO_SPEECH to a cloud voice by
 * configuration (not error recovery) — and the router announces it exactly once
 * per boot at warn. Drives the real router + policy with a weak-device probe.
 */

import {
	type AgentRuntime,
	type IAgentRuntime,
	logger,
	ModelType,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefsState = {
	policy: {} as Record<string, string>,
	preferredProvider: {} as Record<string, string>,
};

vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: vi.fn(async () => prefsState),
}));

// A 4 GB box → POOR tier → canRunLocalVoice = false, so prefer-local demotes
// the local voice to cloud. Mocked so the test is host-independent.
const weakProbe = {
	totalRamGb: 4,
	freeRamGb: 1.5,
	gpu: null,
	cpuCores: 2,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "low",
	source: "test",
};

vi.mock("./hardware", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hardware")>()),
	probeHardware: vi.fn(async () => weakProbe),
}));

import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

type Handler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

function setup() {
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
		skipSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING", "TRANSCRIPTION"],
	});
	const localHandler = vi.fn(async () => new Uint8Array([1]));
	const edgeHandler = vi.fn(async () => new Uint8Array([2]));
	const runtime = {
		models: new Map<string, unknown[]>([
			[
				ModelType.TEXT_TO_SPEECH,
				[
					{
						provider: "eliza-local-inference",
						priority: 0,
						handler: localHandler,
					},
					{ provider: "edge-tts", priority: 0, handler: edgeHandler },
				],
			],
		]),
	} as unknown as IAgentRuntime;
	const router = routerHandlers.get(ModelType.TEXT_TO_SPEECH);
	if (!router) throw new Error("router handler for TTS not installed");
	return { router, runtime, localHandler, edgeHandler };
}

beforeEach(() => {
	vi.clearAllMocks();
	prefsState.policy = {};
	prefsState.preferredProvider = {};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("prefer-local TTS on an unviable device tier", () => {
	it("routes to the configured cloud voice and warns exactly once per boot", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		const { router, runtime, localHandler, edgeHandler } = setup();

		const first = (await router(runtime, { text: "hi" })) as Uint8Array;
		const second = (await router(runtime, { text: "again" })) as Uint8Array;

		// The device can't run local voice → cloud (edge) is the configured pick;
		// the local voice is never attempted (a policy decision, not recovery).
		expect(Array.from(first)).toEqual([2]);
		expect(Array.from(second)).toEqual([2]);
		expect(localHandler).not.toHaveBeenCalled();
		expect(edgeHandler).toHaveBeenCalledTimes(2);

		const voiceWarns = warnSpy.mock.calls.filter((call) =>
			JSON.stringify(call).includes("Local voice stack unviable"),
		);
		expect(voiceWarns).toHaveLength(1);
	});
});
