/**
 * BionicHostLoader — the agent-side half of the on-device GPU delegation path.
 *
 * On Android the elizaOS agent runs as embedded bun under the musl loader, whose
 * restricted linker namespace cannot load the bionic Android Vulkan driver (its
 * HIDL/HAL closure) — so the musl agent can only run inference on the CPU. The
 * GPU is reachable only from the normal bionic `ai.elizaos.app` process, where
 * `ElizaBionicInferenceServer` (Java) has loaded `libelizainference.so` +
 * `libggml-vulkan.so` and offloads the model to the Mali GPU.
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
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { logger } from "@elizaos/core";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";

/** Connect + full round-trip budget. A cold GPU decode of a long reply fits. */
const REQUEST_TIMEOUT_MS = 120_000;
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
}

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

	/** @param socketName abstract-namespace socket name (no leading NUL). */
	constructor(private readonly socketName: string) {}

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
		const request = {
			bundleDir: this.bundleDir,
			prompt: args.prompt,
			maxTokens: args.maxTokens ?? 256,
			temperature: args.temperature ?? 0,
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
		if (typeof res.tokS === "number") {
			logger.debug(
				`[BionicHostLoader] generated ${res.tokens ?? "?"} tok @ ${res.tokS.toFixed(1)} tok/s on the bionic GPU host`,
			);
		}
		return res.text ?? "";
	}

	/**
	 * On-device STT: transcribe mono fp32 PCM via the bionic host's fused
	 * Gemma ASR path (op="asr"). The musl agent can't load the fused lib, so
	 * the TRANSCRIPTION delegate routes the audio here over the UDS and gets
	 * the transcript back. `pcm` is little-endian fp32 already base64-encoded.
	 */
	async transcribe(args: {
		pcmBase64: string;
		sampleRate: number;
	}): Promise<string> {
		if (!this.bundleDir || !bundleHasAsrModelFiles(this.bundleDir)) {
			throw new Error(
				"[BionicHostLoader] host asr requires an active Gemma ASR-capable bundle; refusing to use the bionic host default bundle",
			);
		}
		const blockers = readBundleAsrProvenanceBlockers(this.bundleDir);
		if (blockers.length > 0) {
			throw new Error(
				`[BionicHostLoader] host asr refused non-Gemma ASR provenance: ${blockers.join("; ")}`,
			);
		}
		const res = await this.roundTrip<BionicTextResponse>({
			op: "asr",
			bundleDir: this.bundleDir,
			pcmBase64: args.pcmBase64,
			sampleRate: args.sampleRate,
		});
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host asr failed: ${res.error ?? "unknown error"}`,
			);
		}
		return res.text ?? "";
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
			const sock = net.connect({ path: `\0${this.socketName}` });
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
			const sock = net.connect({ path: `\0${this.socketName}` });
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
