/**
 * Tests for the voice-onboarding HTTP routes — capture + finalize +
 * OWNER bootstrap.
 *
 * Owner bootstrap (R2-speaker.md §5.2):
 *
 *   POST /api/voice/onboarding/complete { entityId }
 *     → writes ELIZA_ADMIN_ENTITY_ID via the registered settings writer,
 *       returns { ownerEntityId, settingsWritten:["ELIZA_ADMIN_ENTITY_ID"] }
 *
 * The actual `ensureOwnerRole` bootstrap runs in the agent runtime on
 * the next boot — the runtime resolver reads ELIZA_ADMIN_ENTITY_ID and
 * grants OWNER. This test verifies the route writes the setting; the
 * bootstrap itself is covered by `packages/agent` tests on the
 * `ensureOwnerRole` function.
 *
 * Capture + finalize are tested with a stub speaker encoder so the
 * route handlers don't need onnxruntime-node at test time.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import {
	type SpeakerEncoder,
	WESPEAKER_EMBEDDING_DIM,
	WESPEAKER_MIN_SAMPLES,
	WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	WESPEAKER_SAMPLE_RATE,
} from "../src/services/voice/speaker/encoder";
import {
	__resetVoiceOnboardingSessions,
	handleVoiceOnboardingRoutes,
	ONBOARDING_SCRIPT,
	setVoiceOnboardingEncoderFactory,
	setVoiceOnboardingProfileStore,
	setVoiceOnboardingSettingsWriter,
} from "../src/routes/voice-onboarding-routes";

let tmpRoot: string;
const recordedSettings: Array<{ key: string; value: string }> = [];

class StubEncoder implements SpeakerEncoder {
	readonly modelId = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;
	readonly embeddingDim = WESPEAKER_EMBEDDING_DIM;
	readonly sampleRate = WESPEAKER_SAMPLE_RATE;
	async encode(_pcm: Float32Array): Promise<Float32Array> {
		// Deterministic non-zero embedding so averaging produces a
		// well-defined centroid.
		const out = new Float32Array(this.embeddingDim);
		for (let i = 0; i < this.embeddingDim; i += 1) out[i] = (i + 1) / this.embeddingDim;
		let sumSq = 0;
		for (const v of out) sumSq += v * v;
		const inv = 1 / Math.sqrt(sumSq);
		for (let i = 0; i < this.embeddingDim; i += 1) out[i] *= inv;
		return out;
	}
	async dispose(): Promise<void> {}
}

/** Minimal IncomingMessage stand-in for `handleVoiceOnboardingRoutes`. */
function makeReq(args: {
	method: "GET" | "POST";
	url: string;
	body?: Buffer | string | null;
	headers?: Record<string, string>;
}): import("node:http").IncomingMessage {
	const emitter = new EventEmitter();
	const body = args.body == null
		? Buffer.alloc(0)
		: typeof args.body === "string"
			? Buffer.from(args.body)
			: args.body;
	(emitter as unknown as { method: string }).method = args.method;
	(emitter as unknown as { url: string }).url = args.url;
	(emitter as unknown as { headers: Record<string, string> }).headers =
		args.headers ?? {};
	// `readRequestBodyBuffer` listens on 'data'/'end' synchronously after
	// the route handler invokes it; schedule the emit via microtask so the
	// listeners are attached first.
	const originalOn = emitter.on.bind(emitter);
	let scheduled = false;
	(emitter as unknown as { on: typeof emitter.on }).on = function patchedOn(
		event: string,
		listener: (...args: unknown[]) => void,
	) {
		const out = originalOn(event, listener);
		if ((event === "data" || event === "end") && !scheduled) {
			scheduled = true;
			queueMicrotask(() => {
				if (body.length > 0) emitter.emit("data", body);
				emitter.emit("end");
			});
		}
		return out;
	} as typeof emitter.on;
	// Async iterator for `for await (chunk of req)` consumers.
	(emitter as unknown as {
		[Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
	})[Symbol.asyncIterator] = async function* () {
		yield body;
	};
	return emitter as unknown as import("node:http").IncomingMessage;
}

interface CapturedResponse {
	statusCode: number;
	body: string;
	headers: Record<string, string>;
}

/** Minimal ServerResponse stand-in. */
function makeRes(): { res: import("node:http").ServerResponse; captured: CapturedResponse } {
	const captured: CapturedResponse = { statusCode: 200, body: "", headers: {} };
	const chunks: Buffer[] = [];
	const res = {
		statusCode: 200,
		headersSent: false,
		setHeader(name: string, value: string) {
			captured.headers[name] = value;
		},
		writeHead(code: number, headers?: Record<string, string>) {
			captured.statusCode = code;
			if (headers) Object.assign(captured.headers, headers);
		},
		write(chunk: Buffer | string) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			return true;
		},
		end(chunk?: Buffer | string) {
			if (chunk != null) {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			}
			captured.body = Buffer.concat(chunks).toString("utf8");
			captured.statusCode = (res as unknown as { statusCode: number }).statusCode;
		},
	};
	return {
		res: res as unknown as import("node:http").ServerResponse,
		captured,
	};
}

