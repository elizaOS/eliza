/** Exercises malformed OmniVoice preset identifiers before catalog mutation. */
import * as fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	resolveStateDir: () => "/tmp",
}));

const { handleVoiceProfileRoutes }: typeof import("./voice-profile-routes") =
	await import("./voice-profile-routes");
type VoiceProfileCatalog = import("./voice-profile-routes").VoiceProfileCatalog;
type VoiceProfileRouteOptions =
	import("./voice-profile-routes").VoiceProfileRouteOptions;

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "voice-profile-routes-encoding-"),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEmptyPreset(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const buf = Buffer.alloc(64, 0);
	buf.writeUInt32LE(0x315a4c45, 0);
	buf.writeUInt32LE(2, 4);
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
			chunks = Buffer.concat([
				chunks,
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
			]);
		}
		return res;
	}) as typeof res.end;
	return {
		res,
		status: () => statusCode,
		body: () => chunks.toString("utf8"),
	};
}

function catalogOpts(): VoiceProfileRouteOptions {
	const bundleRoot = path.join(tmpDir, "bundle");
	writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-alloy.bin"));
	const voiceModelsDir = path.join(tmpDir, "models", "voice");
	fs.mkdirSync(path.join(voiceModelsDir, "profiles"), { recursive: true });
	const catalog: VoiceProfileCatalog = {
		version: 1,
		defaultProfileId: "same",
		profiles: [],
	};
	fs.writeFileSync(
		path.join(voiceModelsDir, "profiles", "catalog.json"),
		JSON.stringify(catalog),
	);
	return { voiceModelsDir, bundleRoot };
}

describe("POST /v1/voice/profiles/:id/activate encoding", () => {
	it("canonical activate still 404s as not found", async () => {
		const opts = catalogOpts();
		const { res, status, body } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("POST", "/v1/voice/profiles/ghost/activate"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(status()).toBe(404);
		expect(JSON.parse(body())).toEqual({ error: "Profile 'ghost' not found" });
	});

	it("canonical percent-encoded letter still decodes before the 404", async () => {
		const opts = catalogOpts();
		const { res, status } = makeRes();
		await handleVoiceProfileRoutes(
			makeReq("POST", "/v1/voice/profiles/gh%6Fst/activate"),
			res,
			opts,
		);
		expect(status()).toBe(404);
	});

	it("GET voice-profiles list is untouched", async () => {
		const opts = catalogOpts();
		const { res, status, body } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("GET", "/v1/voice/profiles"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(status()).toBe(200);
		const json = JSON.parse(body());
		expect(json).toHaveProperty("profiles");
		expect(Array.isArray(json.profiles)).toBe(true);
	});

	it.each(["%", "%2", "%ZZ", "%E0%A4"])(
		"rejects malformed activate id %s with 400",
		async (token) => {
			const opts = catalogOpts();
			const { res, status, body } = makeRes();
			const handled = await handleVoiceProfileRoutes(
				makeReq("POST", `/v1/voice/profiles/${token}/activate`),
				res,
				opts,
			);
			expect(handled).toBe(true);
			expect(status()).toBe(400);
			expect(JSON.parse(body())).toEqual({
				error: "Invalid profile id: malformed URL encoding",
			});
		},
	);
});

describe("DELETE /v1/voice/profiles/:id encoding", () => {
	it("canonical delete still 404s as not found", async () => {
		const opts = catalogOpts();
		const { res, status } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("DELETE", "/v1/voice/profiles/ghost"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(status()).toBe(404);
	});

	it.each(["%", "%2", "%ZZ"])(
		"rejects malformed delete id %s with 400",
		async (token) => {
			const opts = catalogOpts();
			const { res, status, body } = makeRes();
			const handled = await handleVoiceProfileRoutes(
				makeReq("DELETE", `/v1/voice/profiles/${token}`),
				res,
				opts,
			);
			expect(handled).toBe(true);
			expect(status()).toBe(400);
			expect(JSON.parse(body())).toEqual({
				error: "Invalid profile id: malformed URL encoding",
			});
		},
	);
});
