import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BionicHostLoader, deriveBundleDir } from "./bionic-host-loader";

/**
 * Real-IPC test: stand up an actual abstract-namespace AF_UNIX server (the same
 * transport ElizaBionicInferenceServer.java binds on the device) and drive the
 * loader against it. No mocks — this exercises the real node:net framing.
 */

function frame(json: string): Buffer {
	const payload = Buffer.from(json, "utf8");
	const out = Buffer.allocUnsafe(4 + payload.length);
	out.writeUInt32BE(payload.length, 0);
	payload.copy(out, 4);
	return out;
}

/** A test host that decodes one request frame and replies with `respond(req)`. */
function startHost(
	name: string,
	respond: (req: Record<string, unknown>) => string,
): net.Server {
	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0);
		let expected = -1;
		sock.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
			if (expected >= 0 && buf.length >= 4 + expected) {
				const req = JSON.parse(buf.subarray(4, 4 + expected).toString("utf8"));
				sock.write(frame(respond(req)));
			}
		});
	});
	server.listen({ path: `\0${name}` });
	return server;
}

let host: net.Server | null = null;
const tempDirs: string[] = [];
afterEach(() => {
	host?.close();
	host = null;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const SOCK = `eliza-bionic-test-${process.pid}`;
const describeLinuxOnly =
	process.platform === "linux" ? describe : describe.skip;

function makeBundleModelPath(manifest: unknown = {}): string {
	const bundleRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "eliza-bionic-bundle-"),
	);
	tempDirs.push(bundleRoot);
	fs.mkdirSync(path.join(bundleRoot, "text"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, "asr"), { recursive: true });
	fs.writeFileSync(path.join(bundleRoot, "asr", "gemma-asr.gguf"), "asr");
	fs.writeFileSync(
		path.join(bundleRoot, "eliza-1.manifest.json"),
		JSON.stringify(manifest),
	);
	return path.join(bundleRoot, "text", "model.gguf");
}

describe("deriveBundleDir", () => {
	it("returns the bundle root for the canonical text directory layout", () => {
		const modelPath = path.join(
			"/data",
			"x",
			"eliza-1",
			"bundle",
			"text",
			"model.gguf",
		);
		expect(deriveBundleDir(modelPath)).toBe(
			path.join("/data", "x", "eliza-1", "bundle"),
		);
	});

	it("stages a hidden bundle view for flat Android Eliza-1 GGUFs", () => {
		const modelsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-bionic-flat-models-"),
		);
		tempDirs.push(modelsDir);
		const modelPath = path.join(modelsDir, "eliza-1-2b-128k.gguf");
		fs.writeFileSync(modelPath, "GGUF");

		const bundleDir = deriveBundleDir(modelPath);
		const expectedBundleDir = path.join(
			modelsDir,
			".bionic-bundles",
			"eliza-1-2b-128k",
		);
		const stagedPath = path.join(
			expectedBundleDir,
			"text",
			"eliza-1-2b-128k.gguf",
		);

		expect(bundleDir).toBe(expectedBundleDir);
		expect(fs.existsSync(stagedPath)).toBe(true);
		expect(fs.readFileSync(stagedPath, "utf8")).toBe("GGUF");
	});

	it("does not stage arbitrary flat GGUF files into a fused Eliza-1 bundle", () => {
		const modelsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-bionic-flat-generic-"),
		);
		tempDirs.push(modelsDir);
		const modelPath = path.join(modelsDir, "flat-model.gguf");
		fs.writeFileSync(modelPath, "GGUF");

		expect(deriveBundleDir(modelPath)).toBe("");
		expect(fs.existsSync(path.join(modelsDir, ".bionic-bundles"))).toBe(false);
	});

	it("keeps flat text-only bundle aliases behind the ASR bundle gate", async () => {
		const modelsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-bionic-flat-text-only-"),
		);
		tempDirs.push(modelsDir);
		const modelPath = path.join(modelsDir, "eliza-1-2b-128k.gguf");
		fs.writeFileSync(modelPath, "GGUF");

		const loader = new BionicHostLoader("unused-asr-gate");
		await loader.loadModel({ modelPath });

		await expect(
			loader.transcribe({ pcmBase64: "AAAA", sampleRate: 16000 }),
		).rejects.toThrow(/requires an active Gemma ASR-capable bundle/);
	});
});

