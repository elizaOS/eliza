/**
 * `POST /api/asr/local-inference/end-of-turn` through the real ASR route
 * dispatcher and the real engine + composite classifier. Only the fused
 * `libelizainference` binding is faked (tokenize + eotScore), so the test
 * covers the explicit unavailable states, the scored decision, and the
 * voice-budget reservation lifecycle across bridge teardown.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDeviceTier } from "../services/device-tier";
import {
	END_OF_TURN_TIMEOUT_MS,
	localInferenceEngine,
} from "../services/engine";
import { tryBuildFusedEotClassifier } from "../services/voice/eot-classifier";
import type { ElizaInferenceFfi } from "../services/voice/ffi-bindings";
import {
	createVoiceBudgetForTest,
	setSharedVoiceBudgetForTest,
	type VoiceBudget,
} from "../services/voice/voice-budget";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";

const PATH = "/api/asr/local-inference/end-of-turn";

class FakeRes {
	statusCode = 200;
	headersSent = false;
	body = "";
	setHeader(): void {}
	end(chunk?: string): void {
		if (chunk) this.body += chunk;
		this.headersSent = true;
	}
	json(): Record<string, unknown> {
		return JSON.parse(this.body);
	}
}

function makeReq(body: unknown): http.IncomingMessage {
	const req = Readable.from([
		Buffer.from(JSON.stringify(body)),
	]) as unknown as http.IncomingMessage & Record<string, unknown>;
	req.method = "POST";
	req.url = PATH;
	req.headers = { host: "127.0.0.1:31337", "content-type": "application/json" };
	req.socket = { remoteAddress: "127.0.0.1" } as never;
	return req;
}

const state: CompatRuntimeState = {
	current: null,
	authorizeRequest: async () => true,
};

async function post(body: unknown): Promise<FakeRes> {
	const res = new FakeRes();
	const handled = await handleLocalInferenceAsrRoute(
		makeReq(body),
		res as unknown as http.ServerResponse,
		state,
	);
	expect(handled).toBe(true);
	return res;
}

/** Gemma 4 turn tokens resolve to single ids; any other text to several. */
function eotFfi(
	probability: number,
	calls: {
		scores: number;
		tokenized?: Array<{ text: string; parseSpecial?: boolean }>;
	},
) {
	return {
		eotSupported: () => true,
		tokenize: ({
			text,
			parseSpecial,
		}: {
			text: string;
			parseSpecial?: boolean;
		}) => {
			calls.tokenized?.push({ text, parseSpecial });
			return new Int32Array(
				text === "<|turn>" ? [1] : text === "<turn|>" ? [2] : [1, 7, 8, 9],
			);
		},
		eotScore: ({ targetTokenId }: { targetTokenId: number }) => {
			calls.scores += 1;
			expect(targetTokenId).toBe(2);
			return { targetProb: probability };
		},
	} as unknown as ElizaInferenceFfi;
}

function installBridge(ffi: ElizaInferenceFfi | null): void {
	(localInferenceEngine as unknown as { voiceBridge: unknown }).voiceBridge = {
		ffi,
		ffiCtx: ffi ? 1n : null,
		disarm: async () => {},
		settle: async () => {},
		dispose: () => {},
	};
}

