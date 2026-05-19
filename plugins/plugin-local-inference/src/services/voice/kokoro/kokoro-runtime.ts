/**
 * Kokoro-82M model runner.
 *
 * Execution paths:
 *
 *   1. GGUF via llama-server (default). When the host llama-server advertises
 *      a Kokoro-capable build and exposes `/v1/audio/speech`, we POST text in
 *      and stream PCM out.
 *
 *   2. ONNX via onnxruntime-node. Used by local release/e2e verification when
 *      the fused llama-server cannot serve Kokoro directly.
 *
 *   3. Python subprocess — eval-loop only. Spawns `python -m kokoro_tts`.
 *      Never the default in production.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	type KokoroModelLayout,
	KokoroModelMissingError,
	type KokoroPhonemeSequence,
	type KokoroVoicePack,
} from "./types";

/** Pinned GGUF candidate location (carried by our llama.cpp fork). The
 *  runtime references this only for diagnostics; the fork-side builder
 *  produces the file at this path. */
export const KOKORO_GGUF_REL_PATH = "voice/kokoro-82m-v1_0.gguf";

/** One synthesized PCM segment delivered to the streaming backend. */
export interface KokoroRuntimeChunk {
	pcm: Float32Array;
	sampleRate: number;
	isFinal: boolean;
}

/**
 * Construction-time inputs for a runtime instance. The voice pack contains
 * the style tensor reference; the runtime is responsible for resolving the
 * bytes off `layout.voicesDir/<file>`.
 */
export interface KokoroRuntimeInputs {
	phonemes: KokoroPhonemeSequence;
	voice: KokoroVoicePack;
	/**
	 * Output sample budget. The runtime always honours the model's native
	 * sample rate (`layout.sampleRate`, usually 24 kHz) — this caps the
	 * total samples to prevent runaway generation. Defaults to 16 seconds
	 * at the layout sample rate (matches the longest phrase the chunker
	 * will emit + headroom).
	 */
	maxSamples?: number;
	/** Cancellation signal — polled at chunk boundaries. */
	cancelSignal: { cancelled: boolean };
	/** Per-chunk callback; returning `true` cancels the rest of the run. */
	onChunk: (chunk: KokoroRuntimeChunk) => boolean | undefined;
}

/** Shared runtime contract — `KokoroTtsBackend` depends on this, not the
 *  concrete classes. Tests inject a mock. */
export interface KokoroRuntime {
	readonly id: "gguf" | "onnx" | "python" | "mock";
	readonly sampleRate: number;
	synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }>;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// GGUF via llama-server path. Production-eligible on mobile builds where the
// text-gen llama-server already runs and reloading a second runtime is too
// heavy. Wires `/v1/audio/speech` per the upstream draft spec.
// ---------------------------------------------------------------------------

export interface KokoroGgufRuntimeOptions {
	/** Base URL of the running llama-server, e.g. `http://127.0.0.1:8081`. */
	serverUrl: string;
	/** Model id the server advertises (`kokoro-82m-v1`). */
	modelId: string;
	/** Output sample rate the server emits. */
	sampleRate: number;
	/** Custom `fetch` implementation (tests inject one). */
	fetchImpl?: typeof fetch;
}

/**
 * GGUF-backed runtime that talks to a llama-server instance with the
 * Kokoro head. The server speaks the `/v1/audio/speech` OpenAI-compatible
 * endpoint; chunked transfer streams raw PCM frames.
 */
export class KokoroGgufRuntime implements KokoroRuntime {
	readonly id = "gguf" as const;
	readonly sampleRate: number;
	private readonly opts: KokoroGgufRuntimeOptions;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: KokoroGgufRuntimeOptions) {
		this.opts = opts;
		this.sampleRate = opts.sampleRate;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		const url = `${this.opts.serverUrl.replace(/\/+$/, "")}/v1/audio/speech`;
		const ctrl = new AbortController();
		const cancelHook = () => {
			if (args.cancelSignal.cancelled) ctrl.abort();
		};
		const interval = setInterval(cancelHook, 25);
		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				body: JSON.stringify({
					model: this.opts.modelId,
					input: decodePhonemesForGgufBody(args.phonemes),
					voice: args.voice.id,
					response_format: "pcm",
					sample_rate: this.sampleRate,
				}),
				headers: { "content-type": "application/json" },
				signal: ctrl.signal,
			});
			if (!res.ok || !res.body) {
				throw new Error(
					`[kokoro] llama-server /v1/audio/speech returned ${res.status} ${res.statusText}`,
				);
			}
			const reader = res.body.getReader();
			let cancelled = false;
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (args.cancelSignal.cancelled) {
					cancelled = true;
					break;
				}
				if (!value) continue;
				const pcm = bytesToFloat32Pcm(value);
				const want = args.onChunk({
					pcm,
					sampleRate: this.sampleRate,
					isFinal: false,
				});
				if (want === true || args.cancelSignal.cancelled) {
					cancelled = true;
					break;
				}
			}
			args.onChunk({
				pcm: new Float32Array(0),
				sampleRate: this.sampleRate,
				isFinal: true,
			});
			return { cancelled };
		} finally {
			clearInterval(interval);
		}
	}

	dispose(): void {
		// Stateless adapter; nothing to release. The underlying llama-server
		// is owned by the engine and lives across synthesis calls.
	}
}

