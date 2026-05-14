/**
 * Core ML image-gen backend stub (WS3) — iOS via Capacitor bridge.
 *
 * The contract for the Swift side. The real implementation lives in
 * `eliza/packages/app-core/platforms/ios/App/App/ImageGenBridge.swift`
 * (skeleton written under `// MARK: - Contract`). At runtime the iOS
 * plugin (`@elizaos/plugin-ios-local-inference`) registers a Capacitor
 * service that exposes:
 *
 *   await Capacitor.Plugins.ElizaImageGen.generateImage({
 *     modelKey: "imagegen-coreml-sd-1_5",
 *     prompt: "<text>",
 *     negativePrompt: "<text>",   // optional
 *     width: 512,
 *     height: 512,
 *     steps: 20,
 *     guidanceScale: 7.5,
 *     seed: 42                    // -1 = random
 *   })
 *     -> { png: "<base64>", seed: number, inferenceTimeMs: number }
 *
 * Swift side uses `apple/ml-stable-diffusion` Swift package directly;
 * the `.mlpackage` directories are dropped into the app's Documents
 * folder by the bundle installer.
 *
 * Until the Swift skeleton is fleshed out and the Capacitor plugin
 * exposes the binding, `loadCoreMlImageGenBackend` throws a structured
 * `ImageGenBackendUnavailableError` so the selector can fall through
 * — but on iOS there is no fall-through (sd-cpp doesn't run on iOS,
 * mflux is macOS-only). A `coreml_unavailable` error there means
 * "this device does not support image-gen yet."
 */

import { ImageGenBackendUnavailableError } from "./errors";
import type {
	ImageGenBackend,
	ImageGenLoadArgs,
	ImageGenRequest,
	ImageGenResult,
} from "./types";

/**
 * The Capacitor bridge shape. The iOS plugin registers an instance
 * under the runtime service name `"capacitor-image-gen"` once the
 * Swift side ships.
 */
export interface CoreMlImageGenBridge {
	/**
	 * True when the Swift `ImageGenBridge.swift` is present AND a
	 * `.mlpackage` has been resolved for the active tier. False when
	 * either is missing — the stub backend throws on `generate` in
	 * that case rather than producing a synthetic PNG.
	 */
	isAvailable(): boolean;
	generateImage(args: {
		modelKey: string;
		prompt: string;
		negativePrompt?: string;
		width: number;
		height: number;
		steps: number;
		guidanceScale: number;
		seed: number;
		signal?: AbortSignal;
	}): Promise<{
		/** Base64-encoded PNG. */
		png: string;
		seed: number;
		inferenceTimeMs: number;
	}>;
}

export interface LoadCoreMlImageGenBackendOptions {
	loadArgs: ImageGenLoadArgs;
	modelKey: string;
	bridge?: CoreMlImageGenBridge;
	now?: () => number;
}

export async function loadCoreMlImageGenBackend(
	opts: LoadCoreMlImageGenBackendOptions,
): Promise<ImageGenBackend> {
	const { bridge, modelKey } = opts;
	const now = opts.now ?? Date.now;

	if (!bridge || !bridge.isAvailable()) {
		throw new ImageGenBackendUnavailableError(
			"coreml",
			"binding_unavailable",
			"[imagegen/coreml] Capacitor ElizaImageGen plugin is not available. Wire ImageGenBridge.swift to apple/ml-stable-diffusion and ship a tier-matched .mlpackage. Until then, iOS image-gen is unavailable.",
		);
	}

	let disposed = false;

	return {
		id: "coreml",
		supports(req: ImageGenRequest) {
			if (disposed) return false;
			// Core ML compiles to a fixed input shape per `.mlpackage`.
			// SD 1.5 stock packages target 512×512; SDXL packages target
			// 1024×1024. We accept the catalog defaults; explicit asks
			// outside the package's shape are rejected so the caller can
			// see a clear error rather than the runtime cropping/upsampling.
			const w = req.width ?? 512;
			const h = req.height ?? 512;
			if (w !== 512 && w !== 768 && w !== 1024) return false;
			if (h !== 512 && h !== 768 && h !== 1024) return false;
			return true;
		},
		async generate(req: ImageGenRequest): Promise<ImageGenResult> {
			if (disposed) {
				throw new ImageGenBackendUnavailableError(
					"coreml",
					"binding_unavailable",
					"[imagegen/coreml] generate called after dispose()",
				);
			}
			if (!req.prompt || !req.prompt.trim()) {
				throw new ImageGenBackendUnavailableError(
					"coreml",
					"unsupported_request",
					"[imagegen/coreml] prompt is empty",
				);
			}
			const seed =
				typeof req.seed === "number" && req.seed >= 0
					? req.seed
					: Math.floor(Math.random() * 0x7fffffff);
			const width = req.width ?? 512;
			const height = req.height ?? 512;
			const steps = req.steps ?? 20;
			const guidanceScale = req.guidanceScale ?? 7.5;
			const startMs = now();
			const result = await bridge.generateImage({
				modelKey,
				prompt: req.prompt,
				negativePrompt: req.negativePrompt,
				width,
				height,
				steps,
				guidanceScale,
				seed,
				signal: req.signal,
			});
			const elapsed =
				typeof result.inferenceTimeMs === "number" && result.inferenceTimeMs > 0
					? result.inferenceTimeMs
					: Math.max(1, now() - startMs);
			const bytes = decodeBase64Png(result.png);
			// Core ML batch path doesn't surface per-step progress; emit a
			// single completion event when the caller asked for one.
			if (req.onProgressChunk) {
				req.onProgressChunk({ step: steps, total: steps });
			}
			return {
				image: bytes,
				mime: "image/png",
				seed: typeof result.seed === "number" ? result.seed : seed,
				metadata: {
					model: modelKey,
					prompt: req.prompt,
					steps,
					guidanceScale,
					inferenceTimeMs: elapsed,
				},
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			// Capacitor plugin owns the Swift-side handle's lifetime; nothing
			// to free from JS. The bundle installer is responsible for the
			// `.mlpackage` cleanup if the user deletes a tier.
		},
	};
}

function decodeBase64Png(base64: string): Uint8Array {
	if (typeof base64 !== "string" || !base64) {
		throw new ImageGenBackendUnavailableError(
			"coreml",
			"unsupported_request",
			"[imagegen/coreml] Capacitor bridge returned empty base64 payload",
		);
	}
	const buf = Buffer.from(base64, "base64");
	if (buf.length < 8) {
		throw new ImageGenBackendUnavailableError(
			"coreml",
			"unsupported_request",
			`[imagegen/coreml] base64 payload too short (${buf.length} bytes); not a PNG`,
		);
	}
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < sig.length; i += 1) {
		if (buf[i] !== sig[i]) {
			throw new ImageGenBackendUnavailableError(
				"coreml",
				"unsupported_request",
				"[imagegen/coreml] base64 payload missing PNG signature",
			);
		}
	}
	return new Uint8Array(buf);
}
