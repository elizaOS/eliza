/**
 * AOSP vision-describe backend stub (WS2).
 *
 * The bun:ffi llama.cpp binding in `@elizaos/plugin-aosp-local-inference`
 * already exposes the embedding helpers (`llama_set_embeddings`,
 * `llama_get_embeddings_seq`) and the model/context lifecycle. mtmd
 * (multi-modal definition) is part of upstream llama.cpp from b8198+
 * but the libeliza-llama-shim that the AOSP binding loads does NOT
 * yet export the matching `eliza_llama_mtmd_*` symbols.
 *
 * This file is the JS contract for the FFI binding the AOSP plugin
 * will add when the native side ships. It lives in
 * `plugin-local-inference` (not in `plugin-aosp-local-inference`) so
 * cross-plugin consumers can compile against the same interface
 * regardless of platform. When the AOSP shim ships the native
 * symbols, the implementation in `plugin-aosp-local-inference/src/
 * aosp-llama-vision.ts` (to be added) will satisfy this contract.
 *
 * Required native symbols (libeliza-llama-shim, to be added):
 *
 *   eliza_llama_mtmd_init_from_file(
 *     mmproj_path: const char *,
 *     out_handle: void **
 *   ) -> int32  // 0 = ok; non-zero = error code
 *
 *   eliza_llama_mtmd_free(mtmd_handle: void *) -> void
 *
 *   eliza_llama_mtmd_encode(
 *     mtmd_handle: void *,
 *     image_bytes: const uint8_t *,
 *     image_len: size_t,
 *     out_tokens_ptr: float **,   // owned by mtmd; valid until next encode
 *     out_token_count: int32 *,
 *     out_hidden_size: int32 *
 *   ) -> int32
 *
 *   eliza_llama_decode_with_mmproj(
 *     ctx: void *,                  // existing llama_context
 *     mtmd_tokens: const float *,
 *     mtmd_token_count: int32,
 *     mtmd_hidden_size: int32,
 *     prompt: const char *,
 *     prompt_len: size_t,
 *     max_tokens: int32,
 *     temperature: float,
 *     out_text_buf: char *,         // caller-allocated
 *     out_text_buf_cap: size_t,
 *     out_text_written: size_t *
 *   ) -> int32
 *
 * Optional fast path: if the shim adds
 *
 *   eliza_llama_mtmd_describe(
 *     model: void *,                // existing llama_model
 *     ctx: void *,                  // existing llama_context
 *     mtmd_handle: void *,
 *     image_bytes: const uint8_t *,
 *     image_len: size_t,
 *     prompt: const char *,
 *     prompt_len: size_t,
 *     max_tokens: int32,
 *     temperature: float,
 *     out_buf: char *,
 *     out_buf_cap: size_t,
 *     out_written: size_t *
 *   ) -> int32
 *
 * that single-call wrapper is preferred — it lets the shim fuse the
 * encode+decode steps internally and avoids the round-trip of token
 * pointers across the FFI boundary (which bun:ffi handles, but at the
 * cost of two extra pointer dereferences per frame).
 *
 * Until the native side lands, this module's `loadAospVisionBackend`
 * throws a structured error that the arbiter / handler can surface as
 * "vision not available on this platform". It does NOT register
 * silently — silent unavailability would let the runtime fall back to
 * the cloud path on a mobile device that explicitly disabled it.
 */

import { existsSync } from "node:fs";
import {
	type VisionDescribeBackend,
	type VisionDescribeLoadArgs,
} from "./types";
import { VisionBackendUnavailableError } from "./node-llama-cpp";

/**
 * The AOSP binding's mtmd surface, when present. The AOSP plugin
 * registers an instance under the runtime service name
 * `"aosp-llama-mtmd"` once the native shim exports the symbols above.
 */
export interface AospLlamaMtmdBinding {
	/** True when libeliza-llama-shim.so was loaded and exports the mtmd symbols. */
	hasMtmd(): boolean;
	/** Initialize an mtmd handle for the given mmproj path. */
	initMtmd(args: { mmprojPath: string }): Promise<AospMtmdHandle>;
}

export interface AospMtmdHandle {
	/**
	 * Single-call describe — wraps mtmd_encode + decode_with_chunks. The
	 * AOSP shim's `eliza_llama_mtmd_describe` lands here. Backends that
	 * only have the split encode/decode symbols implement this on top
	 * of two FFI calls; backends with the fused symbol use one.
	 */
	describe(args: {
		imageBytes: Uint8Array;
		prompt: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<string>;
	/** Free the mtmd handle (and any cached encode buffers). */
	dispose(): Promise<void>;
}

export interface LoadAospVisionBackendOptions {
	loadArgs: VisionDescribeLoadArgs;
	mtmdBinding?: AospLlamaMtmdBinding;
}

export async function loadAospVisionBackend(
	opts: LoadAospVisionBackendOptions,
): Promise<VisionDescribeBackend> {
	const { loadArgs, mtmdBinding } = opts;
	if (!mtmdBinding?.hasMtmd()) {
		throw new VisionBackendUnavailableError(
			"aosp",
			"binding_missing_mtmd",
			"[vision/aosp] libeliza-llama-shim does not export the mtmd symbols yet. The AOSP shim needs eliza_llama_mtmd_init_from_file / _encode / _describe / _free. Until the native side lands, vision-describe on AOSP falls back to the cloud path (or stays disabled when the user opted out of cloud).",
		);
	}
	if (!existsSync(loadArgs.mmprojPath)) {
		throw new VisionBackendUnavailableError(
			"aosp",
			"mmproj_missing",
			`[vision/aosp] mmproj GGUF not found: ${loadArgs.mmprojPath}`,
		);
	}
	const handle = await mtmdBinding.initMtmd({
		mmprojPath: loadArgs.mmprojPath,
	});
	return {
		id: "aosp",
		async describe(request) {
			const { resolveImageBytes } = await import("./hash");
			const { bytes } = resolveImageBytes(request.image);
			const text = await handle.describe({
				imageBytes: bytes,
				prompt: request.prompt ?? "Describe what is in this image.",
				maxTokens: request.maxTokens,
				temperature: request.temperature,
				signal: request.signal,
			});
			const trimmed = text.trim();
			if (!trimmed) {
				throw new Error("[vision/aosp] empty text from mtmd_describe");
			}
			const title = trimmed.split(/[.!?]/, 1)[0]?.trim() || "Image";
			return { title, description: trimmed, cacheHit: false };
		},
		async dispose() {
			await handle.dispose();
		},
	};
}
