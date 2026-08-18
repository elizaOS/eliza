/** Exercises owner-profile deletion flag validation through the route harness. */
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

function request(method: string, pathname: string): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = method;
	req.url = pathname;
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

async function call(method: string, pathname: string) {
	const out = response();
	const handled = await handleVoiceProfilesManagementRoutes(
		request(method, pathname),
		out.res,
	);
	expect(handled).toBe(true);
	return { status: out.res.statusCode, body: out.body() };
}

beforeEach(async () => {
	previousOwnerEntityId = process.env.ELIZA_ADMIN_ENTITY_ID;
	process.env.ELIZA_ADMIN_ENTITY_ID = OWNER_ENTITY_ID;
	rootDir = mkdtempSync(path.join(tmpdir(), "voice-profile-include-owner-"));
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

describe("DELETE /api/voice/profiles includeOwner identity", () => {
	it.each(["/api/voice/profiles", "/api/voice/profiles?includeOwner="])(
		"accepts %s as spare-the-OWNER mass delete",
		async (pathname) => {
			const result = await call("DELETE", pathname);
			expect(result.status).toBe(200);
			expect(result.body).toEqual({ deleted: 1 });
			expect(await store.get(owner.profileId)).not.toBeNull();
			expect(await store.get(guest.profileId)).toBeNull();
		},
	);

	it("accepts includeOwner=false as spare-the-OWNER mass delete", async () => {
		const result = await call(
			"DELETE",
			"/api/voice/profiles?includeOwner=false",
		);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ deleted: 1 });
		expect(await store.get(owner.profileId)).not.toBeNull();
		expect(await store.get(guest.profileId)).toBeNull();
	});

	it("accepts includeOwner=true as delete-including-OWNER", async () => {
		const result = await call(
			"DELETE",
			"/api/voice/profiles?includeOwner=true",
		);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ deleted: 2 });
		expect(await store.get(owner.profileId)).toBeNull();
		expect(await store.get(guest.profileId)).toBeNull();
	});

	it.each(["TRUE", "1", "yes", "foo", "1e2"])(
		"rejects includeOwner=%s before mass delete",
		async (token) => {
			const result = await call(
				"DELETE",
				`/api/voice/profiles?includeOwner=${encodeURIComponent(token)}`,
			);
			expect(result.status).toBe(400);
			expect(result.body).toMatchObject({
				error:
					'includeOwner must be specified at most once as "true" or "false".',
			});
			expect(await store.get(owner.profileId)).not.toBeNull();
			expect(await store.get(guest.profileId)).not.toBeNull();
		},
	);

	it.each([
		"/api/voice/profiles?includeOwner=true&includeOwner=true",
		"/api/voice/profiles?includeOwner=true&includeOwner=false",
		"/api/voice/profiles?includeOwner=&includeOwner=true",
		"/api/voice/profiles?includeOwner=foo&includeOwner=true",
	])(
		"rejects duplicate includeOwner values in %s before mass delete",
		async (pathname) => {
			const result = await call("DELETE", pathname);
			expect(result.status).toBe(400);
			expect(await store.get(owner.profileId)).not.toBeNull();
			expect(await store.get(guest.profileId)).not.toBeNull();
		},
	);
});
