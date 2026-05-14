/**
 * Kokoro TTS ORT execution-provider configuration.
 *
 * Tracks elizaOS/eliza#7667 — readiness scaffold for a Tensor TPU / NNAPI
 * delegate on Android. This module is intentionally side-effect free and is
 * NOT yet wired into the Kokoro ORT loader. The Kokoro runtime is currently
 * moving into `packages/shared/src/local-inference/kokoro/` as part of #7666;
 * a follow-up PR will plug `buildKokoroOrtSessionOptions()` into the
 * `InferenceSession.create` call at
 * `packages/shared/src/local-inference/kokoro/kokoro-runtime.ts:240-247`
 * (current line: `executionProviders: ["cpu"]`). See
 * `docs/rfc/7667-npu-kokoro-android.md` for the deferred-wiring plan.
 *
 * The exported `KokoroExecutionProvider` is the public knob, and
 * `KOKORO_EXECUTION_PROVIDER_IDS` is the runtime allowlist used by callers
 * that validate untrusted input (env var, persisted preference, request
 * body). The default stays `"cpu"` so behaviour is unchanged until the
 * future wiring PR lands.
 */

export const KOKORO_EXECUTION_PROVIDER_IDS = [
	"cpu",
	"nnapi",
	"xnnpack",
	"coreml",
] as const;

export type KokoroExecutionProvider =
	(typeof KOKORO_EXECUTION_PROVIDER_IDS)[number];

export const DEFAULT_KOKORO_EXECUTION_PROVIDER: KokoroExecutionProvider = "cpu";

/**
 * Narrow an arbitrary string to a `KokoroExecutionProvider`. Returns `null`
 * for anything outside the allowlist so callers can decide whether to fall
 * back to the default or fail loudly.
 */
export function parseKokoroExecutionProvider(
	value: string | null | undefined,
): KokoroExecutionProvider | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return (KOKORO_EXECUTION_PROVIDER_IDS as ReadonlyArray<string>).includes(
		normalized,
	)
		? (normalized as KokoroExecutionProvider)
		: null;
}

/**
 * Subset of `ort.InferenceSession.SessionOptions` we care about. We don't
 * import the real type from `onnxruntime-node` here so this module stays
 * usable in environments where ORT is absent (the constant + parser are
 * pure data). The runtime Kokoro loader pre-builds an options object,
 * spreads `executionProviders`, and passes it to `InferenceSession.create`.
 *
 * Keep the shape compatible with the literal at
 * `kokoro/kokoro-runtime.ts:240-247` so the future wiring change is a
 * pure spread.
 */
export interface KokoroOrtSessionOptionsPatch {
	executionProviders: KokoroExecutionProvider[];
}

/**
 * Build the ORT session-options patch for a chosen execution provider.
 *
 * Pure: no runtime probing, no I/O. The caller is responsible for confirming
 * the requested provider is actually available in the ORT build (`probe*`
 * functions live next to the platform plugins, e.g.
 * `plugins/plugin-aosp-local-inference/src/nnapi-availability.ts`).
 *
 * Important: `nnapi` / `xnnpack` / `coreml` only activate when the loaded
 * `onnxruntime-*` package was compiled with the matching execution
 * provider. The default `onnxruntime-react-native` and `onnxruntime-node`
 * builds ship CPU + XNNPACK only; NNAPI / CoreML require a custom build.
 * See `plugins/plugin-aosp-local-inference/README.md` for the AOSP
 * build-flag matrix.
 */
export function buildKokoroOrtSessionOptions(
	provider: KokoroExecutionProvider = DEFAULT_KOKORO_EXECUTION_PROVIDER,
): KokoroOrtSessionOptionsPatch {
	return { executionProviders: [provider] };
}