function f32Buffer(samples: number, fill = 0.1): Buffer {
	const arr = new Float32Array(samples);
	for (let i = 0; i < samples; i += 1) arr[i] = fill;
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "vp-onboard-"));
	recordedSettings.length = 0;
	__resetVoiceOnboardingSessions();
	setVoiceOnboardingEncoderFactory(async () => new StubEncoder());
	const store = new VoiceProfileStore({ rootDir: tmpRoot });
	await store.init();
	setVoiceOnboardingProfileStore(store);
	setVoiceOnboardingSettingsWriter((key, value) => {
		recordedSettings.push({ key, value });
	});
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	setVoiceOnboardingEncoderFactory(null);
	setVoiceOnboardingProfileStore(null);
	setVoiceOnboardingSettingsWriter(null);
});

describe("ONBOARDING_SCRIPT", () => {
	it("exposes the 10-step capture script (R2 §6.2)", () => {
		expect(ONBOARDING_SCRIPT).toHaveLength(10);
		const roles = new Set(ONBOARDING_SCRIPT.map((s) => s.role));
		// Five distinct roles: consent / calibration / phonetic / prosody / quiet / open.
		expect(roles).toEqual(
			new Set(["consent", "calibration", "phonetic", "prosody", "quiet", "open"]),
		);
		// Each step has a positive expected duration.
		for (const step of ONBOARDING_SCRIPT) {
			expect(step.expectedDurationMs).toBeGreaterThan(0);
			expect(step.id).toMatch(/^[a-z0-9-]+$/);
			expect(step.requiresUserSpeech).toBe(true);
		}
	});
});

describe("handleVoiceOnboardingRoutes — start session", () => {
	it("POST /profile/start returns sessionId + script + encoder defaults", async () => {
		const { res, captured } = makeRes();
		const handled = await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/profile/start",
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
			}),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body);
		expect(json.sessionId).toMatch(/^obs_/);
		expect(json.embeddingModel).toBe(WESPEAKER_RESNET34_LM_INT8_MODEL_ID);
		expect(json.expectedSampleRate).toBe(WESPEAKER_SAMPLE_RATE);
		expect(json.minSamplesPerCapture).toBe(WESPEAKER_MIN_SAMPLES);
		expect(json.script).toHaveLength(10);
	});

	it("non-onboarding routes return false (fall-through)", async () => {
		const { res } = makeRes();
		const handled = await handleVoiceOnboardingRoutes(
			makeReq({ method: "POST", url: "/api/other-route" }),
			res,
		);
		expect(handled).toBe(false);
	});

	it("POST /profile/start with no body still starts a session (defaults consent)", async () => {
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({ method: "POST", url: "/api/voice/onboarding/profile/start" }),
			res,
		);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body);
		expect(json.sessionId).toMatch(/^obs_/);
	});
});

