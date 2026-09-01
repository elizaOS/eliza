/**
 * HTTP boundary coverage for voice-profile lifecycle management using a real
 * temporary VoiceProfileStore and synthetic enrollment samples.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type VoiceProfileAudioRef,
	type VoiceProfileRecord,
	VoiceProfileStore,
} from "../services/voice/profile-store";
import {
	handleVoiceProfilesManagementRoutes,
	setVoiceProfilesManagementStore,
} from "./voice-profiles-management-routes";

const OWNER_ENTITY_ID = "entity-owner";
const REQUEST_BODY = Symbol.for("eliza.http.cachedRequestBody");
const JSON_BODY = Symbol.for("eliza.http.cachedJsonBody");

let rootDir: string;
let store: VoiceProfileStore;
let owner: VoiceProfileRecord;
let guest: VoiceProfileRecord;
let previousOwnerEntityId: string | undefined;

function unit(values: number[]): Float32Array {
	const magnitude = Math.sqrt(
		values.reduce((sum, value) => sum + value ** 2, 0),
	);
	return new Float32Array(values.map((value) => value / magnitude));
}

function sample(id: string): VoiceProfileAudioRef {
	return {
		sampleId: id,
		wavSha256: `sha-${id}`,
		durationMs: 1000,
		recordedAt: "2026-08-01T00:00:00.000Z",
	};
}

function request(
	method: string,
	pathname: string,
	body?: Record<string, unknown>,
): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = method;
	req.url = pathname;
	if (body !== undefined) {
		const cached = req as http.IncomingMessage & {
			[REQUEST_BODY]?: string;
			[JSON_BODY]?: unknown;
		};
		cached[REQUEST_BODY] = JSON.stringify(body);
		cached[JSON_BODY] = body;
	}
	return req;
}

function response(): {
	res: http.ServerResponse;
	body: () => Record<string, unknown>;
} {
	let raw = "";
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	res.setHeader = () => res;
	res.end = ((chunk?: string | Buffer) => {
		if (typeof chunk === "string") raw += chunk;
		else if (chunk) raw += chunk.toString("utf8");
		return res;
	}) as typeof res.end;
	return {
		res,
		body: () => JSON.parse(raw) as Record<string, unknown>,
	};
}

async function call(
	method: string,
	pathname: string,
	body?: Record<string, unknown>,
) {
	const out = response();
	const handled = await handleVoiceProfilesManagementRoutes(
		request(method, pathname, body),
		out.res,
	);
	expect(handled).toBe(true);
	return { status: out.res.statusCode, body: out.body() };
}

beforeEach(async () => {
	previousOwnerEntityId = process.env.ELIZA_ADMIN_ENTITY_ID;
	process.env.ELIZA_ADMIN_ENTITY_ID = OWNER_ENTITY_ID;
	rootDir = mkdtempSync(path.join(tmpdir(), "voice-profile-routes-"));
	store = new VoiceProfileStore({ rootDir });
	await store.init();
	owner = await store.createProfile({
		centroid: unit([1, 0, 0, 0]),
		embeddingModel: "test-speaker-model",
		confidence: 0.9,
		durationMs: 1000,
		audioRef: sample("owner-a"),
		entityId: OWNER_ENTITY_ID,
		metadata: { displayName: "Owner", cohort: "owner" },
	});
	guest = await store.createProfile({
		centroid: unit([0, 1, 0, 0]),
		embeddingModel: "test-speaker-model",
		confidence: 0.8,
		durationMs: 1000,
		audioRef: sample("guest-a"),
		metadata: { displayName: "Guest" },
	});
	await store.refine({
		profileId: guest.profileId,
		embedding: unit([0, 1, 0, 0]),
		durationMs: 1000,
		confidence: 0.8,
		audioRef: sample("guest-b"),
	});
	setVoiceProfilesManagementStore(store);
});

afterEach(() => {
	setVoiceProfilesManagementStore(null);
	if (previousOwnerEntityId === undefined) {
		delete process.env.ELIZA_ADMIN_ENTITY_ID;
	} else {
		process.env.ELIZA_ADMIN_ENTITY_ID = previousOwnerEntityId;
	}
	rmSync(rootDir, { recursive: true, force: true });
});

describe("voice profile management routes", () => {
	it("lists retained split samples without exposing audio hashes", async () => {
		const result = await call("GET", "/api/voice/profiles");
		expect(result.status).toBe(200);
		const profiles = result.body.profiles as Array<Record<string, unknown>>;
		const listedGuest = profiles.find(
			(profile) => profile.id === guest.profileId,
		);
		expect(listedGuest?.samples).toEqual([
			{
				id: "guest-a",
				durationMs: 1000,
				recordedAt: "2026-08-01T00:00:00.000Z",
			},
			{
				id: "guest-b",
				durationMs: 1000,
				recordedAt: "2026-08-01T00:00:00.000Z",
			},
		]);
		expect(JSON.stringify(listedGuest)).not.toContain("wavSha256");
	});

	it("binds and unbinds a non-owner profile", async () => {
		const bound = await call(
			"POST",
			`/api/voice/profiles/${guest.profileId}/bind`,
			{ entityId: "entity-guest", label: "Alex" },
		);
		expect(bound.status).toBe(200);
		expect(bound.body).toMatchObject({
			id: guest.profileId,
			entityId: "entity-guest",
			displayName: "Guest",
		});

		const unbound = await call(
			"POST",
			`/api/voice/profiles/${guest.profileId}/unbind`,
		);
		expect(unbound.status).toBe(200);
		expect(unbound.body.entityId).toBeNull();
	});

	it("refuses to merge away, rebind, or unbind the owner profile", async () => {
		const merge = await call(
			"POST",
			`/api/voice/profiles/${owner.profileId}/merge`,
			{ intoId: guest.profileId },
		);
		expect(merge).toMatchObject({
			status: 409,
			body: { error: "the OWNER profile cannot be merged away" },
		});

		const bind = await call(
			"POST",
			`/api/voice/profiles/${owner.profileId}/bind`,
			{ entityId: "attacker" },
		);
		expect(bind).toMatchObject({
			status: 409,
			body: { error: "the OWNER profile cannot be rebound" },
		});

		const unbind = await call(
			"POST",
			`/api/voice/profiles/${owner.profileId}/unbind`,
		);
		expect(unbind).toMatchObject({
			status: 409,
			body: { error: "the OWNER profile cannot be unbound" },
		});
		expect((await store.get(owner.profileId))?.entityId).toBe(OWNER_ENTITY_ID);
	});

	it("splits a proper subset and refuses an all-sample split", async () => {
		const rejected = await call(
			"POST",
			`/api/voice/profiles/${guest.profileId}/split`,
			{ utteranceIds: ["guest-a", "guest-b"] },
		);
		expect(rejected).toMatchObject({
			status: 400,
			body: { error: "a split must leave at least one sample in the profile" },
		});

		const accepted = await call(
			"POST",
			`/api/voice/profiles/${guest.profileId}/split`,
			{ utteranceIds: ["guest-b"] },
		);
		expect(accepted.status).toBe(200);
		expect(accepted.body).toMatchObject({
			original: { id: guest.profileId, samples: [{ id: "guest-a" }] },
			split: { entityId: null, samples: [{ id: "guest-b" }] },
		});
	});
});