function decodePhonemesForGgufBody(seq: KokoroPhonemeSequence): string {
	// The upstream spec ships the raw phoneme string; the server tokenises
	// it the same way the server-side tokenizer does. Sending ids would require a
	// server-side schema for `input_ids` which the OpenAI-compat endpoint
	// does not have.
	return seq.phonemes;
}

function bytesToFloat32Pcm(bytes: Uint8Array): Float32Array {
	// The endpoint streams little-endian 16-bit PCM by default; convert.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = Math.floor(bytes.byteLength / 2);
	const out = new Float32Array(samples);
	for (let i = 0; i < samples; i++) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

// ---------------------------------------------------------------------------
// ONNX runtime path — release/e2e verification and hosts without Kokoro GGUF
// serving support. Keeps one InferenceSession warm and swaps voice style.
// ---------------------------------------------------------------------------

interface OrtTensor {
	data: unknown;
}

interface OrtSession {
	inputNames?: string[];
	inputMetadata?:
		| Array<{ name?: string; type?: string }>
		| Record<string, { type?: string }>;
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
	release?: () => void;
}

interface OrtModule {
	Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
	InferenceSession: {
		create(
			modelPath: string,
			opts: Record<string, unknown>,
		): Promise<OrtSession>;
	};
}

export interface KokoroOnnxRuntimeOptions {
	layout: KokoroModelLayout;
	expectedSha256?: string | null;
	executionProvider?: string;
	intraOpNumThreads?: number;
	enableCpuMemArena?: boolean;
	enableMemPattern?: boolean;
	executionMode?: "sequential" | "parallel";
	graphOptimizationLevel?: "disabled" | "basic" | "extended" | "layout" | "all";
	disablePrepacking?: boolean;
	loadOrt?: () => Promise<OrtModule>;
}

export class KokoroOnnxRuntime implements KokoroRuntime {
	readonly id = "onnx" as const;
	readonly sampleRate: number;
	private session: OrtSession | null = null;
	private ort: OrtModule | null = null;
	private readonly voiceCache = new Map<string, Float32Array>();

	constructor(private readonly opts: KokoroOnnxRuntimeOptions) {
		this.sampleRate = opts.layout.sampleRate;
	}

	private async ensureSession(): Promise<{
		ort: OrtModule;
		session: OrtSession;
	}> {
		if (this.ort && this.session)
			return { ort: this.ort, session: this.session };
		const modelPath = path.join(
			this.opts.layout.root,
			this.opts.layout.modelFile,
		);
		if (!existsSync(modelPath)) {
			throw new KokoroModelMissingError(
				`[kokoro] ONNX model not found at ${modelPath}`,
			);
		}
		if (this.opts.expectedSha256) {
			await verifySha256(modelPath, this.opts.expectedSha256);
		}
		const loadOrt = this.opts.loadOrt ?? defaultOrtLoader;
		this.ort = await loadOrt();
		const envThreads = Number.parseInt(
			process.env.ELIZA_KOKORO_ONNX_THREADS ?? "",
			10,
		);
		const intraOpNumThreads =
			this.opts.intraOpNumThreads ??
			(Number.isFinite(envThreads) && envThreads > 0
				? envThreads
				: Math.max(1, os.cpus().length));
		const enableCpuMemArena =
			this.opts.enableCpuMemArena ??
			process.env.ELIZA_KOKORO_ONNX_CPU_ARENA !== "0";
		const enableMemPattern =
			this.opts.enableMemPattern ??
			process.env.ELIZA_KOKORO_ONNX_MEM_PATTERN !== "0";
		const graphOptimizationLevel =
			this.opts.graphOptimizationLevel ??
			normalizeGraphOptimizationLevel(
				process.env.ELIZA_KOKORO_ONNX_GRAPH_OPT,
			) ??
			"all";
		const executionMode =
			this.opts.executionMode ??
			(process.env.ELIZA_KOKORO_ONNX_EXECUTION_MODE === "parallel"
				? "parallel"
				: "sequential");
		const disablePrepacking =
			this.opts.disablePrepacking ??
			process.env.ELIZA_KOKORO_ONNX_DISABLE_PREPACKING === "1";
		this.session = await this.ort.InferenceSession.create(modelPath, {
			executionProviders: [this.opts.executionProvider ?? "cpu"],
			graphOptimizationLevel,
			intraOpNumThreads,
			interOpNumThreads: 1,
			enableCpuMemArena,
			enableMemPattern,
			executionMode,
			...(disablePrepacking
				? { extra: { session: { disable_prepacking: "1" } } }
				: {}),
		});
		return { ort: this.ort, session: this.session };
	}

	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		if (args.phonemes.ids.length > 510) {
			throw new Error(
				`[kokoro] phoneme sequence is too long: ${args.phonemes.ids.length} > 510`,
			);
		}
		const { ort, session } = await this.ensureSession();
		const fullStyle = await this.loadVoiceStyle(args.voice);
		const inputIds = new BigInt64Array(args.phonemes.ids.length);
		for (let i = 0; i < args.phonemes.ids.length; i++) {
			inputIds[i] = BigInt(args.phonemes.ids[i] ?? 0);
		}
		const positions = fullStyle.length / args.voice.dim;
		const offset =
			Math.min(inputIds.length, Math.max(0, positions - 1)) * args.voice.dim;
		const style =
			positions > 1
				? fullStyle.subarray(offset, offset + args.voice.dim)
				: fullStyle;
		const inputNames = session.inputNames ?? ["input_ids", "style", "speed"];
		const tokensInputName = inputNames.includes("input_ids")
			? "input_ids"
			: "tokens";
		const speedDtype =
			getInputMetadataType(session, "speed") === "int32" ? "int32" : "float32";
		const speedTensor =
			speedDtype === "int32"
				? new ort.Tensor("int32", new Int32Array([1]), [1])
				: new ort.Tensor("float32", new Float32Array([1]), [1]);
		const out = await session.run({
			[tokensInputName]: new ort.Tensor("int64", inputIds, [
				1,
				inputIds.length,
			]),
			style: new ort.Tensor("float32", style, [1, style.length]),
			speed: speedTensor,
		});
		const waveform = (out.waveform ?? out.audio)?.data;
		if (!(waveform instanceof Float32Array)) {
			throw new Error(
				"[kokoro] ONNX session returned no float32 waveform tensor",
			);
		}
		if (args.cancelSignal.cancelled) return { cancelled: true };
		const cap = args.maxSamples ?? this.sampleRate * 16;
		const pcm = waveform.length > cap ? waveform.subarray(0, cap) : waveform;
		const want = args.onChunk({
			pcm,
			sampleRate: this.sampleRate,
			isFinal: false,
		});
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled: want === true };
	}

	private async loadVoiceStyle(voice: KokoroVoicePack): Promise<Float32Array> {
		const cached = this.voiceCache.get(voice.id);
		if (cached) return cached;
		const file = path.join(this.opts.layout.voicesDir, voice.file);
		if (!existsSync(file)) {
			throw new KokoroModelMissingError(
				`[kokoro] voice pack file missing at ${file}`,
			);
		}
		const buf = await readFile(file);
		const arr = new Float32Array(
			buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
		);
		if (arr.length === 0 || arr.length % voice.dim !== 0) {
			throw new KokoroModelMissingError(
				`[kokoro] voice pack ${voice.id} has ${arr.length} fp32 values, expected a positive multiple of ${voice.dim}`,
			);
		}
		this.voiceCache.set(voice.id, arr);
		return arr;
	}

	dispose(): void {
		this.session?.release?.();
		this.session = null;
		this.ort = null;
		this.voiceCache.clear();
	}
}

