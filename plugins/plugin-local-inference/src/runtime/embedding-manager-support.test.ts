import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureModel } from "./embedding-manager-support";

const tempDirs: string[] = [];

function tempModelsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-embedding-model-"));
	tempDirs.push(dir);
	return dir;
}

function stubDownload(response: PassThrough): void {
	const request = new EventEmitter();
	vi.spyOn(https, "get").mockImplementation(((_url, _options, callback) => {
		queueMicrotask(() => callback(response));
		return request;
	}) as typeof https.get);
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("ensureModel atomic download", () => {
	it("keeps an in-progress GGUF out of the installed model path", async () => {
		const modelsDir = tempModelsDir();
		const modelPath = path.join(modelsDir, "model.gguf");
		const partialPath = `${modelPath}.part`;
		const response = new PassThrough() as PassThrough & {
			statusCode: number;
			headers: Record<string, string>;
		};
		response.statusCode = 200;
		response.headers = { "content-length": "6" };
		stubDownload(response);

		const download = ensureModel(modelsDir, "owner/repo", "model.gguf");
		await vi.waitFor(() => expect(fs.existsSync(partialPath)).toBe(true));
		response.write("abc");

		expect(fs.existsSync(modelPath)).toBe(false);
		response.end("def");
		await expect(download).resolves.toBe(modelPath);
		expect(fs.readFileSync(modelPath, "utf8")).toBe("abcdef");
		expect(fs.existsSync(partialPath)).toBe(false);
	});

	it("removes an incomplete partial and never publishes it", async () => {
		const modelsDir = tempModelsDir();
		const modelPath = path.join(modelsDir, "model.gguf");
		const partialPath = `${modelPath}.part`;
		const response = new PassThrough() as PassThrough & {
			statusCode: number;
			headers: Record<string, string>;
		};
		response.statusCode = 200;
		response.headers = { "content-length": "6" };
		stubDownload(response);

		const download = ensureModel(modelsDir, "owner/repo", "model.gguf");
		await vi.waitFor(() => expect(fs.existsSync(partialPath)).toBe(true));
		response.end("abc");

		await expect(download).rejects.toThrow("does not match Content-Length");
		expect(fs.existsSync(modelPath)).toBe(false);
		expect(fs.existsSync(partialPath)).toBe(false);
	});
});
