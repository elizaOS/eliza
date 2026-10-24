import { EventEmitter } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineVoiceBridge } from "../../engine-bridge";
import {
	readVoiceBackendModeFromEnv,
	selectVoiceBackend,
} from "../../tts-backend-selection";
import type { Phrase, SpeakerPreset, TtsPcmChunk } from "../../types";
import { encodeMonoPcm16Wav } from "../../wav-codec";
import {
	HostTtsClient,
	hostTtsWorkerArgs,
	ParadeeSpeechCancelledError,
} from "../host-tts-client";
import {
	createParadeeSpeakerPreset,
	type ParadeeSynthesizer,
	ParadeeTtsBackend,
	splitParadeeText,
	wavToFloat32,
} from "../paradee-backend";
import {
	discoverParadeeEngine,
	PARADEE_MODEL_FILES,
	type ParadeeEngineConfig,
} from "../paradee-engine-discovery";

const RATE = 24_000;
const preset: SpeakerPreset = createParadeeSpeakerPreset();

function phrase(text: string): Phrase {
	return { id: 1, text, fromIndex: 0, toIndex: 0, terminator: "punctuation" };
}

function wavOfSeconds(seconds: number, rate = RATE): Buffer {
	const pcm = new Float32Array(Math.round(seconds * rate));
	for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10) * 0.5;
	return Buffer.from(encodeMonoPcm16Wav(pcm, rate));
}

class FakeSynth implements ParadeeSynthesizer {
	readonly texts: string[] = [];
	disposed = false;
	running = false;
	async initialize() {
		this.running = true;
	}
	async unload() {
		this.running = false;
	}
	constructor(
		private readonly impl: (
			text: string,
			isCancelled: () => boolean,
		) => Promise<Buffer> = async () => wavOfSeconds(0.6),
	) {}
	synthesize(text: string, isCancelled: () => boolean) {
		this.texts.push(text);
		return this.impl(text, isCancelled);
	}
	dispose() {
		this.disposed = true;
	}
}

describe("splitParadeeText", () => {
	it("keeps short text whole", () => {
		expect(splitParadeeText("Hello there.")).toEqual(["Hello there."]);
	});

	it("splits at sentence ends, then words, and preserves every character", () => {
		const sentence = "This sentence is about forty characters. ";
		const text = sentence.repeat(25);
		const pieces = splitParadeeText(text, 120);
		expect(pieces.join("")).toBe(text);
		for (const piece of pieces) {
			expect(piece.length).toBeLessThanOrEqual(120);
			expect(piece.trimEnd().endsWith(".")).toBe(true);
		}
		const words = "word ".repeat(200);
		const wordPieces = splitParadeeText(words, 50);
		expect(wordPieces.join("")).toBe(words);
		for (const piece of wordPieces) expect(piece.endsWith(" ")).toBe(true);
	});

	it("hard-cuts an unbroken run and rejects limits beyond the worker's", () => {
		const run = "x".repeat(250);
		expect(splitParadeeText(run, 100)).toEqual([
			"x".repeat(100),
			"x".repeat(100),
			"x".repeat(50),
		]);
		expect(() => splitParadeeText("hi", 501)).toThrow(/invalid request limit/);
	});
});

describe("wavToFloat32", () => {
	it("round-trips the worker's mono PCM16 WAV", () => {
		const { pcm, sampleRate } = wavToFloat32(wavOfSeconds(0.1));
		expect(sampleRate).toBe(RATE);
		expect(pcm.length).toBe(2400);
		expect(Math.abs((pcm[10] ?? 0) - Math.sin(1) * 0.5)).toBeLessThan(1e-3);
	});

	it("refuses non-WAV bytes", () => {
		expect(() => wavToFloat32(Buffer.from("not a wav at all"))).toThrow();
	});
});

