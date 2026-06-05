/**
 * Tests for the speaker voice-profile binding routes.
 *
 * These cover the runtime path that was missing in issue #8234: binding a
 * recognized voice profile to an elizaOS entity (and unbinding it) so the
 * attribution pipeline can resolve `entityId` on later recognitions instead of
 * leaving it permanently `null`.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleVoiceSpeakerProfileRoutes,
	setVoiceSpeakerProfileStore,
} from "../src/routes/voice-speaker-profile-routes";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";

const MODEL = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;

let tmpRoot: string;
let store: VoiceProfileStore;

/** L2-normalize a short vector so cosine == dot. */
function unit(values: number[]): Float32Array {
	let sumSq = 0;
	for (const v of values) sumSq += v * v;
	const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
	return new Float32Array(values.map((v) => v * inv));
}

/** Minimal IncomingMessage stand-in. */
function makeReq(args: {
	method: "GET" | "POST";
	url: string;
	body?: string | null;
}): import("node:http").IncomingMessage {
	const emitter = new EventEmitter();
	const body =
		args.body == null ? Buffer.alloc(0) : Buffer.from(args.body, "utf8");
	(emitter as unknown as { method: string }).method = args.method;
	(emitter as unknown as { url: string }).url = args.url;
	(emitter as unknown as { headers: Record<string, string> }).headers = {
		"content-type": "application/json",
		"content-length": String(body.length),
	};
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
	(
		emitter as unknown as {
			[Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
		}
	)[Symbol.asyncIterator] = async function* () {
		yield body;
	};
	return emitter as unknown as import("node:http").IncomingMessage;
}

interface CapturedResponse {
	statusCode: number;
	body: string;
}

/** Minimal ServerResponse stand-in. */
function makeRes(): {
	res: import("node:http").ServerResponse;
	captured: CapturedResponse;
} {
	const captured: CapturedResponse = { statusCode: 200, body: "" };
	const chunks: Buffer[] = [];
	const res = {
		statusCode: 200,
		headersSent: false,
		setHeader() {},
		writeHead(code: number) {
			captured.statusCode = code;
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
			// `sendJsonError` sets `res.statusCode` directly rather than calling
			// `writeHead`, so fold it in here unless `writeHead` already set one.
			if (captured.statusCode === 200) {
				captured.statusCode = (res as unknown as { statusCode: number }).statusCode;
			}
		},
	};
	return {
		res: res as unknown as import("node:http").ServerResponse,
		captured,
	};
}

async function newProfileId(): Promise<string> {
	const rec = await store.createProfile({
		centroid: unit([0, 1, 0, 0]),
		embeddingModel: MODEL,
		confidence: 0.5,
		durationMs: 1500,
	});
	return rec.profileId;
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "speaker-profile-routes-"));
	store = new VoiceProfileStore({ rootDir: tmpRoot });
	await store.init();
	setVoiceSpeakerProfileStore(store);
});

afterEach(() => {
	setVoiceSpeakerProfileStore(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("handleVoiceSpeakerProfileRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const { res } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({ method: "GET", url: "/api/local-inference/catalog" }),
			res,
		);
		expect(handled).toBe(false);
	});

	it("lists speaker profiles", async () => {
		await newProfileId();
		const { res, captured } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({ method: "GET", url: "/v1/voice/speaker-profiles" }),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body) as {
			profiles: Array<{ entityId: string | null }>;
		};
		expect(json.profiles).toHaveLength(1);
		expect(json.profiles[0]?.entityId).toBeNull();
	});

	it("binds a profile to an entity and persists it to the store", async () => {
		const profileId = await newProfileId();
		const { res, captured } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: `/v1/voice/speaker-profiles/${profileId}/bind`,
				body: JSON.stringify({ entityId: "ent_jill", label: "wife" }),
			}),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body) as {
			entityId: string | null;
			label: string | null;
		};
		expect(json.entityId).toBe("ent_jill");
		expect(json.label).toBe("wife");

		// The binding must survive on disk so attribution resolves it later.
		const persisted = await store.get(profileId);
		expect(persisted?.entityId).toBe("ent_jill");
	});

	it("unbinds a previously bound profile", async () => {
		const profileId = await newProfileId();
		await store.bindEntity({ profileId, entityId: "ent_jill" });

		const { res, captured } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: `/v1/voice/speaker-profiles/${profileId}/unbind`,
			}),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(200);
		const json = JSON.parse(captured.body) as { entityId: string | null };
		expect(json.entityId).toBeNull();
		expect((await store.get(profileId))?.entityId).toBeNull();
	});

	it("rejects a bind with no entityId", async () => {
		const profileId = await newProfileId();
		const { res, captured } = makeRes();
		await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: `/v1/voice/speaker-profiles/${profileId}/bind`,
				body: JSON.stringify({ label: "wife" }),
			}),
			res,
		);
		expect(captured.statusCode).toBe(400);
		expect(captured.body).toContain("entityId is required");
	});

	it("returns 404 when binding a non-existent profile", async () => {
		const { res, captured } = makeRes();
		await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: "/v1/voice/speaker-profiles/vp_missing/bind",
				body: JSON.stringify({ entityId: "ent_jill" }),
			}),
			res,
		);
		expect(captured.statusCode).toBe(404);
	});
});