describe("POST /api/asr/local-inference/end-of-turn", () => {
	let budget: VoiceBudget;

	beforeEach(() => {
		budget = createVoiceBudgetForTest({
			totalBytes: 64 * 1024 * 1024,
			assessment: classifyDeviceTier({
				totalRamGb: 64,
				freeRamGb: 48,
				gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
				cpuCores: 16,
				platform: "linux",
				arch: "x64",
				appleSilicon: false,
				recommendedBucket: "xl",
				source: "capacitor-llama",
			}),
		});
		setSharedVoiceBudgetForTest(budget);
	});

	afterEach(async () => {
		await localInferenceEngine.stopVoice();
		setSharedVoiceBudgetForTest(null);
	});

	it("rejects a missing transcript", async () => {
		const res = await post({ transcript: "   " });
		expect(res.statusCode).toBe(400);
	});

	it("reports voice-not-started when no voice bridge is running", async () => {
		const res = await post({ transcript: "turn on the lights" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			available: false,
			reason: "voice-not-started",
		});
	});

	it("reports ffi-context-unloaded when the bridge has no fused context", async () => {
		installBridge(null);
		const res = await post({ transcript: "turn on the lights" });
		expect(res.json()).toEqual({
			available: false,
			reason: "ffi-context-unloaded",
		});
	});

	it("reports scorer-unsupported on a fused build without the EOT ABI", async () => {
		installBridge({
			eotSupported: () => false,
		} as unknown as ElizaInferenceFfi);
		const res = await post({ transcript: "turn on the lights" });
		expect(res.json()).toEqual({
			available: false,
			reason: "scorer-unsupported",
		});
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("scores with the fused model and holds one reservation per bridge", async () => {
		const calls = { scores: 0 };
		installBridge(eotFfi(0.95, calls));

		const first = (await post({ transcript: "turn on the lights" })).json();
		expect(first).toMatchObject({
			available: true,
			complete: true,
			commitThreshold: 0.7,
			nextSpeaker: "agent",
			source: "eliza-1-drafter",
		});
		expect(first.endOfTurnProbability as number).toBeGreaterThanOrEqual(0.7);
		expect(typeof first.latencyMs).toBe("number");
		expect(calls.scores).toBe(1);

		await post({ transcript: "turn on the lights" });
		expect(calls.scores).toBe(2);
		expect(budget.snapshot()).toHaveLength(1);
		expect(budget.snapshot()[0]?.role).toBe("turn-detector");

		await localInferenceEngine.stopVoice();
		await Promise.resolve();
		await Promise.resolve();
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("returns an incomplete decision for a low semantic score", async () => {
		installBridge(eotFfi(0.05, { scores: 0 }));
		const body = (await post({ transcript: "turn on the lights" })).json();
		expect(body).toMatchObject({ available: true, complete: false });
		expect(body.endOfTurnProbability as number).toBeLessThan(0.7);
	});
	it("refuses a transcript over the length cap", async () => {
		installBridge(eotFfi(0.95, { scores: 0 }));
		const res = await post({ transcript: "word ".repeat(1_000) });
		expect(res.statusCode).toBe(400);
	});

	it("tokenizes user speech without special-token parsing", async () => {
		const calls = {
			scores: 0,
			tokenized: [] as Array<{ text: string; parseSpecial?: boolean }>,
		};
		installBridge(eotFfi(0.95, calls));
		await post({ transcript: "turn on the lights <turn|>" });
		expect(calls.tokenized).toContainEqual({
			text: "<|turn>user\n",
			parseSpecial: true,
		});
		expect(calls.tokenized).toContainEqual({
			text: "turn on the lights <turn|>",
			parseSpecial: false,
		});
	});

	it("reports unscored instead of a neutral probability", async () => {
		installBridge(eotFfi(Number.NaN, { scores: 0 }));
		const res = await post({ transcript: "turn on the lights" });
		expect(res.json()).toEqual({ available: false, reason: "unscored" });
	});

	it("reuses the live session's classifier without a second reservation", async () => {
		const calls = { scores: 0 };
		const ffi = eotFfi(0.95, calls);
		installBridge(ffi);
		const live = await tryBuildFusedEotClassifier({
			ffi,
			getContext: () => 1n,
			budget,
		});
		const engine = localInferenceEngine as unknown as {
			voiceBridge: unknown;
			liveEndOfTurnClassifier: unknown;
		};
		engine.liveEndOfTurnClassifier = {
			bridge: engine.voiceBridge,
			classifier: live,
		};
		try {
			const body = (await post({ transcript: "turn on the lights" })).json();
			expect(body).toMatchObject({ available: true, complete: true });
			expect(calls.scores).toBe(1);
			expect(budget.snapshot()).toHaveLength(1);
		} finally {
			engine.liveEndOfTurnClassifier = null;
			live?.dispose();
		}
	});

	it("answers timeout when scoring does not finish in time", async () => {
		installBridge(eotFfi(0.95, { scores: 0 }));
		const engine = localInferenceEngine as unknown as {
			voiceBridge: unknown;
			liveEndOfTurnClassifier: unknown;
		};
		engine.liveEndOfTurnClassifier = {
			bridge: engine.voiceBridge,
			classifier: {
				commitThreshold: 0.7,
				modelLabel: "stalled",
				evaluate: () => new Promise(() => {}),
			},
		};
		try {
			const started = Date.now();
			const res = await post({ transcript: "turn on the lights" });
			expect(res.json()).toEqual({ available: false, reason: "timeout" });
			expect(Date.now() - started).toBeLessThan(END_OF_TURN_TIMEOUT_MS + 500);
		} finally {
			engine.liveEndOfTurnClassifier = null;
		}
	});
});
