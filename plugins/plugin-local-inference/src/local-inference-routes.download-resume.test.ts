/**
 * Drives the route-level model download through the public management
 * mutation against a real local HTTP origin that ignores Range requests. A
 * stale staging file must be discarded when the origin answers 200 instead of
 * 206, otherwise the full body is appended onto the stale bytes and a corrupt
 * GGUF is registered as installed. Real filesystem under a temp state dir; the
 * only redirections are ELIZA_STATE_DIR and the hub mirror base URL.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MODEL_ID = "eliza-1-2b";
const FULL_BODY = Buffer.concat([
	Buffer.from("GGUF", "ascii"),
	Buffer.from("REAL-MODEL-BODY", "ascii"),
]);
const STALE_PARTIAL = Buffer.concat([
	Buffer.from("GGUF", "ascii"),
	Buffer.from("STALE-PARTIAL", "ascii"),
]);

let stateDir: string;
let server: Server;
let baseUrl: string;
let rangeHeadersSeen: string[];
const previousEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
	previousEnv[key] = process.env[key];
	process.env[key] = value;
}

beforeEach(async () => {
	stateDir = mkdtempSync(path.join(tmpdir(), "local-inference-resume-"));
	rangeHeadersSeen = [];
	server = createServer((request, response) => {
		rangeHeadersSeen.push(String(request.headers.range ?? ""));
		// An origin that ignores Range: always the whole file, always 200.
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(FULL_BODY.length),
		});
		response.end(FULL_BODY);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	baseUrl = `http://127.0.0.1:${address.port}`;
	setEnv("ELIZA_STATE_DIR", stateDir);
	setEnv("ELIZA_HF_BASE_URL", baseUrl);
	setEnv("ELIZA_HF_BASE_URLS", baseUrl);
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(stateDir, { recursive: true, force: true });
});

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("route-level model download resume", () => {
	it("restarts from byte zero when the origin ignores Range and answers 200", async () => {
		const downloadsDir = path.join(stateDir, "local-inference", "downloads");
		const modelsDir = path.join(stateDir, "local-inference", "models");
		mkdirSync(downloadsDir, { recursive: true });
		const partialPath = path.join(downloadsDir, `${MODEL_ID}.part`);
		// A stale staging file from an earlier interrupted download.
		writeFileSync(partialPath, STALE_PARTIAL);

		const { applyLocalInferenceManagementMutation } = await import(
			"./local-inference-routes"
		);
		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		} as never);

		const finalPath = path.join(modelsDir, `${MODEL_ID}.gguf`);
		const startedWaiting = Date.now();
		await waitFor(() => existsSync(finalPath), 20_000);
		// The origin answers immediately; a long wait here would mean the
		// download loop stalled rather than restarted.
		expect(Date.now() - startedWaiting).toBeLessThan(5_000);

		// The resume was attempted (Range sent for the stale partial)...
		expect(rangeHeadersSeen[0]).toBe(`bytes=${STALE_PARTIAL.length}-`);
		// ...and refused: the stored file is exactly the origin body, not the
		// stale bytes with the full body appended.
		const stored = readFileSync(finalPath);
		expect(stored.length).toBe(FULL_BODY.length);
		expect(stored.equals(FULL_BODY)).toBe(true);
	});
});
