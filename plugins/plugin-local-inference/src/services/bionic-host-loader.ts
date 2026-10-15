/**
 * BionicHostLoader — the agent-side half of the on-device GPU delegation path.
 *
 * On Android the elizaOS agent runs as embedded bun under the musl loader, whose
 * restricted linker namespace cannot load the bionic Android Vulkan driver (its
 * HIDL/HAL closure) — so the musl agent can only run inference on the CPU. The
 * GPU is reachable only from the normal bionic `ai.elizaos.app` process, where
 * `ElizaBionicInferenceServer` (Java) has loaded the fused
 * `libelizainference.so` and offloads the model to the Mali GPU.
 *
 * This loader implements the standard {@link LocalInferenceLoader} contract, so
 * the TEXT_SMALL / TEXT_LARGE handlers in `ensure-local-inference-handler.ts`
 * route through it transparently. `generate()` sends the prompt to the bionic
 * host over an abstract-namespace `AF_UNIX` socket and gets the GPU completion
 * back — the whole decode loop runs server-side, so there is no per-token
 * two-process round trip.
 *
 * Two generate shapes share the framing (#11913):
 *   - buffered (no `onTextChunk`): one GENERATE request → one full completion;
 *   - streaming (`onTextChunk` set): op="generateStream" server-pushes one
 *     {type:"token",text} frame per bounded decode step on the same
 *     connection, then a terminal {type:"done",…} frame — so the first chunk
 *     arrives at token cadence and TTFT decouples from full-turn latency.
 */

import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import {
	BGE_SMALL_VECTOR_SPACE,
	ElizaError,
	identifyEmbeddingVector,
	logger,
} from "@elizaos/core";
import { BGE_EMBEDDING_MODEL } from "@elizaos/plugin-native-inference/model-catalog/bge-embedding-model";
import {
	assertBgeTokenAgreement,
	prepareBgeEmbeddingInput,
} from "@elizaos/plugin-native-inference/model-catalog/bge-input";
import {
	normalizeEmbeddingVector,
	verifyBgeEmbeddingFile,
} from "../runtime/embedding-vector-space";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";
import {
	type BionicAsrStream,
	bionicAsrOneShot,
	bionicSocketPath,
	openBionicAsrStream,
} from "./bionic-asr-stream";
import { mergeElizaTurnStopSequences } from "./eliza-turn-stops";
import { elizaModelsDir } from "./paths";
import {
	BionicStreamingTranscriber,
	type BionicStreamingTranscriberOptions,
} from "./voice/bionic-streaming-transcriber";

/** Connect + full round-trip budget. A cold GPU decode of a long reply fits. */
const REQUEST_TIMEOUT_MS = 120000;
/** Defensive ceiling on a single response frame (a full completion). */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FLAT_ELIZA_1_GGUF_RE = /^eliza-1-[a-z0-9_.-]+\.gguf$/i;
const BIONIC_FLAT_BUNDLE_DIR = ".bionic-bundles";
interface BionicGenerateResponse {
	ok: boolean;
	text?: string;
	error?: string;
	tokens?: number;
	ms?: number;
	tokS?: number;
	incomplete?: boolean;
	finishReason?: string;
}
/**
 * One server-push frame of the op="generateStream" reply: {type:"token",text}
 * per bounded decode step, then a terminal {type:"done", ok, tokens, ms, tokS,
 * text} frame (the buffered-response shape plus the discriminator).
 */
interface BionicStreamFrame {
	type?: string;
	text?: string;
	ok?: boolean;
	error?: string;
	tokens?: number;
	ms?: number;
	tokS?: number;
	incomplete?: boolean;
	finishReason?: string;
}
/** op="tts" response: base64 little-endian fp32 PCM at `sampleRate`. */
interface BionicTtsResponse {
	ok: boolean;
	sampleRate?: number;
	samples?: number;
	pcmBase64?: string;
	error?: string;
	cancelled?: boolean;
}
/** Longest text one op="tts" request may carry (the host chunks it natively). */
export const BIONIC_TTS_MAX_TEXT_CHARS = 4000;
/** Longest audio one op="tts" response may carry. */
const BIONIC_TTS_MAX_SECONDS = 120;
/** {ok, text} response for the asr / image ops (transcript / description). */
interface BionicTextResponse {
	ok: boolean;
	text?: string;
	error?: string;
}
/**
 * Derive the fused-bundle root from a model GGUF path. The host's
 * `eliza_inference_create(bundleDir)` expects the directory that contains
 * `text/<model>.gguf`; when the installed model is laid out that way we forward
 * it. Android smoke and first-run paths can stage the curated Eliza-1 text GGUF
 * flat under `local-inference/models/`, so for those files we create a hidden
 * hardlink/symlink bundle view without copying the multi-GB model bytes.
 */
