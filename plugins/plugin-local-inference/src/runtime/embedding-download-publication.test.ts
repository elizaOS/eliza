/** Real filesystem publication checks with controlled streams and loopback HTTP. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import {
	createServer,
	get as httpGet,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
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

it("does not let a superseded redirect response cancel the active download", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "embedding-redirect-"),
	);
	directories.push(directory);
	const target = path.join(directory, "model.gguf");
	const redirect = Object.assign(new PassThrough(), {
		statusCode: 302,
		headers: { location: "https://huggingface.co/owner/model/final.gguf" },
	});
	const active = Object.assign(new PassThrough(), {
		statusCode: 200,
		headers: { "content-length": "8" },
	});
	let requests = 0;
	vi.spyOn(https, "get").mockImplementation(((...args: unknown[]) => {
		const callback = args.at(-1) as (response: IncomingMessage) => void;
		const response = requests++ === 0 ? redirect : active;
		queueMicrotask(() => {
			callback(response as unknown as IncomingMessage);
			if (response === active) active.write("half");
		});
		return new EventEmitter();
	}) as typeof https.get);
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
	const outcome = pending.then(
		(value) => ({ value }),
		(error: Error) => ({ error }),
	);
	await progress;
	const redirectErrors: Error[] = [];
	redirect.on("error", (error) => redirectErrors.push(error));
	const closed = new Promise<void>((resolve) =>
		redirect.once("close", resolve),
	);
	const failure = new Error("superseded redirect response failed");
	redirect.destroy(failure);
	await closed;
	active.end("done");
	expect(await outcome).toEqual({ value: target });
	expect(redirectErrors).toEqual([failure]);
	expect(requests).toBe(2);
	expect(fs.readFileSync(target, "utf8")).toBe("halfdone");
	expect(fs.readdirSync(directory)).toEqual(["model.gguf"]);
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

it("rejects a failed response stream and preserves the previous model", async () => {
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
	const observed = pending.then(
		() => "resolved",
		(error: Error) => error,
	);
	// Observe the transport error independently so the negative control reports
	// the unresolved download contract rather than an uncaught EventEmitter error.
	const transportErrors: Error[] = [];
	stream.on("error", (error) => transportErrors.push(error));
	const closed = new Promise<void>((resolve) => stream.once("close", resolve));
	await progress;
	const failure = new Error("embedding response connection reset");
	stream.destroy(failure);
	await closed;
	expect(transportErrors).toEqual([failure]);
	expect(await observed).toBe(failure);
	expect(fs.readFileSync(target, "utf8")).toBe("previous-complete-model");
	expect(fs.readdirSync(directory)).toEqual(["model.gguf"]);
});

it("rejects an interrupted HTTP response without publishing partial model bytes", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-http-"));
	directories.push(directory);
	const target = path.join(directory, "model.gguf");
	fs.writeFileSync(target, "previous-complete-model");
	const response: { current?: ServerResponse } = {};
	const server = createServer((_request, current) => {
		response.current = current;
		current.writeHead(200, { "content-length": "8" });
		current.write("half");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("HTTP fixture did not bind");
		vi.spyOn(https, "get").mockImplementation(((...args: unknown[]) => {
			const callback = args.at(-1) as (response: IncomingMessage) => void;
			return httpGet(`http://127.0.0.1:${address.port}/model.gguf`, callback);
		}) as typeof https.get);
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
		const rejected = expect(pending).rejects.toMatchObject({
			code: "ECONNRESET",
		});
		await progress;
		expect(fs.readFileSync(target, "utf8")).toBe("previous-complete-model");
		if (!response.current)
			throw new Error("HTTP fixture did not receive the request");
		response.current.destroy();
		await rejected;
		expect(fs.readFileSync(target, "utf8")).toBe("previous-complete-model");
		expect(fs.readdirSync(directory)).toEqual(["model.gguf"]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
