/**
 * Exercises the production HTTP-to-file model downloader against real local
 * sockets, streams, timers, and filesystem artifacts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadHttpModel } from "./http-model-download.ts";

const servers: Server[] = [];
const tempDirs: string[] = [];

async function listen(
	handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	return { server, url: `http://127.0.0.1:${address.port}/model.gguf` };
}

function paths(): { stagingPath: string; finalPath: string } {
	const dir = mkdtempSync(path.join(os.tmpdir(), "capacitor-model-download-"));
	tempDirs.push(dir);
	return {
		stagingPath: path.join(dir, "model.gguf.part"),
		finalPath: path.join(dir, "model.gguf"),
	};
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("downloadHttpModel", () => {
	it("allows a progressive transfer to outlive one idle window", async () => {
		const chunks = Array.from({ length: 25 }, (_, index) => `chunk-${index};`);
		const { url } = await listen((_request, response) => {
			let index = 0;
			const interval = setInterval(() => {
				const chunk = chunks[index++];
				if (chunk) response.write(chunk);
				if (index === chunks.length) {
					clearInterval(interval);
					response.end();
				}
			}, 50);
		});
		const target = paths();

		const bytes = await downloadHttpModel({
			url,
			...target,
			label: "slow model",
			idleTimeoutMs: 1_000,
			totalTimeoutMs: 5_000,
		});

		expect(bytes).toBe(Buffer.byteLength(chunks.join("")));
		expect(readFileSync(target.finalPath, "utf8")).toBe(chunks.join(""));
		expect(existsSync(target.stagingPath)).toBe(false);
	});

	it("aborts a request that never returns headers", async () => {
		let requestClosed = false;
		const { url } = await listen((request) => {
			request.once("close", () => {
				requestClosed = true;
			});
		});
		const target = paths();

		await expect(
			downloadHttpModel({
				url,
				...target,
				label: "header stall",
				idleTimeoutMs: 100,
				totalTimeoutMs: 2_000,
			}),
		).rejects.toThrow("header stall made no progress for 100ms");
		await waitFor(() => requestClosed);
		expect(requestClosed).toBe(true);
		expect(existsSync(target.stagingPath)).toBe(false);
		expect(existsSync(target.finalPath)).toBe(false);
	});

	it("cancels a stalled body and removes its partial file", async () => {
		const { url } = await listen((_request, response) => {
			response.write("partial");
		});
		const target = paths();

		await expect(
			downloadHttpModel({
				url,
				...target,
				label: "body stall",
				idleTimeoutMs: 100,
				totalTimeoutMs: 2_000,
			}),
		).rejects.toThrow("body stall made no progress for 100ms");
		expect(existsSync(target.stagingPath)).toBe(false);
		expect(existsSync(target.finalPath)).toBe(false);
	});

	it("removes a partial file when the peer drops the body", async () => {
		const { url } = await listen((_request, response) => {
			response.writeHead(200, { "content-length": "100" });
			response.write("partial");
			setTimeout(() => response.destroy(), 25);
		});
		const target = paths();

		await expect(
			downloadHttpModel({
				url,
				...target,
				label: "dropped model",
				idleTimeoutMs: 500,
				totalTimeoutMs: 2_000,
			}),
		).rejects.toThrow();
		expect(existsSync(target.stagingPath)).toBe(false);
		expect(existsSync(target.finalPath)).toBe(false);
	});

	it("rejects a size mismatch before the atomic rename", async () => {
		const { url } = await listen((_request, response) => response.end("short"));
		const target = paths();

		await expect(
			downloadHttpModel({
				url,
				...target,
				label: "wrong-size model",
				expectedSizeBytes: 10,
				idleTimeoutMs: 500,
				totalTimeoutMs: 2_000,
			}),
		).rejects.toThrow("size 5 != expected 10");
		expect(existsSync(target.stagingPath)).toBe(false);
		expect(existsSync(target.finalPath)).toBe(false);
	});

	it("enforces the absolute backstop even while bytes keep arriving", async () => {
		const { url } = await listen((_request, response) => {
			const interval = setInterval(() => response.write("x"), 25);
			response.once("close", () => clearInterval(interval));
		});
		const target = paths();

		await expect(
			downloadHttpModel({
				url,
				...target,
				label: "endless model",
				idleTimeoutMs: 200,
				totalTimeoutMs: 120,
			}),
		).rejects.toThrow();
		expect(existsSync(target.stagingPath)).toBe(false);
		expect(existsSync(target.finalPath)).toBe(false);
	});
});