describe("ParadeeTtsBackend", () => {
	it("streams 250 ms slices then one final tail (scheduler contract)", async () => {
		const synth = new FakeSynth();
		const backend = new ParadeeTtsBackend({ synthesizer: synth });
		const chunks: TtsPcmChunk[] = [];
		const result = await backend.synthesizeStream({
			phrase: phrase("Hello from Paradee."),
			preset,
			cancelSignal: { cancelled: false },
			onChunk: (chunk) => {
				chunks.push(chunk);
				return false;
			},
		});
		expect(result.cancelled).toBe(false);
		expect(synth.texts).toEqual(["Hello from Paradee."]);
		const body = chunks.filter((c) => !c.isFinal);
		expect(body.map((c) => c.pcm.length)).toEqual([6000, 6000, 2400]);
		expect(chunks.at(-1)).toMatchObject({ isFinal: true });
		expect(chunks.at(-1)?.pcm.length).toBe(0);
		expect(chunks.every((c) => c.sampleRate === RATE)).toBe(true);
	});

	it("splits long phrases into ordered worker requests", async () => {
		const synth = new FakeSynth(async () => wavOfSeconds(0.05));
		const backend = new ParadeeTtsBackend({ synthesizer: synth });
		const text = "One sentence that keeps going on. ".repeat(30);
		const audio = await backend.synthesize({
			phrase: phrase(text),
			preset,
			cancelSignal: { cancelled: false },
		});
		expect(synth.texts.length).toBeGreaterThan(1);
		expect(synth.texts.join(" ").replace(/\s+/g, " ")).toBe(
			text.trim().replace(/\s+/g, " "),
		);
		expect(audio.pcm.length).toBe(synth.texts.length * 1200);
		expect(audio.sampleRate).toBe(RATE);
	});

	it("barge-in mid-stream stops delivery and still emits the tail", async () => {
		const backend = new ParadeeTtsBackend({ synthesizer: new FakeSynth() });
		const cancelSignal = { cancelled: false };
		const body: TtsPcmChunk[] = [];
		let finals = 0;
		const result = await backend.synthesizeStream({
			phrase: phrase("Interrupt me."),
			preset,
			cancelSignal,
			onChunk: (chunk) => {
				if (chunk.isFinal) finals++;
				else {
					body.push(chunk);
					cancelSignal.cancelled = true;
				}
				return false;
			},
		});
		expect(result.cancelled).toBe(true);
		expect(body).toHaveLength(1);
		expect(finals).toBe(1);
	});

	it("cancels the request in flight through the synthesizer's poll", async () => {
		let observed = false;
		const synth = new FakeSynth(
			(_text, isCancelled) =>
				new Promise((_resolve, reject) => {
					const timer = setInterval(() => {
						if (isCancelled()) {
							observed = true;
							clearInterval(timer);
							reject(new ParadeeSpeechCancelledError());
						}
					}, 1);
				}),
		);
		const backend = new ParadeeTtsBackend({ synthesizer: synth });
		const cancelSignal = { cancelled: false };
		const chunks: TtsPcmChunk[] = [];
		const run = backend.synthesizeStream({
			phrase: phrase("First. Second."),
			preset,
			cancelSignal,
			onChunk: (chunk) => {
				chunks.push(chunk);
				return false;
			},
		});
		setTimeout(() => {
			cancelSignal.cancelled = true;
		}, 5);
		await expect(run).resolves.toEqual({ cancelled: true });
		expect(observed).toBe(true);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.isFinal).toBe(true);
	});

	it("surfaces worker failures and rejects a foreign sample rate", async () => {
		const failing = new ParadeeTtsBackend({
			synthesizer: new FakeSynth(async () => {
				throw new Error("[paradee] speech synthesis failed");
			}),
		});
		await expect(
			failing.synthesize({
				phrase: phrase("Hi."),
				preset,
				cancelSignal: { cancelled: false },
			}),
		).rejects.toThrow(/synthesis failed/);
		const wrongRate = new ParadeeTtsBackend({
			synthesizer: new FakeSynth(async () => wavOfSeconds(0.1, 16_000)),
		});
		await expect(
			wrongRate.synthesize({
				phrase: phrase("Hi."),
				preset,
				cancelSignal: { cancelled: false },
			}),
		).rejects.toThrow(/16000 Hz/);
	});

	it("skips segments with nothing to say", async () => {
		const synth = new FakeSynth();
		const backend = new ParadeeTtsBackend({ synthesizer: synth });
		const audio = await backend.synthesize({
			phrase: phrase(" ... "),
			preset,
			cancelSignal: { cancelled: false },
		});
		expect(synth.texts).toEqual([]);
		expect(audio.pcm.length).toBe(0);
	});
});