export function deriveBundleDir(modelPath: string): string {
	if (!modelPath) return "";
	const dir = path.dirname(modelPath);
	if (path.basename(dir) === "text") return path.dirname(dir);
	if (!FLAT_ELIZA_1_GGUF_RE.test(path.basename(modelPath))) return "";
	if (!existsSync(modelPath)) return "";
	const modelName = path.basename(modelPath);
	const bundleRoot = path.join(
		dir,
		BIONIC_FLAT_BUNDLE_DIR,
		path.basename(modelName, path.extname(modelName)),
	);
	const textDir = path.join(bundleRoot, "text");
	const stagedPath = path.join(textDir, modelName);
	try {
		mkdirSync(textDir, { recursive: true });
		if (existsSync(stagedPath)) {
			try {
				const source = statSync(modelPath);
				const staged = statSync(stagedPath);
				if (source.size === staged.size) return bundleRoot;
			} catch {
				// Recreate stale or broken aliases below.
			}
			unlinkSync(stagedPath);
		}
		try {
			linkSync(modelPath, stagedPath);
		} catch {
			symlinkSync(modelPath, stagedPath);
		}
		return bundleRoot;
	} catch (err) {
		logger.warn(
			`[BionicHostLoader] could not stage bionic bundle view for flat model "${modelPath}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return "";
}
export class BionicHostLoader implements LocalInferenceLoader {
	private modelPath: string | null = null;
	private bundleDir = "";
	private embeddingModelPath: string | null = null;
	private embeddingBundleDir = "";
	/** @param socketName abstract-namespace socket name (no leading NUL). */
	constructor(private readonly socketName: string) {}
	async prepareEmbeddingModel(modelPath?: string): Promise<void> {
		const configured =
			modelPath ??
			path.resolve(
				process.env.MODELS_DIR?.trim() || elizaModelsDir(),
				process.env.LOCAL_EMBEDDING_MODEL?.trim() ||
					BGE_EMBEDDING_MODEL.filename,
			);
		if (configured.includes("\0")) {
			throw new ElizaError("Embedding model path contains NUL", {
				code: "EMBEDDING_ARTIFACT_INVALID",
			});
		}
		const absolute = path.resolve(configured);
		if (this.embeddingModelPath === absolute) return;
		try {
			verifyBgeEmbeddingFile(absolute);
			const bundle = `${absolute}.embedding.bundle`;
			const textDir = path.join(bundle, "text");
			mkdirSync(textDir, { recursive: true });
			const target = path.join(textDir, BGE_EMBEDDING_MODEL.filename);
			if (!existsSync(target)) symlinkSync(absolute, target);
			const candidates = readdirSync(textDir);
			if (
				candidates.length !== 1 ||
				candidates[0] !== BGE_EMBEDDING_MODEL.filename ||
				!statSync(target).isFile()
			) {
				throw new ElizaError(
					"Bionic embeddings require an isolated BGE bundle",
					{ code: "EMBEDDING_ARTIFACT_INVALID" },
				);
			}
			verifyBgeEmbeddingFile(target);
			this.embeddingBundleDir = bundle;
			this.embeddingModelPath = absolute;
		} catch (cause) {
			// error-policy:J2 Preserve artifact failures at the embedding activation boundary.
			throw new ElizaError(
				"Install the pinned BGE-small artifact before using Bionic embeddings",
				{
					code: "EMBEDDING_MODEL_UNAVAILABLE",
					cause,
					context: { modelPath: absolute },
				},
			);
		}
	}
	async embed(args: { input: string }): Promise<{
		embedding: number[];
		tokens: number;
	}> {
		if (Buffer.from(args.input, "utf8").toString("utf8") !== args.input) {
			throw new ElizaError(
				"Embedding input contains unpaired UTF-16 surrogates",
				{ code: "EMBEDDING_INPUT_INVALID" },
			);
		}
		if (!this.embeddingModelPath) await this.prepareEmbeddingModel();
		const prepared = prepareBgeEmbeddingInput(args.input);
		const request = {
			op: "embed",
			bundleDir: this.embeddingBundleDir,
			text: prepared.text,
			expectedTokenIds: prepared.tokenIds,
			embeddingSpace: BGE_SMALL_VECTOR_SPACE,
		};
		const byteLength = Buffer.byteLength(JSON.stringify(request), "utf8");
		if (byteLength > 1 << 20) {
			throw new ElizaError(
				"Complete embedding request exceeds the Android host frame limit; split the source into explicit lossless chunks",
				{
					code: "EMBEDDING_INPUT_TOO_LARGE",
					context: { byteLength, limit: 1 << 20 },
				},
			);
		}
		const wireResponse = await this.roundTrip<unknown>(request);
		if (
			!wireResponse ||
			typeof wireResponse !== "object" ||
			Array.isArray(wireResponse)
		) {
			throw new ElizaError(
				"Bionic host returned a malformed embedding response",
				{ code: "EMBEDDING_VECTOR_INVALID" },
			);
		}
		const response = wireResponse as Record<string, unknown>;
		if (response.ok !== true) {
			throw new ElizaError(
				typeof response.error === "string"
					? response.error
					: "Bionic embedding failed",
				{
					code:
						typeof response.code === "string"
							? response.code
							: "EMBEDDING_BACKEND_UNAVAILABLE",
				},
			);
		}
		const vector = response.embedding;
		const tokens = response.tokens;
		const tokenIds = response.tokenIds;
		if (
			response.embeddingSpace !== BGE_SMALL_VECTOR_SPACE ||
			!Array.isArray(vector) ||
			vector.length !== BGE_EMBEDDING_MODEL.dimensions ||
			!vector.every(
				(value): value is number =>
					typeof value === "number" && Number.isFinite(value),
			) ||
			typeof tokens !== "number" ||
			!Number.isInteger(tokens) ||
			tokens !== prepared.tokenIds.length ||
			!Array.isArray(tokenIds) ||
			!tokenIds.every(
				(id): id is number =>
					typeof id === "number" && Number.isInteger(id) && id >= 0,
			) ||
			tokens < 1 ||
			tokens > BGE_EMBEDDING_MODEL.contextSize
		) {
			throw new ElizaError(
				"Bionic host returned invalid BGE embedding provenance or data",
				{ code: "EMBEDDING_VECTOR_INVALID" },
			);
		}
		assertBgeTokenAgreement(prepared, tokenIds);
		return {
			embedding: identifyEmbeddingVector(
				normalizeEmbeddingVector(vector),
				BGE_SMALL_VECTOR_SPACE,
			),
			tokens,
		};
	}
	async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
		this.modelPath = args.modelPath;
		this.bundleDir = deriveBundleDir(args.modelPath);
		logger.info(
			`[BionicHostLoader] active model ${args.modelPath} (bundle ${this.bundleDir || "<host-default>"})`,
		);
	}
	async unloadModel(): Promise<void> {
		this.modelPath = null;
	}
	currentModelPath(): string | null {
		return this.modelPath;
	}
	async generate(args: {
		prompt: string;
		stopSequences?: string[];
		maxTokens?: number;
		temperature?: number;
		cacheKey?: string;
		onTextChunk?: (chunk: string) => void | Promise<void>;
		maxTokensPerStep?: number;
	}): Promise<string> {
		// This is the final agent-side boundary before native decoding. Keep the
		// Eliza turn markers mandatory here even if an alternate runtime route
		// omitted them upstream, so the host cannot decode into the next role.
		const stopSequences = mergeElizaTurnStopSequences(args.stopSequences);
		const request = {
			bundleDir: this.bundleDir,
			prompt: args.prompt,
			...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
			temperature: args.temperature ?? 0,
			stopSequences,
		};
		// Streaming shape when the runtime wired a chunk callback (chat SSE /
		// voice): the host pushes one frame per bounded decode step, so the
		// first chunk lands at token cadence instead of after the whole reply.
		const res = args.onTextChunk
			? await this.streamRoundTrip(
					typeof args.maxTokensPerStep === "number" && args.maxTokensPerStep > 0
						? {
								op: "generateStream",
								...request,
								streamStep: Math.floor(args.maxTokensPerStep),
							}
						: { op: "generateStream", ...request },
					args.onTextChunk,
				)
			: await this.roundTrip<BionicGenerateResponse>({
					op: "generate",
					...request,
				});
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host generate failed: ${res.error ?? "unknown error"}`,
			);
		}
		if (
			res.incomplete === true ||
			(typeof res.tokens === "number" &&
				typeof request.maxTokens === "number" &&
				res.tokens >= request.maxTokens)
		) {
			throw new ElizaError(
				"Bionic local model output reached the decode boundary before a stop condition",
				{
					code: "MODEL_OUTPUT_INCOMPLETE",
					context: {
						maxTokens: request.maxTokens ?? null,
						outputTokens: res.tokens,
						finishReason: res.finishReason ?? null,
					},
				},
			);
		}
		if (typeof res.tokS === "number") {
			logger.debug(
				`[BionicHostLoader] generated ${res.tokens ?? "?"} tok @ ${res.tokS.toFixed(1)} tok/s on the bionic GPU host`,
			);
		}
		return res.text ?? "";
	}
	/**
	 * On-device STT: transcribe mono fp32 PCM via the bionic host's fused
	 * libelizainference ASR (op="asr") over the bundle's `asr/` model
	 * (Phonon-2). Live voice should prefer
	 * `openAsrStream()`; this batch call is the fallback when it returns null. The musl agent
	 * can't load the fused lib, so the TRANSCRIPTION delegate routes the audio
	 * here over the UDS and gets the transcript back. `pcm` is little-endian
	 * fp32 already base64-encoded. Aborting `signal` sends op="asr_cancel",
	 * which stops the native decode, and rejects with the abort reason.
	 */
	async transcribe(args: {
		pcmBase64: string;
		sampleRate: number;
		signal?: AbortSignal;
	}): Promise<string> {
		this.assertAsrBundle();
		const res = await this.cancellableRoundTrip<BionicTextResponse>(
			{
				op: "asr",
				bundleDir: this.bundleDir,
				pcmBase64: args.pcmBase64,
				sampleRate: args.sampleRate,
			},
			"asr_cancel",
			args.signal,
		);
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host asr failed: ${res.error ?? "unknown error"}`,
			);
		}
		return res.text ?? "";
	}
	/** Refuse ASR on a missing or non-pinned bundle (shared by batch and streaming). */
	private assertAsrBundle(): void {
		if (!this.bundleDir || !bundleHasAsrModelFiles(this.bundleDir)) {
			throw new Error(
				"[BionicHostLoader] host asr requires an active bundle with an asr/ model (the Phonon-2 GGUF); refusing to use the bionic host default bundle",
			);
		}
		const blockers = readBundleAsrProvenanceBlockers(this.bundleDir);
		if (blockers.length > 0) {
			throw new Error(
				`[BionicHostLoader] host asr refused non-Gemma ASR provenance: ${blockers.join("; ")}`,
			);
		}
	}
	/**
	 * Whether the host's ASR backend streams (op="asr_stream_supported"). The
	 * host acquires the bundle's asr/ region first, so this is accurate on a
	 * cold context: true for Phonon-2 (parakeet), false only for a host
	 * library built without the Parakeet-TDT backend.
	 */
	async asrStreamSupported(): Promise<boolean> {
		this.assertAsrBundle();
		const res = await bionicAsrOneShot(bionicSocketPath(this.socketName), {
			op: "asr_stream_supported",
			bundleDir: this.bundleDir,
		});
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host asr_stream_supported failed: ${res.error ?? "unknown error"}`,
			);
		}
		return res.supported === true;
	}
	/**
	 * Open a streaming ASR session on the host (op="asr_stream_open") for
	 * mono fp32 PCM at `sampleRate`. Resolves null only when the host's
	 * backend reports it cannot stream; callers then use `transcribe()`.
	 */
	async openAsrStream(args: {
		sampleRate: number;
	}): Promise<BionicAsrStream | null> {
		this.assertAsrBundle();
		return openBionicAsrStream({
			socketPath: bionicSocketPath(this.socketName),
			bundleDir: this.bundleDir,
			sampleRate: args.sampleRate,
		});
	}
	/**
	 * Live transcription through the host: a `StreamingTranscriber` that emits
	 * partials from `asr_stream_*` and uses batch op="asr" only when the
	 * host's ASR backend cannot stream. Caller owns `dispose()`.
	 */
	createStreamingTranscriber(
		opts: Omit<BionicStreamingTranscriberOptions, "host"> = {},
	): BionicStreamingTranscriber {
		return new BionicStreamingTranscriber({ ...opts, host: this });
	}
	/**
	 * On-device TTS: send the text to the bionic host (op="tts"), which runs
	 * the fused Paradee-8M head with its native misaki G2P over the bundle's
	 * `tts/paradee/` files and returns mono fp32 PCM. Aborting `signal` sends
	 * op="tts_cancel" (eliza_inference_cancel_tts on the host context) and
	 * rejects with the abort reason.
	 */
	async synthesize(args: {
		text: string;
		speed?: number;
		signal?: AbortSignal;
	}): Promise<{ pcm: Float32Array; sampleRate: number }> {
		const text = args.text.trim();
		if (!text) {
			throw new Error("[BionicHostLoader] host tts requires non-empty text");
		}
		if (!this.bundleDir) {
			// Same rule as transcribe: an empty bundleDir would make the host
			// synthesize from its own default bundle, not the active one.
			throw new Error(
				"[BionicHostLoader] host tts requires an active bundle (tts/paradee/); refusing to use the bionic host default bundle",
			);
		}
		if (text.length > BIONIC_TTS_MAX_TEXT_CHARS) {
			throw new Error(
				`[BionicHostLoader] host tts text exceeds ${BIONIC_TTS_MAX_TEXT_CHARS} characters; split it into sentences`,
			);
		}
		const speed = args.speed ?? 1;
		if (!Number.isFinite(speed) || speed <= 0) {
			throw new Error("[BionicHostLoader] host tts speed must be positive");
		}
		const res = await this.cancellableRoundTrip<BionicTtsResponse>(
			{
				op: "tts",
				bundleDir: this.bundleDir,
				text,
				language: "en-US",
				speed,
			},
			"tts_cancel",
			args.signal,
		);
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host tts failed: ${res.error ?? "unknown error"}`,
			);
		}
		const sampleRate = res.sampleRate;
		if (
			typeof sampleRate !== "number" ||
			!Number.isInteger(sampleRate) ||
			sampleRate < 8000 ||
			sampleRate > 96000 ||
			typeof res.pcmBase64 !== "string"
		) {
			throw new Error(
				"[BionicHostLoader] host tts returned a malformed response",
			);
		}
		const bytes = Buffer.from(res.pcmBase64, "base64");
		const samples = bytes.length / 4;
		if (
			bytes.length === 0 ||
			!Number.isInteger(samples) ||
			(typeof res.samples === "number" && res.samples !== samples) ||
			samples > BIONIC_TTS_MAX_SECONDS * sampleRate
		) {
			throw new Error(
				`[BionicHostLoader] host tts returned ${bytes.length} PCM bytes for ${res.samples ?? "?"} samples`,
			);
		}
		const pcm = new Float32Array(samples);
		for (let i = 0; i < samples; i++) {
			const value = bytes.readFloatLE(i * 4);
			if (!Number.isFinite(value)) {
				throw new Error(
					"[BionicHostLoader] host tts returned a non-finite sample",
				);
			}
			pcm[i] = value;
		}
		return { pcm, sampleRate };
	}
	/**
	 * Round trip whose in-flight native work can be cancelled: when `signal`
	 * aborts, `cancelOp` is sent on a second connection (the host sets the
	 * engine's cancel flag on its resident context) and the call rejects with
	 * the abort reason without waiting for the first response.
	 */
	private cancellableRoundTrip<T>(
		request: Record<string, unknown>,
		cancelOp: "tts_cancel" | "asr_cancel",
		signal?: AbortSignal,
	): Promise<T> {
		const abortError = () =>
			signal?.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		if (signal?.aborted) return Promise.reject(abortError());
		const pending = this.roundTrip<T>(request);
		if (!signal) return pending;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				this.roundTrip<BionicTextResponse>({
					op: cancelOp,
					bundleDir: this.bundleDir,
				}).catch((err: unknown) => {
					logger.warn(
						`[BionicHostLoader] ${cancelOp} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
				reject(abortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(err: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}
	/**
	 * On-device vision / screen-recognition: describe a raw image (PNG/JPEG/WebP
	 * bytes, base64) via the bionic host's mmproj describe-image (op="image").
	 * `mmprojPath` may be empty — the host resolves the projector from the
	 * bundle's `vision/` dir.
	 */
	async describeImage(args: {
		imageBase64: string;
		mmprojPath?: string;
		prompt?: string;
	}): Promise<string> {
		const res = await this.roundTrip<BionicTextResponse>({
			op: "image",
			bundleDir: this.bundleDir,
			imageBase64: args.imageBase64,
			mmprojPath: args.mmprojPath ?? "",
			prompt: args.prompt ?? "",
		});
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host image describe failed: ${res.error ?? "unknown error"}`,
			);
		}
		return res.text ?? "";
	}
	/**
	 * One request → one response over a fresh connection. Length-prefixed frames:
	 * `[int32 BE byte length][UTF-8 JSON]` in each direction.
	 */
	private roundTrip<T>(request: Record<string, unknown>): Promise<T> {
		const payload = Buffer.from(JSON.stringify(request), "utf8");
		const frame = Buffer.allocUnsafe(4 + payload.length);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);
		return new Promise<T>((resolve, reject) => {
			// Abstract-namespace socket: a leading NUL byte in the path.
			const sock = net.connect({ path: bionicSocketPath(this.socketName) });
			let settled = false;
			let chunks: Buffer = Buffer.alloc(0);
			let expected = -1;
			const finish = (err: Error | null, value?: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				sock.destroy();
				if (err) reject(err);
				else resolve(value as T);
			};
			const timer = setTimeout(
				() => finish(new Error("[BionicHostLoader] request timed out")),
				REQUEST_TIMEOUT_MS,
			);
			sock.on("connect", () => sock.write(frame));
			sock.on("data", (d: Buffer) => {
				chunks = Buffer.concat([chunks, d]);
				if (expected < 0 && chunks.length >= 4) {
					expected = chunks.readUInt32BE(0);
					if (expected < 0 || expected > MAX_FRAME_BYTES) {
						finish(
							new Error(
								`[BionicHostLoader] bad response frame length ${expected}`,
							),
						);
						return;
					}
				}
				if (expected >= 0 && chunks.length >= 4 + expected) {
					const json = chunks.subarray(4, 4 + expected).toString("utf8");
					try {
						finish(null, JSON.parse(json) as T);
					} catch (e) {
						finish(
							new Error(
								`[BionicHostLoader] malformed response: ${e instanceof Error ? e.message : String(e)}`,
							),
						);
					}
				}
			});
			sock.on("error", (e: Error) =>
				finish(new Error(`[BionicHostLoader] socket error: ${e.message}`)),
			);
			sock.on("close", () => {
				if (!settled)
					finish(
						new Error(
							"[BionicHostLoader] host closed the connection before responding",
						),
					);
			});
		});
	}
	/**
	 * One request → MANY server-pushed frames over a fresh connection
	 * (op="generateStream"): each {type:"token",text} frame is forwarded to
	 * `onTextChunk` in arrival order (async callbacks are chained so ordering
	 * holds), and the terminal {type:"done",…} frame resolves with the
	 * buffered-response shape. The timeout is per-frame idle, not whole-turn:
	 * a healthy decode emits a frame every few hundred ms, so a long reply
	 * never times out while frames keep flowing.
	 */
	private streamRoundTrip(
		request: Record<string, unknown>,
		onTextChunk: (chunk: string) => void | Promise<void>,
	): Promise<BionicGenerateResponse> {
		const payload = Buffer.from(JSON.stringify(request), "utf8");
		const frame = Buffer.allocUnsafe(4 + payload.length);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);
		return new Promise<BionicGenerateResponse>((resolve, reject) => {
			const sock = net.connect({ path: bionicSocketPath(this.socketName) });
			let settled = false;
			let chunks: Buffer = Buffer.alloc(0);
			// Serialize (possibly async) chunk callbacks so consumers see the
			// decode order; the terminal resolve waits for the chain so every
			// chunk lands before the full text does. Failures are captured
			// inside the chain (each link is caught) so a throwing consumer
			// rejects the turn without ever leaving an unhandled rejection.
			let chunkChain: Promise<void> = Promise.resolve();
			let chunkFailure: Error | null = null;
			const finish = (err: Error | null, value?: BionicGenerateResponse) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				sock.destroy();
				if (err) {
					reject(err);
					return;
				}
				void chunkChain.then(() => {
					if (chunkFailure) {
						reject(
							new Error(
								`[BionicHostLoader] onTextChunk failed: ${chunkFailure.message}`,
							),
						);
					} else {
						resolve(value as BionicGenerateResponse);
					}
				});
			};
			let timer = setTimeout(
				() => finish(new Error("[BionicHostLoader] stream request timed out")),
				REQUEST_TIMEOUT_MS,
			);
			const bumpIdleTimer = () => {
				clearTimeout(timer);
				timer = setTimeout(
					() =>
						finish(new Error("[BionicHostLoader] stream stalled (no frames)")),
					REQUEST_TIMEOUT_MS,
				);
			};
			sock.on("connect", () => sock.write(frame));
			sock.on("data", (d: Buffer) => {
				chunks = Buffer.concat([chunks, d]);
				// Drain every complete frame currently buffered.
				for (;;) {
					if (chunks.length < 4) break;
					const expected = chunks.readUInt32BE(0);
					if (expected < 0 || expected > MAX_FRAME_BYTES) {
						finish(
							new Error(`[BionicHostLoader] bad stream frame ${expected}`),
						);
						return;
					}
					if (chunks.length < 4 + expected) break;
					const json = chunks.subarray(4, 4 + expected).toString("utf8");
					chunks = chunks.subarray(4 + expected);
					bumpIdleTimer();
					let msg: BionicStreamFrame;
					try {
						msg = JSON.parse(json) as BionicStreamFrame;
					} catch (e) {
						finish(
							new Error(
								`[BionicHostLoader] malformed stream frame: ${e instanceof Error ? e.message : String(e)}`,
							),
						);
						return;
					}
					if (msg.type === "token") {
						const text = msg.text;
						if (typeof text === "string" && text.length > 0) {
							chunkChain = chunkChain
								.then(() => (chunkFailure ? undefined : onTextChunk(text)))
								.catch((chunkErr: unknown) => {
									if (!chunkFailure) {
										chunkFailure =
											chunkErr instanceof Error
												? chunkErr
												: new Error(String(chunkErr));
									}
								});
						}
						continue;
					}
					// Terminal {type:"done"} frame (or any non-token frame, e.g. a
					// top-level {ok:false} error) ends the stream.
					finish(null, {
						ok: msg.ok === true,
						text: msg.text,
						error: msg.error,
						tokens: msg.tokens,
						ms: msg.ms,
						tokS: msg.tokS,
						incomplete: msg.incomplete,
						finishReason: msg.finishReason,
					});
					return;
				}
			});
			sock.on("error", (e: Error) =>
				finish(new Error(`[BionicHostLoader] socket error: ${e.message}`)),
			);
			sock.on("close", () => {
				if (!settled)
					finish(
						new Error(
							"[BionicHostLoader] host closed the stream before the done frame",
						),
					);
			});
		});
	}
}