describeLinuxOnly("BionicHostLoader (real abstract-UDS)", () => {
	it("round-trips a buffered generate and returns the host completion", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({
				ok: true,
				text: "Two plus two equals four.",
				tokens: 7,
				ms: 500,
				tokS: 14,
			});
		});
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({
			modelPath: "/data/x/eliza-1/bundle/text/model.gguf",
		});
		expect(loader.currentModelPath()).toBe(
			"/data/x/eliza-1/bundle/text/model.gguf",
		);
		const out = await loader.generate({
			prompt: "what is 2+2?",
			maxTokens: 32,
		});
		expect(out).toBe("Two plus two equals four.");
		// bundleDir derived from the .../text/<model>.gguf layout.
		expect(seen).toMatchObject({
			op: "generate",
			prompt: "what is 2+2?",
			maxTokens: 32,
			bundleDir: "/data/x/eliza-1/bundle",
		});
	});

	it("forwards an empty bundleDir when a non-Eliza model is not in a text/ bundle", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({ ok: true, text: "hi" });
		});
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/models/flat-model.gguf" });
		await loader.generate({ prompt: "hi" });
		expect((seen as { bundleDir?: string } | null)?.bundleDir).toBe("");
	});

	it("throws when the host returns ok:false", async () => {
		host = startHost(SOCK, () =>
			JSON.stringify({ ok: false, error: "no vulkan device" }),
		);
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		await expect(loader.generate({ prompt: "x" })).rejects.toThrow(
			/no vulkan device/,
		);
	});

	it("survives a response split across multiple data chunks (multibyte safe)", async () => {
		const text = `héllo 🌊 ünïcode ${"x".repeat(5000)}`;
		host = net.createServer((sock) => {
			let buf = Buffer.alloc(0);
			let expected = -1;
			sock.on("data", (d) => {
				buf = Buffer.concat([buf, d]);
				if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
				if (expected >= 0 && buf.length >= 4 + expected) {
					const full = frame(JSON.stringify({ ok: true, text }));
					// Write in two pieces, splitting mid-buffer to exercise reassembly.
					sock.write(full.subarray(0, 10));
					setTimeout(() => sock.write(full.subarray(10)), 5);
				}
			});
		});
		host.listen({ path: `\0${SOCK}` });
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		const out = await loader.generate({ prompt: "x" });
		expect(out).toBe(text);
	});

	it("rejects when the host is unreachable", async () => {
		const loader = new BionicHostLoader(`eliza-bionic-absent-${process.pid}`);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		await expect(loader.generate({ prompt: "x" })).rejects.toThrow();
	});

	it("transcribe forwards op=asr with pcm + sampleRate and returns the transcript", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({ ok: true, text: "the quick brown fox" });
		});
		const loader = new BionicHostLoader(SOCK);
		const modelPath = makeBundleModelPath();
		await loader.loadModel({ modelPath });
		const out = await loader.transcribe({
			pcmBase64: "AAAA",
			sampleRate: 16000,
		});
		expect(out).toBe("the quick brown fox");
		expect(seen).toMatchObject({
			op: "asr",
			pcmBase64: "AAAA",
			sampleRate: 16000,
			bundleDir: path.dirname(path.dirname(modelPath)),
		});
	});

	it("transcribe refuses Qwen ASR provenance before contacting the host", async () => {
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({
			modelPath: makeBundleModelPath({
				lineage: { asr: { base: "Qwen3-ASR" } },
			}),
		});
		await expect(
			loader.transcribe({ pcmBase64: "AAAA", sampleRate: 16000 }),
		).rejects.toThrow(/Qwen ASR provenance/);
	});

	it("describeImage forwards op=image with bytes + prompt and returns the description", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({ ok: true, text: "a cat on a desk" });
		});
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({
			modelPath: "/data/x/eliza-1/bundle/text/model.gguf",
		});
		const out = await loader.describeImage({
			imageBase64: "iVBORw0K",
			prompt: "what is this?",
		});
		expect(out).toBe("a cat on a desk");
		expect(seen).toMatchObject({
			op: "image",
			imageBase64: "iVBORw0K",
			prompt: "what is this?",
			mmprojPath: "",
			bundleDir: "/data/x/eliza-1/bundle",
		});
	});

	it("transcribe throws on host ok:false", async () => {
		host = startHost(SOCK, () =>
			JSON.stringify({ ok: false, error: "no asr weights staged" }),
		);
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: makeBundleModelPath() });
		await expect(
			loader.transcribe({ pcmBase64: "AAAA", sampleRate: 16000 }),
		).rejects.toThrow(/no asr weights staged/);
	});
});