class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdin = new PassThrough();
	output = new PassThrough();
	stdio = [this.stdin, null, null, this.output];
	kill = vi.fn(() => true);
	readonly requests: Array<Record<string, unknown>> = [];
	constructor() {
		super();
		let text = "";
		this.stdin.on("data", (bytes: Buffer) => {
			text += bytes.toString();
			for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n")) {
				this.requests.push(JSON.parse(text.slice(0, i)));
				text = text.slice(i + 1);
			}
		});
	}
	send(value: unknown) {
		this.output.write(`${JSON.stringify(value)}\n`);
	}
}

const config: ParadeeEngineConfig = {
	modelDir: "/models/paradee",
	library: "/lib/libelizainference.dylib",
	librarySha256: "a".repeat(64),
};

describe("HostTtsClient", () => {
	let children: FakeChild[];
	let spawnArgs: unknown[][];
	const spawnImpl = ((...args: unknown[]) => {
		spawnArgs.push(args);
		const child = new FakeChild();
		children.push(child);
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
	beforeEach(() => {
		children = [];
		spawnArgs = [];
	});

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("spawns the worker with only its pinned environment and serializes requests", async () => {
		const client = new HostTtsClient({
			config,
			workerPath: "/repo/src/host-tts-worker.ts",
			bunPath: "/bin/bun",
			spawnImpl,
		});
		const first = client.synthesize("one", () => false);
		const second = client.synthesize("two", () => false);
		await flush();
		expect(spawnArgs[0]?.[0]).toBe("/bin/bun");
		expect(spawnArgs[0]?.[1]).toEqual([
			"--no-install",
			"--conditions=eliza-source",
			"/repo/src/host-tts-worker.ts",
		]);
		const env = (
			spawnArgs[0]?.[2] as { env: Record<string, string> } | undefined
		)?.env;
		expect(env).toMatchObject({
			ELIZA_INFERENCE_LIBRARY: config.library,
			ELIZA_INFERENCE_LIBRARY_SHA256: config.librarySha256,
			ELIZA_PARADEE_MODEL_DIR: config.modelDir,
		});
		expect(
			Object.keys(env).every((k) => /^(ELIZA_|PATH|HOME|TMPDIR|LANG)/.test(k)),
		).toBe(true);
		const child = children[0] as FakeChild;
		child.send({ ready: true });
		await flush();
		expect(child.requests).toHaveLength(1);
		expect(child.requests[0]).toMatchObject({ op: "synthesize", text: "one" });
		const audio = wavOfSeconds(0.01).toString("base64");
		child.send({ id: child.requests[0]?.id, audio });
		await expect(first).resolves.toBeInstanceOf(Buffer);
		await flush();
		expect(child.requests).toHaveLength(2);
		child.send({ id: child.requests[1]?.id, audio });
		await expect(second).resolves.toBeInstanceOf(Buffer);
		expect(children).toHaveLength(1);
		client.dispose();
		expect(child.kill).toHaveBeenCalled();
	});

	it("sends a native cancel for the request in flight", async () => {
		const client = new HostTtsClient({
			config,
			workerPath: "/w.js",
			spawnImpl,
		});
		let cancelled = false;
		const run = client.synthesize("long text", () => cancelled);
		await flush();
		const child = children[0] as FakeChild;
		child.send({ ready: true });
		await flush();
		cancelled = true;
		await new Promise((resolve) => setTimeout(resolve, 30));
		const cancel = child.requests.find((r) => r.op === "cancel");
		expect(cancel?.id).toBe(child.requests[0]?.id);
		child.send({ id: cancel?.id, error: "cancelled" });
		await expect(run).rejects.toBeInstanceOf(ParadeeSpeechCancelledError);
		client.dispose();
	});

	it("rejects when the worker refuses to start, and respawns on the next request", async () => {
		const client = new HostTtsClient({
			config,
			workerPath: "/w.js",
			spawnImpl,
		});
		const run = client.synthesize("hi", () => false);
		await flush();
		(children[0] as FakeChild).emit("exit", 1);
		await expect(run).rejects.toThrow(/failed to start/);
		const retry = client.synthesize("hi", () => false);
		await flush();
		expect(children).toHaveLength(2);
		(children[1] as FakeChild).send({ ready: true });
		await flush();
		const child = children[1] as FakeChild;
		child.send({ id: child.requests[0]?.id, error: "failed" });
		await expect(retry).rejects.toThrow(/synthesis failed/);
		client.dispose();
	});

	it("waits for worker exit on unload and reloads on next initialization", async () => {
		const client = new HostTtsClient({
			config,
			workerPath: "/w.js",
			spawnImpl,
		});
		const boot = client.initialize();
		const child = children[0] as FakeChild;
		child.send({ ready: true });
		await boot;
		let released = false;
		const unloaded = client.unload().then(() => {
			released = true;
		});
		await flush();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(released).toBe(false);
		child.signalCode = "SIGKILL";
		child.emit("exit", null, "SIGKILL");
		await unloaded;
		const reboot = client.initialize();
		expect(children).toHaveLength(2);
		(children[1] as FakeChild).send({ ready: true });
		await reboot;
		client.dispose();
	});

	it("settles startup when disposed before readiness", async () => {
		const client = new HostTtsClient({
			config,
			workerPath: "/w.js",
			spawnImpl,
		});
		const boot = client.initialize();
		const rejected = expect(boot).rejects.toThrow(/failed to start/);
		client.dispose();
		(children[0] as FakeChild).emit("exit", null, "SIGKILL");
		await rejected;
	});

	it("passes no source condition to a built worker", () => {
		expect(hostTtsWorkerArgs("/app/dist/host-tts-worker.js")).toEqual([
			"--no-install",
			"/app/dist/host-tts-worker.js",
		]);
	});
});

describe("discoverParadeeEngine", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "paradee-discovery-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function stageModels(dir: string) {
		mkdirSync(dir, { recursive: true });
		for (const file of PARADEE_MODEL_FILES) {
			const target = path.join(dir, file.path);
			writeFileSync(target, "");
			truncateSync(target, file.bytes);
		}
	}
	function stageLibrary(dir: string, stamp?: Record<string, unknown>) {
		mkdirSync(dir, { recursive: true });
		const name =
			process.platform === "darwin"
				? "libelizainference.dylib"
				: process.platform === "win32"
					? "elizainference.dll"
					: "libelizainference.so";
		writeFileSync(path.join(dir, name), "lib");
		if (stamp) {
			writeFileSync(
				path.join(dir, ".eliza-fused-build-stamp.json"),
				JSON.stringify({ fusedLib: name, ...stamp }),
			);
		}
		return path.join(dir, name);
	}

	it("finds the bundle's tts/paradee and the stamped digest of the staged library", () => {
		const bundle = path.join(tmp, "bundle");
		stageModels(path.join(bundle, "tts", "paradee"));
		const library = stageLibrary(path.join(bundle, "lib"), {
			fusedSha256: "b".repeat(64),
		});
		const found = discoverParadeeEngine({
			bundleRoot: bundle,
			env: { ELIZA_STATE_DIR: tmp },
		});
		expect(found).toEqual({
			ok: true,
			config: {
				modelDir: path.join(bundle, "tts", "paradee"),
				library,
				librarySha256: "b".repeat(64),
			},
		});
	});

	it("prefers ELIZA_PARADEE_MODEL_DIR and the explicit reviewed digest", () => {
		const models = path.join(tmp, "explicit");
		stageModels(models);
		const library = stageLibrary(path.join(tmp, "lib"));
		const found = discoverParadeeEngine({
			env: {
				ELIZA_STATE_DIR: tmp,
				ELIZA_PARADEE_MODEL_DIR: models,
				ELIZA_INFERENCE_LIBRARY: library,
				ELIZA_INFERENCE_LIBRARY_SHA256: "C".repeat(64),
			},
		});
		expect(found.ok && found.config).toEqual({
			modelDir: models,
			library,
			librarySha256: "c".repeat(64),
		});
	});

	it("reports what is missing instead of resolving", () => {
		expect(discoverParadeeEngine({ env: { ELIZA_STATE_DIR: tmp } })).toEqual({
			ok: false,
			reason: expect.stringMatching(/not staged/),
		});
		const models = path.join(tmp, "m");
		stageModels(models);
		truncateSync(path.join(models, "misaki-en-us.lex"), 10);
		expect(
			discoverParadeeEngine({
				env: { ELIZA_STATE_DIR: tmp, ELIZA_PARADEE_MODEL_DIR: models },
			}).ok,
		).toBe(false);
		stageModels(models);
		const noLib = discoverParadeeEngine({
			env: {
				ELIZA_STATE_DIR: tmp,
				ELIZA_PARADEE_MODEL_DIR: models,
				ELIZA_INFERENCE_MANAGED_LOOKUP: "0",
			},
		});
		expect(noLib.ok).toBe(false);
		if (!noLib.ok) expect(noLib.reason).toMatch(/libelizainference/);
		const library = stageLibrary(path.join(tmp, "lib-unstamped"));
		const noDigest = discoverParadeeEngine({
			env: {
				ELIZA_STATE_DIR: tmp,
				ELIZA_PARADEE_MODEL_DIR: models,
				ELIZA_INFERENCE_LIBRARY: library,
			},
		});
		expect(noDigest.ok).toBe(false);
		if (!noDigest.ok) expect(noDigest.reason).toMatch(/reviewed digest/);
	});

	it("reports an unreadable model directory instead of a missing install", () => {
		const models = path.join(tmp, "locked");
		stageModels(models);
		chmodSync(models, 0o000);
		try {
			const found = discoverParadeeEngine({
				env: { ELIZA_STATE_DIR: tmp, ELIZA_PARADEE_MODEL_DIR: models },
			});
			// A staged but unreadable directory is a broken install, not an
			// install without the pinned files: do not send the operator to
			// download a model that is already there.
			expect(found.ok).toBe(false);
			if (!found.ok) {
				expect(found.reason).toMatch(/could not be read/);
				expect(found.reason).toContain(
					path.join(models, "paradee-8m-v1_1.gguf"),
				);
			}
		} finally {
			chmodSync(models, 0o700);
		}
	});

	it("tracks the host worker's pinned Paradee files", () => {
		const worker = readFileSync(
			fileURLToPath(new URL("../../../../host-tts-worker.ts", import.meta.url)),
			"utf8",
		);
		for (const file of PARADEE_MODEL_FILES) {
			expect(worker).toMatch(
				new RegExp(
					`path: "${file.path.replace(/\./g, "\\.")}",\\s*sha256: "[0-9a-f]{64}",\\s*bytes: ${String(file.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, "_")},`,
				),
			);
		}
	});
});

