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
 * This is the buffered first slice (one GENERATE request → one full completion).
 * Server-push per-step streaming, embed, and cancel are layered on later via the
 * shared `LlmStreamingBinding`; the wire framing already carries an `op`
 * discriminator for that.
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
	}): Promise<string> {
		const res = await this.roundTrip<BionicGenerateResponse>({
			op: "generate",
			bundleDir: this.bundleDir,
			prompt: args.prompt,
			maxTokens: args.maxTokens ?? 256,
			temperature: args.temperature ?? 0,
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
}
