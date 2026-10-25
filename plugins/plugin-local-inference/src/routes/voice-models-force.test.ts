/** Exercises voice-model refresh flag validation through the route harness. */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	VoiceModelStatus,
	VoiceModelUpdater,
} from "../services/voice-model-updater";
import {
	handleVoiceModelsRoutes,
	setVoiceModelsBundleVersionForTest,
	setVoiceModelsUpdater,
} from "./voice-models-routes";

let tmpRoot: string;
let prevStateDir: string | undefined;

function makeReq(url: string): http.IncomingMessage {
	const emitter = new EventEmitter();
	(emitter as unknown as { method: string }).method = "GET";
	(emitter as unknown as { url: string }).url = url;
	(emitter as unknown as { headers: Record<string, string> }).headers = {};
	(emitter as unknown as { socket: unknown }).socket = {
		remoteAddress: "127.0.0.1",
	};
	return emitter as unknown as http.IncomingMessage;
}

interface CapturedResponse {
	statusCode: number;
	body: string;
}

function makeRes(): {
	res: http.ServerResponse;
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
			captured.statusCode = (
				res as unknown as { statusCode: number }
			).statusCode;
		},
	};
	return {
		res: res as unknown as http.ServerResponse,
		captured,
	};
}

async function readJson(captured: CapturedResponse): Promise<unknown> {
	await new Promise((r) => setTimeout(r, 0));
	return JSON.parse(captured.body);
}

class CapturingUpdater {
	readonly calls: Array<{ force?: boolean }> = [];
	async check(
		_install: unknown,
		_pins: unknown,
		options?: { force?: boolean },
	): Promise<ReadonlyArray<VoiceModelStatus>> {
		this.calls.push({ force: options?.force });
		return [];
	}
}

let updater: CapturingUpdater;

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-models-force-"));
	prevStateDir = process.env.ELIZA_STATE_DIR;
	process.env.ELIZA_STATE_DIR = tmpRoot;
	setVoiceModelsBundleVersionForTest("1.0.0");
	updater = new CapturingUpdater();
	setVoiceModelsUpdater(updater as unknown as VoiceModelUpdater);
});

afterEach(() => {
	setVoiceModelsUpdater(null);
	setVoiceModelsBundleVersionForTest(null);
	if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
	else process.env.ELIZA_STATE_DIR = prevStateDir;
	rmSync(tmpRoot, { recursive: true, force: true });
});

async function call(pathname: string) {
	const { res, captured } = makeRes();
	const handled = await handleVoiceModelsRoutes(makeReq(pathname), res);
	expect(handled).toBe(true);
	return { status: captured.statusCode, body: await readJson(captured) };
}

describe("GET /api/local-inference/voice-models/check force identity", () => {
	it.each([
		"/api/local-inference/voice-models/check",
		"/api/local-inference/voice-models/check?force=",
	])("accepts %s as a cached updater walk", async (pathname) => {
		const result = await call(pathname);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ statuses: [] });
		expect(updater.calls).toEqual([{ force: false }]);
	});

	it("accepts force=1 as a forced updater walk", async () => {
		const result = await call(
			"/api/local-inference/voice-models/check?force=1",
		);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ statuses: [] });
		expect(updater.calls).toEqual([{ force: true }]);
	});

	it.each(["true", "TRUE", "yes", "foo", "0", "false", "1e2"])(
		"rejects force=%s before updater.check",
		async (token) => {
			const result = await call(
				`/api/local-inference/voice-models/check?force=${encodeURIComponent(token)}`,
			);
			expect(result.status).toBe(400);
			expect(result.body).toMatchObject({
				error: 'force must be specified at most once as "1".',
			});
			expect(updater.calls).toEqual([]);
		},
	);

	it.each([
		"/api/local-inference/voice-models/check?force=1&force=1",
		"/api/local-inference/voice-models/check?force=1&force=0",
		"/api/local-inference/voice-models/check?force=&force=1",
		"/api/local-inference/voice-models/check?force=foo&force=1",
	])(
		"rejects duplicate force values in %s before updater.check",
		async (pathname) => {
			const result = await call(pathname);
			expect(result.status).toBe(400);
			expect(updater.calls).toEqual([]);
		},
	);
});