describe("selectVoiceBackend", () => {
	it("selects Paradee by default and never substitutes Kokoro for it", () => {
		expect(selectVoiceBackend({ paradeeAvailable: true }).backend).toBe(
			"paradee",
		);
		expect(() =>
			selectVoiceBackend({
				paradeeAvailable: false,
				kokoroAvailable: true,
				paradeeUnavailableReason: "no models",
			}),
		).toThrow(/Paradee-8M v1\.1 .*no models/);
	});

	it("keeps Kokoro behind an explicit opt-in", () => {
		expect(
			selectVoiceBackend({
				mode: "kokoro",
				paradeeAvailable: true,
				kokoroAvailable: true,
			}).backend,
		).toBe("kokoro");
		expect(() =>
			selectVoiceBackend({ mode: "kokoro", paradeeAvailable: true }),
		).toThrow(/ELIZA_TTS_BACKEND=kokoro/);
		expect(readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "Paradee" })).toBe(
			"paradee",
		);
		expect(() =>
			readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "omnivoice" }),
		).toThrow(/retired/);
	});
});

describe("EngineVoiceBridge paradeeOnly", () => {
	it("drives the scheduler through the Paradee backend and stops its worker on dispose", async () => {
		const synth = new FakeSynth(async () => wavOfSeconds(0.3));
		const backend = new ParadeeTtsBackend({ synthesizer: synth });
		const bridge = EngineVoiceBridge.start({
			bundleRoot: "",
			useFfiBackend: false,
			paradeeOnly: config,
			ttsBackendOverride: backend,
		});
		expect(bridge.backend).toBe(backend);
		expect(bridge.asrAvailable).toBe(false);
		expect(bridge.ffi).toBeNull();
		await bridge.arm();
		const wav = await bridge.synthesizeTextToWav("Hello there.");
		const decoded = wavToFloat32(Buffer.from(wav));
		expect(decoded.sampleRate).toBe(RATE);
		expect(decoded.pcm.length).toBe(7200);
		expect(synth.texts).toEqual(["Hello there."]);
		bridge.dispose();
		expect(synth.disposed).toBe(true);
	});

	it("refuses to combine paradeeOnly with another backend path", () => {
		expect(() =>
			EngineVoiceBridge.start({
				bundleRoot: "",
				useFfiBackend: true,
				paradeeOnly: config,
			}),
		).toThrow(/paradeeOnly cannot be combined/);
	});
});
