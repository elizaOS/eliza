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

/**
 * Resolve which ORT module spec to load for this platform.
 *
 * `onnxruntime-node` (the desktop / server native path) only ships prebuilt
 * binaries for `linux/{x64,arm64}`, `darwin/arm64`, and `win32/{x64,arm64}`
 * (see `node_modules/onnxruntime-node/bin/napi-v6/`). There is no riscv64
 * prebuild, so a hard `import("onnxruntime-node")` fails at module-init on
 * the riscv64 on-device path. Fall back to `onnxruntime-web/wasm` — the same
 * WASM runtime the AOSP plugin uses
 * (plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts
 * `loadAospKokoroOrt`), which is arch-agnostic.
 *
 * Selection order (override via `ELIZA_ONNX_RUNTIME_MODULE` env):
 *   1. process.env.ELIZA_ONNX_RUNTIME_MODULE — operator override.
 *   2. process.arch === "riscv64" → "onnxruntime-web/wasm".
 *   3. default → "onnxruntime-node".
 */
function resolveOnnxRuntimeModuleSpec(): string {
	const override = process.env.ELIZA_ONNX_RUNTIME_MODULE?.trim();
	if (override) return override;
	if (process.arch === "riscv64") return "onnxruntime-web/wasm";
	return "onnxruntime-node";
}

/** Load `onnxruntime-node` (or `onnxruntime-web/wasm` on riscv64) once.
 *  Throws `OnnxRuntimeUnavailableError` if the resolved module is not
 *  installed or did not export the runtime. */
export async function loadOnnxRuntime(): Promise<OrtModule> {
	if (!ortModulePromise) {
		ortModulePromise = (async () => {
			const spec = resolveOnnxRuntimeModuleSpec();
			try {
				const mod = (await import(spec)) as {
					default?: OrtModule;
				} & Partial<OrtModule>;
				// `onnxruntime-web/wasm` sometimes exports the runtime off the
				// default-namespace shape; unwrap to whichever surface carries it.
				const candidate = mod as { default?: OrtModule } & Partial<OrtModule>;
				const resolved = (
					candidate.InferenceSession
						? candidate
						: (candidate.default ?? candidate)
				) as OrtModule;
				if (!resolved.InferenceSession || !resolved.Tensor) {
					throw new Error("module did not export InferenceSession/Tensor");
				}
				return resolved;
			} catch (err) {
				ortModulePromise = null;
				throw new OnnxRuntimeUnavailableError(
					`[voice] on-device ONNX models require the optional '${spec}' dependency, which is not installed or failed to load (${
						err instanceof Error ? err.message : String(err)
					}).`,
				);
			}
		})();
	}
	return ortModulePromise;
}
