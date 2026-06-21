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

import net from "node:net";
import path from "node:path";
import { logger } from "@elizaos/core";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";

/** Connect + full round-trip budget. A cold GPU decode of a long reply fits. */
const REQUEST_TIMEOUT_MS = 120_000;
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
 * Derive the fused-bundle root from a model GGUF path. The host's
 * `eliza_inference_create(bundleDir)` expects the directory that contains
 * `text/<model>.gguf`; when the installed model is laid out that way we forward
 * it, otherwise we send empty and let the host fall back to its default bundle.
 */
function deriveBundleDir(modelPath: string): string {
	if (!modelPath) return "";
	const dir = path.dirname(modelPath);
	if (path.basename(dir) === "text") return path.dirname(dir);
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
