/**
 * Failure-path evidence for #12253: with the Paradee-8M v1.1 artifacts
 * genuinely absent on disk, the whole TTS chain fails LOUD and never
 * substitutes another voice — not edge-tts, and not a staged Kokoro either.
 * Unlike router-tts-fail-closed.test.ts (which injects a synthetic throw), this
 * drives the REAL on-disk artifact check (`discoverParadeeEngine` against an
 * empty temp dir → not ok) through the REAL engine selector
 * (`selectVoiceBackend` → throws) and into the REAL router + policy engine,
 * asserting the router re-throws that real error and edge-tts is never
 * invoked. Run with `--reporter verbose` to capture the transcript as issue
 * evidence.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AgentRuntime,
	type IAgentRuntime,
	logger,
	ModelType,
} from "@elizaos/core";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { discoverParadeeEngine } from "./voice/paradee/paradee-engine-discovery";
import { selectVoiceBackend } from "./voice/tts-backend-selection";

const prefsState = {
	policy: {} as Record<string, string>,
	preferredProvider: {} as Record<string, string>,
};

vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: vi.fn(async () => prefsState),
}));

// MAX-tier probe so prefer-local deterministically picks the local voice first;
// the point of the test is what happens when that local voice's artifacts are
// missing, not host-tier demotion.
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

// A real empty state dir → the on-disk Paradee probe finds nothing.
const emptyStateDir = mkdtempSync(path.join(tmpdir(), "paradee-absent-"));
const priorEnv = {
	ELIZA_PARADEE_MODEL_DIR: process.env.ELIZA_PARADEE_MODEL_DIR,
	ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
};

beforeEach(() => {
	vi.clearAllMocks();
	prefsState.policy = {};
	prefsState.preferredProvider = {};
	process.env.ELIZA_PARADEE_MODEL_DIR = emptyStateDir;
	process.env.ELIZA_STATE_DIR = emptyStateDir;
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const [key, value] of Object.entries(priorEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(emptyStateDir, { recursive: true, force: true });
});

/** The real on-disk gate the local TTS handler consults before synthesizing. */
function realLocalTtsHandler(): Uint8Array {
	const paradee = discoverParadeeEngine();
	const decision = selectVoiceBackend({
		paradeeAvailable: paradee.ok,
		paradeeUnavailableReason: paradee.ok ? undefined : paradee.reason,
		// A staged Kokoro must not stand in for the product voice.
		kokoroAvailable: true,
	});
	// Unreachable when artifacts are absent — selectVoiceBackend throws first.
	return new Uint8Array([decision.backend.length]);
}

describe("#12253 failure-path evidence — Paradee artifacts absent", () => {
	it("the real on-disk probe reports Paradee missing when nothing is staged", () => {
		const found = discoverParadeeEngine();
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.reason).toMatch(/not staged/);
	});

	it("the real engine selector throws a loud, actionable error (no silent downgrade)", () => {
		expect(() =>
			selectVoiceBackend({ paradeeAvailable: false, kokoroAvailable: true }),
		).toThrow(/Paradee-8M v1\.1 is the on-device TTS backend/);
	});

	it("the real router re-throws the real Paradee error and never calls edge-tts", async () => {
		const errorSpy = vi.spyOn(logger, "error");
		const edgeHandler = vi.fn(async () => new Uint8Array([9, 9, 9]));

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
			skipSlots: [
				"TEXT_SMALL",
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TRANSCRIPTION",
			],
		});

		const runtime = {
			models: new Map<string, unknown[]>([
				[
					ModelType.TEXT_TO_SPEECH,
					[
						{
							provider: "eliza-local-inference",
							priority: 0,
							handler: async () => realLocalTtsHandler(),
						},
						{ provider: "edge-tts", priority: 0, handler: edgeHandler },
					],
				],
			]),
		} as unknown as IAgentRuntime;

		const router = routerHandlers.get(ModelType.TEXT_TO_SPEECH);
		if (!router) throw new Error("router handler for TTS not installed");

		await expect(router(runtime, { text: "hello" })).rejects.toThrow(
			/Paradee-8M v1\.1 is the on-device TTS backend/,
		);
		// The whole point: no silent voice swap to another engine.
		expect(edgeHandler).not.toHaveBeenCalled();
		// And the fail-closed refusal was announced loudly.
		const failClosedLogged = errorSpy.mock.calls.some((call) =>
			JSON.stringify(call).includes("failing closed"),
		);
		expect(failClosedLogged).toBe(true);
	});
});