function normalizeGraphOptimizationLevel(
	value: string | undefined,
): "disabled" | "basic" | "extended" | "layout" | "all" | undefined {
	if (
		value === "disabled" ||
		value === "basic" ||
		value === "extended" ||
		value === "layout" ||
		value === "all"
	) {
		return value;
	}
	return undefined;
}

function getInputMetadataType(
	session: OrtSession,
	name: string,
): string | undefined {
	const meta = session.inputMetadata;
	if (Array.isArray(meta)) {
		return meta.find((m) => m.name === name)?.type;
	}
	return meta?.[name]?.type;
}

async function defaultOrtLoader(): Promise<OrtModule> {
	const spec = ["onnxruntime", "node"].join("-");
	const bun = (
		globalThis as {
			Bun?: { resolveSync?: (specifier: string, from: string) => string };
		}
	).Bun;
	for (const from of [
		process.cwd(),
		path.resolve(process.cwd(), "package.json"),
	]) {
		const resolved = bun?.resolveSync?.(spec, from);
		if (resolved && existsSync(resolved)) {
			return (await import(pathToFileUrlString(resolved))) as OrtModule;
		}
	}
	const here = path.dirname(fileURLToPath(import.meta.url));
	for (let dir = here; ; dir = path.dirname(dir)) {
		const packageJson = path.join(dir, "package.json");
		const bunLock = path.join(dir, "bun.lock");
		if (existsSync(packageJson) && existsSync(bunLock)) {
			const resolved = bun?.resolveSync?.(spec, dir);
			if (resolved && existsSync(resolved)) {
				return (await import(pathToFileUrlString(resolved))) as OrtModule;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
	}
	const requireFromHere = createRequire(import.meta.url);
	return requireFromHere(spec) as OrtModule;
}

function pathToFileUrlString(filePath: string): string {
	const absolute = path.resolve(filePath).replace(/\\/g, "/");
	return `file://${absolute.startsWith("/") ? "" : "/"}${absolute}`;
}

async function verifySha256(filePath: string, expected: string): Promise<void> {
	const expectedNorm = expected.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expectedNorm)) {
		throw new KokoroModelMissingError(
			`[kokoro] invalid expected SHA-256 (${expected})`,
		);
	}
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		createReadStream(filePath)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", resolve)
			.on("error", reject);
	});
	const got = hash.digest("hex");
	if (got !== expectedNorm) {
		const size = statSync(filePath).size;
		throw new KokoroModelMissingError(
			`[kokoro] model at ${filePath} (size ${size}) has SHA-256 ${got}, expected ${expectedNorm}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Python subprocess path — eval-loop only.
// ---------------------------------------------------------------------------

export interface KokoroPythonRuntimeOptions {
	pythonBinary: string;
	/** Resolved layout — the subprocess discovers the model under here. */
	layout: { root: string; sampleRate: number };
	/** Optional env passed through to the subprocess. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Subprocess-backed runtime. Spawns `python -m kokoro_tts ...` per
 * synthesis call (no warm-pool — the Python path is the *eval* path, not
 * the realtime path). Production code paths never select this; the
 * fine-tune evaluator wires it explicitly.
 */
export class KokoroPythonRuntime implements KokoroRuntime {
	readonly id = "python" as const;
	readonly sampleRate: number;

	constructor(opts: KokoroPythonRuntimeOptions) {
		this.sampleRate = opts.layout.sampleRate;
	}

	async synthesize(
		_args: KokoroRuntimeInputs,
	): Promise<{ cancelled: boolean }> {
		// The eval driver in `packages/training` is the canonical caller and
		// already wires `child_process.spawn`. Surfacing a clear error here
		// keeps the production runtime from accidentally enabling this path.
		throw new Error(
			"[kokoro] KokoroPythonRuntime is eval-only — use it from the fine-tune driver, not the runtime scheduler",
		);
	}

	dispose(): void {
		// No long-lived state.
	}
}

// ---------------------------------------------------------------------------
// Mock runtime — synthesizes a sine sweep keyed to phoneme count so tests
// can observe deterministic PCM without loading a model.
// ---------------------------------------------------------------------------

export interface KokoroMockRuntimeOptions {
	sampleRate: number;
	/** Total samples emitted per synthesis call. */
	totalSamples?: number;
	/** Number of body chunks to split the output across. */
	chunkCount?: number;
}

export class KokoroMockRuntime implements KokoroRuntime {
	readonly id = "mock" as const;
	readonly sampleRate: number;
	private readonly opts: Required<KokoroMockRuntimeOptions>;
	calls = 0;

	constructor(opts: KokoroMockRuntimeOptions) {
		this.sampleRate = opts.sampleRate;
		this.opts = {
			sampleRate: opts.sampleRate,
			totalSamples: opts.totalSamples ?? Math.floor(opts.sampleRate * 0.2),
			chunkCount: opts.chunkCount ?? 4,
		};
	}

	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		this.calls++;
		const { totalSamples, chunkCount } = this.opts;
		const perChunk = Math.max(1, Math.ceil(totalSamples / chunkCount));
		const freqHz = 100 + (args.phonemes.ids.length % 200);
		let written = 0;
		let cancelled = false;
		for (let off = 0; off < totalSamples; off += perChunk) {
			if (args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
			const n = Math.min(perChunk, totalSamples - off);
			const pcm = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				const t = (off + i) / this.sampleRate;
				pcm[i] = Math.sin(2 * Math.PI * freqHz * t) * 0.1;
			}
			written += n;
			const want = args.onChunk({
				pcm,
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			if (want === true || args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		void written;
		return { cancelled };
	}

	dispose(): void {
		/* nothing */
	}
}

// Keep KokoroModelMissingError re-export for callers that import from this module.
export { KokoroModelMissingError };
