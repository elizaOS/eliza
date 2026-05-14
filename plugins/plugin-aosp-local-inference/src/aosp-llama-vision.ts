/**
 * AOSP vision-describe FFI stub (WS2).
 *
 * This is the JS-side contract for the libeliza-llama-shim mtmd
 * symbols. The native side is not yet built — when it lands, this file
 * binds the `eliza_llama_mtmd_*` symbols and implements the
 * `AospLlamaMtmdBinding` interface that
 * `@elizaos/plugin-local-inference/services/vision` consumes.
 *
 * Until then, this module exports a `getAospLlamaMtmdBinding()` that
 * returns a stub binding whose `hasMtmd()` returns `false`. The
 * plugin-local-inference vision loader treats `hasMtmd() === false` as
 * "vision not available on this platform" and surfaces a structured
 * `VisionBackendUnavailableError` to the arbiter.
 *
 * Required native symbols to land (libeliza-llama-shim.so):
 *
 *   int32_t eliza_llama_mtmd_init_from_file(
 *     const char *mmproj_path,
 *     void **out_handle
 *   );
 *
 *   void eliza_llama_mtmd_free(void *mtmd_handle);
 *
 *   int32_t eliza_llama_mtmd_describe(
 *     void *model,          // existing llama_model from voice lifecycle
 *     void *ctx,            // existing llama_context from voice lifecycle
 *     void *mtmd_handle,
 *     const uint8_t *image_bytes,
 *     size_t image_len,
 *     const char *prompt,
 *     size_t prompt_len,
 *     int32_t max_tokens,
 *     float temperature,
 *     char *out_buf,
 *     size_t out_buf_cap,
 *     size_t *out_written
 *   );
 *
 * Split-call alternative (when the shim doesn't fuse encode+decode):
 *
 *   int32_t eliza_llama_mtmd_encode(
 *     void *mtmd_handle,
 *     const uint8_t *image_bytes,
 *     size_t image_len,
 *     float **out_tokens_ptr,        // owned by mtmd; valid until next encode
 *     int32_t *out_token_count,
 *     int32_t *out_hidden_size
 *   );
 *
 *   int32_t eliza_llama_decode_with_mmproj(
 *     void *ctx,
 *     const float *mtmd_tokens,
 *     int32_t token_count,
 *     int32_t hidden_size,
 *     const char *prompt,
 *     size_t prompt_len,
 *     int32_t max_tokens,
 *     float temperature,
 *     char *out_buf,
 *     size_t out_buf_cap,
 *     size_t *out_written
 *   );
 *
 * The fused single-call form is preferred — it avoids round-tripping
 * pointer arguments back across bun:ffi between encode and decode,
 * which costs ~50 µs per call on the Snapdragon 8 Gen 3 we target.
 *
 * Validation on Snapdragon QNN / Adreno:
 *   When the shim ships, validate that:
 *     1. `eliza_llama_mtmd_init_from_file` succeeds on the Q4_K_M
 *        mmproj for the 0_8b tier (smallest projector; ~220 MB on
 *        disk, expands to ~270 MB resident).
 *     2. `eliza_llama_mtmd_describe` returns sensible text on a
 *        deterministic test image (a 32×32 RGB checkerboard); the
 *        text should mention "pattern" / "grid" / similar.
 *     3. Memory: the projector co-resident with the 0.8B text model
 *        should fit under 3.5 GB resident on a 6 GB phone.
 *     4. The arbiter's `eliza1-vision` service registers without
 *        crashing the bun process after a fresh APK install.
 */

import type { IAgentRuntime } from "@elizaos/core";

/**
 * Mirror of the `AospLlamaMtmdBinding` interface from
 * `@elizaos/plugin-local-inference/services/vision`. Defined locally to
 * avoid a workspace import cycle (plugin-aosp-local-inference does NOT
 * depend on plugin-local-inference today — keep that invariant). The
 * vision module's `loadAospVisionBackend` consumes this shape.
 */
export interface AospLlamaMtmdBinding {
	hasMtmd(): boolean;
	initMtmd(args: { mmprojPath: string }): Promise<AospMtmdHandle>;
}

export interface AospMtmdHandle {
	describe(args: {
		imageBytes: Uint8Array;
		prompt: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<string>;
	dispose(): Promise<void>;
}

const SERVICE_NAME = "aosp-llama-mtmd";

let cachedBinding: AospLlamaMtmdBinding | null = null;

/**
 * Resolve the runtime AOSP mtmd binding. When the shim doesn't export
 * the mtmd symbols yet, returns a stub binding whose `hasMtmd()`
 * returns false. The vision loader uses that to surface a clean
 * "vision unavailable" error.
 *
 * Idempotent — first call probes; subsequent calls return the cached
 * binding (until `__resetForTests` is invoked).
 */
export function getAospLlamaMtmdBinding(): AospLlamaMtmdBinding {
	if (cachedBinding) return cachedBinding;
	cachedBinding = probeAospMtmdBinding();
	return cachedBinding;
}

/**
 * Register the mtmd binding on the runtime as a service so
 * cross-plugin consumers (plugin-local-inference vision loader) can
 * pick it up via `runtime.getService("aosp-llama-mtmd")`. Idempotent.
 */
export function registerAospLlamaMtmdBinding(runtime: IAgentRuntime): void {
	const r = runtime as IAgentRuntime & {
		registerService?: (name: string, impl: unknown) => unknown;
		getService?: (name: string) => unknown;
	};
	if (typeof r.registerService !== "function") return;
	if (typeof r.getService === "function" && r.getService(SERVICE_NAME)) return;
	r.registerService(SERVICE_NAME, getAospLlamaMtmdBinding());
}

function probeAospMtmdBinding(): AospLlamaMtmdBinding {
	// The probe is intentionally narrow today: it never returns a live
	// binding. When the native shim adds the mtmd symbols, replace this
	// body with a bun:ffi dlopen + symbol bind. The shape of the live
	// binding is fully specified in the JSDoc at the top of this file.
	return {
		hasMtmd(): boolean {
			return false;
		},
		async initMtmd(): Promise<AospMtmdHandle> {
			throw new Error(
				"[aosp-llama-vision] libeliza-llama-shim.so does not export mtmd symbols yet. The expected symbols are eliza_llama_mtmd_init_from_file / _describe / _free; see aosp-llama-vision.ts JSDoc for the full ABI.",
			);
		},
	};
}

/** Test-only: drop the cached binding so a fresh probe runs next call. */
export function __resetForTests(): void {
	cachedBinding = null;
}
