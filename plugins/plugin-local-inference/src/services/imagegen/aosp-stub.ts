/**
 * AOSP image-gen backend stub (WS3) — Android via JNI.
 *
 * On AOSP the canonical fast path is stable-diffusion.cpp built into
 * `libstable-diffusion-jni.so` and exposed through a JNI surface in
 * `@elizaos/plugin-aosp-local-inference`. The shim mirrors the pattern
 * WS2 uses for `eliza_llama_mtmd_*`: a small set of `eliza_llama_imagegen_*`
 * symbols that bun:ffi opens via the same `dlopen` path the text-gen
 * binding uses.
 *
 * Required native symbols (libeliza-llama-shim, to be added):
 *
 *   eliza_llama_imagegen_init_from_file(
 *     model_path: const char *,
 *     accelerator: const char *,   // "auto" / "vulkan" / "opencl" / "cpu"
 *     out_handle: void **
 *   ) -> int32  // 0 = ok; non-zero = error code
 *
 *   eliza_llama_imagegen_free(handle: void *) -> void
 *
 *   eliza_llama_imagegen_generate(
 *     handle: void *,
 *     prompt: const char *,
 *     prompt_len: size_t,
 *     negative_prompt: const char *,   // may be null
 *     negative_prompt_len: size_t,
 *     width: int32,
 *     height: int32,
 *     steps: int32,
 *     guidance_scale: float,
 *     seed: int64,
 *     scheduler: const char *,         // may be null
 *     out_png_buf: uint8_t **,         // owned by shim; valid until next call
 *     out_png_len: size_t *,
 *     out_seed_used: int64 *,
 *     out_inference_ms: int64 *
 *   ) -> int32
 *
 * Why a shim symbol set and not a JNI-direct stable-diffusion.cpp:
 *   The same dlopen pattern that solves the text-gen integration solves
 *   image-gen — we ship one `libeliza-llama-shim.so` per ABI and bun:ffi
 *   binds against a single library handle. Doing JNI directly would
 *   require a JVM in the AOSP build, which we don't want to mandate.
 *
 * Performance note for AOSP image-gen:
 *   Vulkan is the only reasonable accelerator on Android (OpenCL is
 *   patchy across SoCs; CPU is too slow for 4-step Z-Image-Turbo
 *   1024×1024 — Snapdragon 8 Gen 3 hits ~6s on CPU vs ~1.4s on Vulkan).
 *   The shim defaults to `"vulkan"` and falls back to `"cpu"` only when
 *   Vulkan compute is unavailable.
 *
 * Until the shim ships the symbols above, `loadAospImageGenBackend`
 * throws a structured `ImageGenBackendUnavailableError` so the selector
 * can fall back to a desktop-bridge or surface "unavailable" to the UI.
 */

import { ImageGenBackendUnavailableError } from "./errors";
import type {
	ImageGenBackend,
	ImageGenLoadArgs,
	ImageGenRequest,
	ImageGenResult,
} from "./types";

/**
 * The AOSP binding's image-gen surface, when present. The AOSP plugin
 * registers an instance under the runtime service name
 * `"aosp-llama-imagegen"` once the native shim exports the symbols
 * above. Mirrors the WS2 `AospLlamaMtmdBinding` shape.
 */
export interface AospImageGenBinding {
	/** True when libeliza-llama-shim.so exports the imagegen symbols. */
	hasImageGen(): boolean;
	/**
	 * Initialize a handle for the given model. The shim resolves the
	 * accelerator hint internally; pass `"auto"` to defer to its
	 * detection.
	 */
	initImageGen(args: {
		modelPath: string;
		accelerator?: ImageGenLoadArgs["accelerator"];
	}): Promise<AospImageGenHandle>;
}

export interface AospImageGenHandle {
	generate(args: {
		prompt: string;
		negativePrompt?: string;
		width: number;
		height: number;
		steps: number;
		guidanceScale: number;
		seed: number;
		scheduler?: string;
		signal?: AbortSignal;
	}): Promise<{
		png: Uint8Array;
		seedUsed: number;
		inferenceMs: number;
	}>;
	dispose(): Promise<void>;
}

export interface LoadAospImageGenBackendOptions {
	loadArgs: ImageGenLoadArgs;
	modelKey: string;
	binding?: AospImageGenBinding;
	now?: () => number;
}

export async function loadAospImageGenBackend(
	opts: LoadAospImageGenBackendOptions,
): Promise<ImageGenBackend> {
	const binding = opts.binding;
	if (!binding || !binding.hasImageGen()) {
		throw new ImageGenBackendUnavailableError(
			"aosp",
			"binding_unavailable",
			"[imagegen/aosp] libeliza-llama-shim does not export the imagegen symbols yet. Add eliza_llama_imagegen_init_from_file / _generate / _free to the AOSP shim. Until then, AOSP image-gen falls back to nothing (or to a desktop-bridge if paired).",
		);
	}
	const handle = await binding.initImageGen({
		modelPath: opts.loadArgs.modelPath,
		accelerator: opts.loadArgs.accelerator,
	});
	const now = opts.now ?? Date.now;
	let disposed = false;

	return {
		id: "aosp",
		supports(req: ImageGenRequest) {
			const w = req.width ?? 1024;
			const h = req.height ?? 1024;
			if (w <= 0 || h <= 0) return false;
			if (w > 2048 || h > 2048) return false;
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			if (disposed) {
				throw new ImageGenBackendUnavailableError(
					"aosp",
					"binding_unavailable",
					"[imagegen/aosp] generate called after dispose()",
				);
			}
			if (!req.prompt || !req.prompt.trim()) {
				throw new ImageGenBackendUnavailableError(
					"aosp",
					"unsupported_request",
					"[imagegen/aosp] prompt is empty",
				);
			}
			const seed = typeof req.seed === "number" && req.seed >= 0
				? req.seed
				: Math.floor(Math.random() * 0x7fffffff);
			const width = req.width ?? 1024;
			const height = req.height ?? 1024;
			const steps = req.steps ?? 4;
			const guidanceScale = req.guidanceScale ?? 0;
			const startMs = now();
			const out = await handle.generate({
				prompt: req.prompt,
				negativePrompt: req.negativePrompt,
				width,
				height,
				steps,
				guidanceScale,
				seed,
				scheduler: req.scheduler,
				signal: req.signal,
			});
			const elapsed =
				typeof out.inferenceMs === "number" && out.inferenceMs > 0
					? out.inferenceMs
					: Math.max(1, now() - startMs);
			if (req.onProgressChunk) req.onProgressChunk({ step: steps, total: steps });
			return {
				image: out.png,
				mime: "image/png",
				seed: typeof out.seedUsed === "number" ? out.seedUsed : seed,
				metadata: {
					model: opts.modelKey,
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
			await handle.dispose();
		},
	};
}
