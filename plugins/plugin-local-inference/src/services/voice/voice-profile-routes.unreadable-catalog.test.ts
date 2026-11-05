/** Refuses to rewrite a voice profile catalog the route could not read. */
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

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "voice-profile-routes-unreadable-"),
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

const CORRUPT_CATALOG = `{
  "version": 1,
  "defaultProfileId": "same",
  "profiles": [
    {"id": "narrator", "displayName": "Narrator", "instruct": "", "active": true, "createdAt": "2026-01-01T00:00:00.000Z"},
`;

/** Bundle ships `alloy`; the catalog carries a second, hand-made profile. */
function catalogOpts() {
	const bundleRoot = path.join(tmpDir, "bundle");
	writeEmptyPreset(path.join(bundleRoot, "cache", "voice-preset-alloy.bin"));
	const voiceModelsDir = path.join(tmpDir, "models", "voice");
	const profilesDir = path.join(voiceModelsDir, "profiles");
	fs.mkdirSync(profilesDir, { recursive: true });
	const catalogPath = path.join(profilesDir, "catalog.json");
	fs.writeFileSync(catalogPath, CORRUPT_CATALOG);
	return { opts: { voiceModelsDir, bundleRoot }, catalogPath };
}

describe("unreadable voice profile catalog", () => {
	it("activate does not replace a catalog it could not parse", async () => {
		const { opts, catalogPath } = catalogOpts();
		const { res, status } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("POST", "/v1/voice/profiles/alloy/activate"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(fs.readFileSync(catalogPath, "utf8")).toBe(CORRUPT_CATALOG);
		expect(status()).toBe(500);
	});

	it("delete does not replace a catalog it could not parse", async () => {
		const { opts, catalogPath } = catalogOpts();
		const { res, status } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("DELETE", "/v1/voice/profiles/alloy"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(status()).toBe(500);
		expect(fs.readFileSync(catalogPath, "utf8")).toBe(CORRUPT_CATALOG);
	});

	it("GET reports the failure instead of an empty profile list", async () => {
		const { opts } = catalogOpts();
		const { res, status } = makeRes();
		const handled = await handleVoiceProfileRoutes(
			makeReq("GET", "/v1/voice/profiles"),
			res,
			opts,
		);
		expect(handled).toBe(true);
		expect(status()).toBe(500);
	});
});
