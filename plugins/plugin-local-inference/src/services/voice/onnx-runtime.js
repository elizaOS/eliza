/**
 * Shared `onnxruntime-node` loader for the voice front-end.
 *
 * Both the Silero VAD (`vad.ts`) and openWakeWord (`wake-word.ts`) models
 * run on the same CPU ONNX runtime. The dependency is *optional* — the
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
var __rewriteRelativeImportExtension =
	(this && this.__rewriteRelativeImportExtension) ||
	((path, preserveJsx) => {
		if (typeof path === "string" && /^\.\.?\//.test(path)) {
			return path.replace(
				/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i,
				(m, tsx, d, ext, cm) =>
					tsx
						? preserveJsx
							? ".jsx"
							: ".js"
						: d && (!ext || !cm)
							? m
							: `${d + ext}.${cm.toLowerCase()}js`,
			);
		}
		return path;
	});
/** Raised by `loadOnnxRuntime()` when `onnxruntime-node` is unavailable.
 *  Callers translate this into their model-specific unavailable error. */
export class OnnxRuntimeUnavailableError extends Error {
	constructor(message) {
		super(message);
		this.name = "OnnxRuntimeUnavailableError";
	}
}
let ortModulePromise = null;
/** Load `onnxruntime-node` once. Throws `OnnxRuntimeUnavailableError` if
 *  the optional dependency is not installed or did not export the runtime. */
export async function loadOnnxRuntime() {
	if (!ortModulePromise) {
		ortModulePromise = (async () => {
			try {
				const spec = "onnxruntime-node";
				const mod = await import(__rewriteRelativeImportExtension(spec));
				const resolved = mod.default ?? mod;
				if (!resolved?.InferenceSession || !resolved?.Tensor) {
					throw new Error("module did not export InferenceSession/Tensor");
				}
				return resolved;
			} catch (err) {
				ortModulePromise = null;
				throw new OnnxRuntimeUnavailableError(
					`[voice] on-device ONNX models require the optional 'onnxruntime-node' dependency, which is not installed or failed to load (${err instanceof Error ? err.message : String(err)}).`,
				);
			}
		})();
	}
	return ortModulePromise;
}
//# sourceMappingURL=onnx-runtime.js.map
