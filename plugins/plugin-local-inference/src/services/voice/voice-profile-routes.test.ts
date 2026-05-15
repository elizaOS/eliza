/**
 * Unit tests for voice-profile-routes.ts.
 *
 * Covers:
 *  - GET /v1/voice/profiles — list from bundle scan + catalog
 *  - POST /v1/voice/profiles/:id/activate — set default
 *  - DELETE /v1/voice/profiles/:id — soft-delete
 *  - resolveDefaultProfileId — reads catalog default
 *  - registerProfileInCatalog — upsert into catalog
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleVoiceProfileRoutes,
	registerProfileInCatalog,
	resolveDefaultProfileId,
	type VoiceProfileCatalog,
	type VoiceProfileRouteOptions,
} from "./voice-profile-routes";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-profile-routes-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fake ELZ2 v2 preset file (64-byte header + empty sections). */
function writeEmptyPreset(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const buf = Buffer.alloc(64, 0);
	// magic 'ELZ1'
	buf.writeUInt32LE(0x315a4c45, 0);
	// version 2
	buf.writeUInt32LE(2, 4);
	// all section offsets/lengths = 0
	fs.writeFileSync(filePath, buf);
}

function makeReq(method: string, url: string): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = method;
	req.url = url;
	req.headers = { host: "127.0.0.1:31337" };
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	return req;
}

function makeRes(): {
	res: http.ServerResponse;
	status: () => number;
	body: () => string;
} {
	const fakeReq = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(fakeReq);
	let statusCode = 200;
	let chunks = Buffer.alloc(0);
	res.writeHead = ((code: number) => {
		statusCode = code;
		res.statusCode = code;
		return res;
	}) as typeof res.writeHead;
	res.end = ((chunk?: string | Buffer | Uint8Array) => {
		if (chunk) {
			chunks = Buffer.concat([chunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		}
		return res;
	}) as typeof res.end;
	return {
		res,
		status: () => statusCode,
		body: () => chunks.toString("utf8"),
	};
}

// ---------------------------------------------------------------------------
// GET /v1/voice/profiles
// ---------------------------------------------------------------------------

describe("GET /v1/voice/profiles", () => {
	it("returns empty profiles list when bundle dir and catalog are absent", async () => {
		const opts: VoiceProfileRouteOptions = {
			voiceModelsDir: path.join(tmpDir, "models", "voice"),
		};
		const req = makeReq("GET", "/v1/voice/profiles");
		const { res, status, body } = makeRes();
		const handled = await handleVoiceProfileRoutes(req, res, opts);
		expect(handled).toBe(true);
		expect(status()).toBe(200);
		const json = JSON.parse(body());
		expect(json).toHaveProperty("profiles");
		expect(Array.isArray(json.profiles)).toBe(true);
		expect(json.profiles).toHaveLength(0);
	});

	it("lists bundle-scanned profiles", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-samantha.bin"));
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-alloy.bin"));

		const opts: VoiceProfileRouteOptions = {
			voiceModelsDir: path.join(tmpDir, "models", "voice"),
			bundleRoot,
		};
		const req = makeReq("GET", "/v1/voice/profiles");
		const { res, status, body } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);

		expect(status()).toBe(200);
		const json = JSON.parse(body());
		const ids = json.profiles.map((p: { id: string }) => p.id).sort();
		expect(ids).toContain("samantha");
		expect(ids).toContain("alloy");
	});

	it("marks catalog default correctly", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-samantha.bin"));

		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "samantha",
			profiles: [],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const opts: VoiceProfileRouteOptions = { voiceModelsDir, bundleRoot };
		const req = makeReq("GET", "/v1/voice/profiles");
		const { res, body } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);

		const json = JSON.parse(body());
		const samantha = json.profiles.find((p: { id: string }) => p.id === "samantha");
		expect(samantha?.isDefault).toBe(true);
		expect(json.defaultProfileId).toBe("samantha");
	});

	it("returns false for unrelated routes", async () => {
		const req = makeReq("GET", "/v1/models");
		const { res } = makeRes();
		const handled = await handleVoiceProfileRoutes(req, res, {});
		expect(handled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// POST /v1/voice/profiles/:id/activate
// ---------------------------------------------------------------------------

describe("POST /v1/voice/profiles/:id/activate", () => {
	it("sets the default profile in catalog", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-samantha.bin"));
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-alloy.bin"));

		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "samantha",
			profiles: [],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const opts: VoiceProfileRouteOptions = { voiceModelsDir, bundleRoot };
		const req = makeReq("POST", "/v1/voice/profiles/alloy/activate");
		const { res, status, body } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);

		expect(status()).toBe(200);
		const json = JSON.parse(body());
		expect(json.defaultProfileId).toBe("alloy");
		expect(json.previousDefaultProfileId).toBe("samantha");

		// Verify catalog was written.
		const written = JSON.parse(
			fs.readFileSync(path.join(voiceModelsDir, "profiles", "catalog.json"), "utf8"),
		) as VoiceProfileCatalog;
		expect(written.defaultProfileId).toBe("alloy");
	});

	it("returns 404 for a profile that does not exist", async () => {
		const opts: VoiceProfileRouteOptions = {
			voiceModelsDir: path.join(tmpDir, "models", "voice"),
		};
		const req = makeReq("POST", "/v1/voice/profiles/ghost/activate");
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);
		expect(status()).toBe(404);
	});

	it("returns 409 for a soft-deleted (inactive) profile", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-nova.bin"));

		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "samantha",
			profiles: [
				{
					id: "nova",
					displayName: "Nova",
					instruct: "",
					active: false,
					createdAt: new Date().toISOString(),
				},
			],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const opts: VoiceProfileRouteOptions = { voiceModelsDir, bundleRoot };
		const req = makeReq("POST", "/v1/voice/profiles/nova/activate");
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);
		expect(status()).toBe(409);
	});

	it("returns 400 for invalid profile ids", async () => {
		const opts: VoiceProfileRouteOptions = {
			voiceModelsDir: path.join(tmpDir, "models", "voice"),
		};
		const req = makeReq("POST", "/v1/voice/profiles/../../../etc/activate");
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);
		// Path traversal attempt is rejected.
		expect(status()).toBeGreaterThanOrEqual(400);
	});
});