describe("handleVoiceOnboardingRoutes — capture + finalize", () => {
	async function startSession(): Promise<string> {
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/profile/start",
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
			}),
			res,
		);
		return JSON.parse(captured.body).sessionId;
	}

	it("POST /profile/append accepts PCM and counts samples", async () => {
		const sessionId = await startSession();
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: `/api/voice/onboarding/profile/append?id=${sessionId}`,
				body: f32Buffer(WESPEAKER_MIN_SAMPLES),
			}),
			res,
		);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body);
		expect(json.sessionId).toBe(sessionId);
		expect(json.samplesReceived).toBe(1);
		expect(json.totalSamples).toBe(WESPEAKER_MIN_SAMPLES);
		expect(json.durationMs).toBeGreaterThan(0);
	});

	it("POST /profile/append rejects short capture", async () => {
		const sessionId = await startSession();
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: `/api/voice/onboarding/profile/append?id=${sessionId}`,
				body: f32Buffer(100),
			}),
			res,
		);
		expect(captured.statusCode).toBe(400);
		expect(captured.body).toMatch(/capture too short/);
	});

	it("POST /profile/append on unknown session returns 404", async () => {
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/profile/append?id=bogus",
				body: f32Buffer(WESPEAKER_MIN_SAMPLES),
			}),
			res,
		);
		expect(captured.statusCode).toBe(404);
	});

	it("POST /profile/finalize creates a profile bound to the entity", async () => {
		const sessionId = await startSession();
		// Append two captures.
		for (let i = 0; i < 2; i += 1) {
			const { res } = makeRes();
			await handleVoiceOnboardingRoutes(
				makeReq({
					method: "POST",
					url: `/api/voice/onboarding/profile/append?id=${sessionId}`,
					body: f32Buffer(WESPEAKER_MIN_SAMPLES),
				}),
				res,
			);
		}
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: `/api/voice/onboarding/profile/finalize?id=${sessionId}&entityId=ent_shaw`,
			}),
			res,
		);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body);
		expect(json.profileId).toMatch(/^vp_/);
		expect(json.entityId).toBe("ent_shaw");
		expect(json.samples).toBe(1); // newly-created profile has sampleCount=1
		expect(json.durationMs).toBeGreaterThan(0);
	});

	it("POST /profile/finalize with no captures yields 400", async () => {
		const sessionId = await startSession();
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: `/api/voice/onboarding/profile/finalize?id=${sessionId}`,
			}),
			res,
		);
		expect(captured.statusCode).toBe(400);
		expect(captured.body).toMatch(/no embeddings captured/);
	});
});

describe("handleVoiceOnboardingRoutes — OWNER bootstrap", () => {
	it("POST /complete writes ELIZA_ADMIN_ENTITY_ID via the registered writer", async () => {
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/complete",
				body: JSON.stringify({ entityId: "ent_shaw" }),
				headers: { "content-type": "application/json" },
			}),
			res,
		);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body);
		expect(json.ownerEntityId).toBe("ent_shaw");
		expect(json.settingsWritten).toEqual(["ELIZA_ADMIN_ENTITY_ID"]);
		expect(recordedSettings).toEqual([
			{ key: "ELIZA_ADMIN_ENTITY_ID", value: "ent_shaw" },
		]);
	});

	it("POST /complete without entityId returns 400", async () => {
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/complete",
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
			}),
			res,
		);
		expect(captured.statusCode).toBe(400);
		expect(captured.body).toMatch(/entityId is required/);
		expect(recordedSettings).toEqual([]);
	});

	it("POST /complete returns 503 when no settings writer is configured", async () => {
		setVoiceOnboardingSettingsWriter(null);
		const { res, captured } = makeRes();
		await handleVoiceOnboardingRoutes(
			makeReq({
				method: "POST",
				url: "/api/voice/onboarding/complete",
				body: JSON.stringify({ entityId: "ent_shaw" }),
				headers: { "content-type": "application/json" },
			}),
			res,
		);
		expect(captured.statusCode).toBe(503);
		expect(captured.body).toMatch(/settings writer not configured/);
	});
});
