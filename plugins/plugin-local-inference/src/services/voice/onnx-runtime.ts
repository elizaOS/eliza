/**
 * Shared `onnxruntime-node` loader for the voice front-end.
 *
 * openWakeWord (`wake-word.ts`), the EOT classifier
 * (`eot-classifier.ts`), and the voice-emotion classifier
 * (`voice-emotion-classifier.ts`) all run on the same CPU ONNX runtime.
 * The Silero VAD has migrated off ONNX to the native silero-vad-cpp GGUF path
 * (`vad.ts`); the optional dependency stays installed for
 * the remaining ONNX-only graphs. The dependency is *optional* — the
 * server bundle declares `onnxruntime-node` in `optionalDependencies`, and
 * a build that did not install it must surface a structured error rather
 * than crash at import time. This module owns:
 *
 *   - structural typings for the slice of `onnxruntime-common`'s
 *     `InferenceSession` / `Tensor` the voice front-end uses, so the
 *     callers compile without the optional dep present;
 *   - a memoised dynamic `import("onnxruntime-node")` indirected through a
 *     string literal so bundlers do not hoist the native dep into the
 *     graph of consumers that never touch voice.
 *
 * No fallback sludge (AGENTS.md §3): a missing runtime is a hard error at
 * the call site, surfaced via the model-specific `*UnavailableError`.
 */

export interface OrtTensor {
	readonly type: string;
	readonly dims: readonly number[];
	readonly data: Float32Array | Int32Array | BigInt64Array;
}
export type OrtTensorCtor = new (
	type: string,
	data: Float32Array | Int32Array | BigInt64Array,
	dims: readonly number[],
) => OrtTensor;
export interface OrtInferenceSession {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	readonly inputMetadata?:
		| ReadonlyArray<{ name?: string; type?: string }>
		| Readonly<Record<string, { name?: string; type?: string }>>;
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
	release(): Promise<void>;
}
export interface OrtInferenceSessionStatic {
	create(
		pathOrBuffer: string | Uint8Array,
		options?: Record<string, unknown>,
	): Promise<OrtInferenceSession>;
}
export interface OrtModule {
	InferenceSession: OrtInferenceSessionStatic;
	Tensor: OrtTensorCtor;
}

/** Raised by `loadOnnxRuntime()` when `onnxruntime-node` is unavailable.
 *  Callers translate this into their model-specific unavailable error. */
export class OnnxRuntimeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OnnxRuntimeUnavailableError";
	}
}

let ortModulePromise: Promise<OrtModule> | null = null;

/** Load `onnxruntime-node` once. Throws `OnnxRuntimeUnavailableError` if
 *  the optional dependency is not installed or did not export the runtime. */
export async function loadOnnxRuntime(): Promise<OrtModule> {
	if (!ortModulePromise) {
		ortModulePromise = (async () => {
			try {
				const spec = "onnxruntime-node";
				const mod = (await import(spec)) as { default?: OrtModule } & OrtModule;
				const resolved = (mod.default ?? mod) as OrtModule;
				if (!resolved.InferenceSession || !resolved.Tensor) {
					throw new Error("module did not export InferenceSession/Tensor");
				}
				return resolved;
			} catch (err) {
				ortModulePromise = null;
				throw new OnnxRuntimeUnavailableError(
					`[voice] on-device ONNX models require the optional 'onnxruntime-node' dependency, which is not installed or failed to load (${
						err instanceof Error ? err.message : String(err)
					}).`,
				);
			}
		})();
	}
	return ortModulePromise;
}