// ---------------------------------------------------------------------------
// DELETE /v1/voice/profiles/:id
// ---------------------------------------------------------------------------

describe("DELETE /v1/voice/profiles/:id", () => {
	it("soft-deletes a profile (marks inactive in catalog, does not unlink file)", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		const presetPath = path.join(bundleRoot, "cache", "voice-preset-alloy.bin");
		writeEmptyPreset(presetPath);

		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "samantha",
			profiles: [
				{
					id: "alloy",
					displayName: "Alloy",
					instruct: "",
					active: true,
					createdAt: new Date().toISOString(),
				},
			],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const opts: VoiceProfileRouteOptions = { voiceModelsDir, bundleRoot };
		const req = makeReq("DELETE", "/v1/voice/profiles/alloy");
		const { res, status, body } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);

		expect(status()).toBe(200);
		const json = JSON.parse(body());
		expect(json.deleted).toBe("alloy");
		expect(json.active).toBe(false);

		// Preset file must still exist (soft-delete only).
		expect(fs.existsSync(presetPath)).toBe(true);

		// Catalog must have active=false.
		const written = JSON.parse(
			fs.readFileSync(path.join(voiceModelsDir, "profiles", "catalog.json"), "utf8"),
		) as VoiceProfileCatalog;
		const entry = written.profiles.find((p) => p.id === "alloy");
		expect(entry?.active).toBe(false);
	});

	it("refuses to delete the active default profile", async () => {
		const bundleRoot = path.join(tmpDir, "bundle");
		writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-samantha.bin"));

		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "samantha",
			profiles: [],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);

		const opts: VoiceProfileRouteOptions = { voiceModelsDir, bundleRoot };
		const req = makeReq("DELETE", "/v1/voice/profiles/samantha");
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);
		expect(status()).toBe(409);
	});

	it("returns 404 for a profile that does not exist anywhere", async () => {
		const opts: VoiceProfileRouteOptions = {
			voiceModelsDir: path.join(tmpDir, "models", "voice"),
		};
		const req = makeReq("DELETE", "/v1/voice/profiles/ghost");
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(req, res, opts);
		expect(status()).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// resolveDefaultProfileId
// ---------------------------------------------------------------------------

describe("resolveDefaultProfileId", () => {
	it("returns 'samantha' when no catalog exists", async () => {
		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		const id = await resolveDefaultProfileId(voiceModelsDir);
		expect(id).toBe("samantha");
	});

	it("returns the catalog's defaultProfileId", async () => {
		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
		const catalog: VoiceProfileCatalog = {
			version: 1,
			defaultProfileId: "alloy",
			profiles: [],
		};
		fs.writeFileSync(
			path.join(voiceModelsDir, "profiles", "catalog.json"),
			JSON.stringify(catalog),
		);
		const id = await resolveDefaultProfileId(voiceModelsDir);
		expect(id).toBe("alloy");
	});
});

// ---------------------------------------------------------------------------
// registerProfileInCatalog
// ---------------------------------------------------------------------------

describe("registerProfileInCatalog", () => {
	it("adds a new entry to the catalog", async () => {
		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		await registerProfileInCatalog(voiceModelsDir, {
			id: "nova",
			displayName: "Nova",
			instruct: "female, soft, modern",
			createdAt: new Date().toISOString(),
		});
		const catalog = JSON.parse(
			fs.readFileSync(path.join(voiceModelsDir, "profiles", "catalog.json"), "utf8"),
		) as VoiceProfileCatalog;
		expect(catalog.profiles).toHaveLength(1);
		expect(catalog.profiles[0]?.id).toBe("nova");
		expect(catalog.profiles[0]?.active).toBe(true);
	});

	it("updates an existing entry without duplicating it", async () => {
		const voiceModelsDir = path.join(tmpDir, "models", "voice");
		const now = new Date().toISOString();
		await registerProfileInCatalog(voiceModelsDir, {
			id: "nova",
			displayName: "Nova",
			instruct: "v1",
			createdAt: now,
		});
		await registerProfileInCatalog(voiceModelsDir, {
			id: "nova",
			displayName: "Nova Updated",
			instruct: "v2",
			createdAt: now,
		});
		const catalog = JSON.parse(
			fs.readFileSync(path.join(voiceModelsDir, "profiles", "catalog.json"), "utf8"),
		) as VoiceProfileCatalog;
		expect(catalog.profiles).toHaveLength(1);
		expect(catalog.profiles[0]?.instruct).toBe("v2");
		expect(catalog.profiles[0]?.displayName).toBe("Nova Updated");
	});
});
