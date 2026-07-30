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
 * text generation and speech synthesis route through it transparently.
 * `generate()` sends prompts to the bionic host; `synthesizeSpeech()` performs
 * cached mobile phonemization in the agent and sends IPA to native Kokoro. The
 * model loops remain server-side, avoiding per-token or per-sample process
 * round trips.
 *
 * Two generate shapes share the framing (#11913):
 *   - buffered (no `onTextChunk`): one GENERATE request → one full completion;
 *   - streaming (`onTextChunk` set): op="generateStream" server-pushes one
 *     {type:"token",text} frame per bounded decode step on the same
 *     connection, then a terminal {type:"done",…} frame — so the first chunk
 *     arrives at token cadence and TTFT decouples from full-turn latency.
 */

import net from "node:net";
import { logger } from "@elizaos/core";
import { deriveBionicBundleDir } from "@elizaos/shared/bionic-bundle-view";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";
import { resolvePhonemizer } from "./voice/kokoro/phonemizer";

/** Defensive ceiling on a single response frame (a full completion). */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

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

interface BionicTtsResponse {
	ok: boolean;
	sampleRate?: number;
	wavBase64?: string;
	error?: string;
	timings?: {
		lockWaitMs?: number;
		contextMs?: number;
		synthesisMs?: number;
		encodeMs?: number;
		totalMs?: number;
	};
}

interface BionicEmbedResponse {
	ok: boolean;
	embedding?: unknown;
	dim?: number;
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
	try {
		return deriveBionicBundleDir(modelPath);
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
	private phonemizerPromise: ReturnType<typeof resolvePhonemizer> | null = null;

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

	/** Embed text through the same resident fused context used for generation. */
	async embed(args: {
		input: string;
		signal?: AbortSignal;
	}): Promise<{ embedding: number[]; tokens?: number }> {
		const res = await this.roundTrip<BionicEmbedResponse>(
			{
				op: "embed",
				bundleDir: this.bundleDir,
				text: args.input,
			},
			{ signal: args.signal },
		);
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host embed failed: ${res.error ?? "unknown error"}`,
			);
		}
		if (
			!Array.isArray(res.embedding) ||
			res.embedding.length === 0 ||
			res.embedding.some(
				(value) => typeof value !== "number" || !Number.isFinite(value),
			) ||
			(typeof res.dim === "number" && res.dim !== res.embedding.length)
		) {
			throw new Error(
				"[BionicHostLoader] host embed returned an invalid embedding",
			);
		}
		return { embedding: res.embedding as number[] };
	}

	/**
	 * Synthesize intelligible Android speech through the bionic host. The musl
	 * agent owns fast cached English phonemization; the Android fused library
	 * receives IPA through its ABI-v15 entry because that build deliberately
	 * omits espeak-ng. The request socket is tied to the caller's AbortSignal so
	 * barge-in closes IPC immediately instead of waiting for a timeout.
	 */
	async synthesizeSpeech(
		text: string,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		signal?.throwIfAborted();
		const startedAt = performance.now();
		this.phonemizerPromise ??= resolvePhonemizer();
		const phonemizer = await this.phonemizerPromise;
		const phonemizerReadyAt = performance.now();
		const phonemes = await phonemizer.phonemize(text, "a");
		const phonemizedAt = performance.now();
		signal?.throwIfAborted();
		const res = await this.roundTrip<BionicTtsResponse>(
			{
				op: "tts",
				bundleDir: this.bundleDir,
				text,
				ipa: phonemes.phonemes,
				speed: 1,
			},
			{ signal },
		);
		const hostReturnedAt = performance.now();
		if (!res.ok) {
			throw new Error(
				`[BionicHostLoader] host TTS failed: ${res.error ?? "unknown error"}`,
			);
		}
		if (
			typeof res.sampleRate !== "number" ||
			res.sampleRate <= 0 ||
			typeof res.wavBase64 !== "string" ||
			res.wavBase64.length === 0
		) {
			throw new Error("[BionicHostLoader] host TTS returned malformed WAV");
		}
		const wav = Buffer.from(res.wavBase64, "base64");
		if (wav.length < 44 || wav.subarray(0, 4).toString("ascii") !== "RIFF") {
			throw new Error("[BionicHostLoader] host TTS returned invalid WAV bytes");
		}
		logger.info(
			`[BionicHostLoader] TTS telemetry phonemizer=${phonemizer.id} resolve=${Math.round(phonemizerReadyAt - startedAt)}ms phonemize=${Math.round(phonemizedAt - phonemizerReadyAt)}ms hostRoundTrip=${Math.round(hostReturnedAt - phonemizedAt)}ms host=${JSON.stringify(res.timings ?? {})} total=${Math.round(hostReturnedAt - startedAt)}ms`,
		);
		return wav;
	}

	async generate(args: {
		prompt: string;
		stopSequences?: string[];
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
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
		// A buffered native decode cannot observe that its client disconnected
		// until the entire reply finishes. When cancellation is owned by a
		// caller, use the framed streaming operation even if that caller does
		// not consume chunks: each bounded host write becomes a disconnect
		// checkpoint and stops orphaned native work after at most one step.
		const chunkConsumer =
			args.onTextChunk ?? (args.signal ? () => undefined : undefined);
		const res = chunkConsumer
			? await this.streamRoundTrip(
					typeof args.maxTokensPerStep === "number" && args.maxTokensPerStep > 0
						? {
								op: "generateStream",
								...request,
								streamStep: Math.floor(args.maxTokensPerStep),
							}
						: { op: "generateStream", ...request },
					chunkConsumer,
					args.signal,
				)
			: await this.roundTrip<BionicGenerateResponse>(
					{
						op: "generate",
						...request,
					},
					{ signal: args.signal },
				);
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
	private roundTrip<T>(
		request: Record<string, unknown>,
		options: { signal?: AbortSignal } = {},
	): Promise<T> {
		const payload = Buffer.from(JSON.stringify(request), "utf8");
		const frame = Buffer.allocUnsafe(4 + payload.length);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);

		return new Promise<T>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			// Abstract-namespace socket: a leading NUL byte in the path.
			const sock = net.connect({ path: `\0${this.socketName}` });
			let settled = false;
			let chunks: Buffer = Buffer.alloc(0);
			let expected = -1;
			let abort = () => {};

			const finish = (err: Error | null, value?: T) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				sock.destroy();
				if (err) reject(err);
				else resolve(value as T);
			};

			abort = () =>
				finish(
					options.signal?.reason instanceof Error
						? options.signal.reason
						: new DOMException("The operation was aborted", "AbortError"),
				);
			options.signal?.addEventListener("abort", abort, { once: true });

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
	 * buffered-response shape. Cancellation belongs to the caller because model
	 * size, device load, and reply length make a transport-level wall-clock
	 * deadline arbitrary; socket failures still reject the request directly.
	 */
	private streamRoundTrip(
		request: Record<string, unknown>,
		onTextChunk: (chunk: string) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<BionicGenerateResponse> {
		const payload = Buffer.from(JSON.stringify(request), "utf8");
		const frame = Buffer.allocUnsafe(4 + payload.length);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);

		return new Promise<BionicGenerateResponse>((resolve, reject) => {
			if (signal?.aborted) {
				reject(
					signal.reason instanceof Error
						? signal.reason
						: new DOMException("The operation was aborted", "AbortError"),
				);
				return;
			}
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
			let abort = () => {};

			const finish = (err: Error | null, value?: BionicGenerateResponse) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
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

			abort = () =>
				finish(
					signal?.reason instanceof Error
						? signal.reason
						: new DOMException("The operation was aborted", "AbortError"),
				);
			signal?.addEventListener("abort", abort, { once: true });

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
										finish(
											new Error(
												`[BionicHostLoader] onTextChunk failed: ${chunkFailure.message}`,
											),
										);
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
