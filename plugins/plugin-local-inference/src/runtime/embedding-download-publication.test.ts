/** Real filesystem publication checks with a controlled network stream. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ensureModel } from "./embedding-manager-support";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});
function controlledDownload() {
	const stream = new PassThrough();
	const response = Object.assign(stream, {
		statusCode: 200,
		headers: { "content-length": "8" },
	});
	vi.spyOn(https, "get").mockImplementation(((...args: unknown[]) => {
		const callback = args.at(-1) as (response: IncomingMessage) => void;
		queueMicrotask(() => {
			callback(response as unknown as IncomingMessage);
			stream.write("half");
		});
		return new EventEmitter();
	}) as typeof https.get);
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "embedding-publish-"),
	);
	directories.push(directory);
	return { stream, directory, target: path.join(directory, "model.gguf") };
}
it("keeps the final filename absent until all bytes are downloaded", async () => {
	const { stream, directory, target } = controlledDownload();
	let halfway!: () => void;
	const progress = new Promise<void>((resolve) => {
		halfway = resolve;
	});
	const pending = ensureModel(
		directory,
		"owner/model",
		"model.gguf",
		false,
		(phase, text) => {
			if (phase === "downloading" && text?.includes("50%")) halfway();
		},
	);
	await progress;
	expect(fs.existsSync(target)).toBe(false);
	stream.end("done");
	await expect(pending).resolves.toBe(target);
	expect(fs.readFileSync(target, "utf8")).toBe("halfdone");
	expect(fs.readdirSync(directory)).toEqual(["model.gguf"]);
});
it("preserves the existing model when a forced replacement is incomplete", async () => {
	const { stream, directory, target } = controlledDownload();
	fs.writeFileSync(target, "previous-complete-model");
	let halfway!: () => void;
	const progress = new Promise<void>((resolve) => {
		halfway = resolve;
	});
	const pending = ensureModel(
		directory,
		"owner/model",
		"model.gguf",
		true,
		(phase, text) => {
			if (phase === "downloading" && text?.includes("50%")) halfway();
		},
	);
	const rejected = expect(pending).rejects.toThrow(
		"does not match Content-Length",
	);
	await progress;
	expect(fs.readFileSync(target, "utf8")).toBe("previous-complete-model");
	stream.end();
	await rejected;
	expect(fs.readFileSync(target, "utf8")).toBe("previous-complete-model");
	expect(fs.readdirSync(directory)).toEqual(["model.gguf"]);
});
