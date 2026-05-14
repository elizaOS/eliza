/**
 * Runtime-side exports for plugin-local-inference.
 *
 * The package root re-exports these helpers so app consumers use the public
 * `@elizaos/plugin-local-inference` barrel for boot-time handler registration,
 * embedding warm-up policy, and the mobile inference gate.
 */

export {
	DEFAULT_MODELS_DIR,
	type EmbeddingProgressCallback,
	embeddingGgufFilePresent,
	ensureModel,
	findExistingEmbeddingModelForWarmupReuse,
	isEmbeddingWarmupReuseDisabled,
} from "./embedding-manager-support.js";
export { detectEmbeddingPreset } from "./embedding-presets.js";
export { shouldWarmupLocalEmbeddingModel } from "./embedding-warmup-policy.js";
export { ensureLocalInferenceHandler } from "./ensure-local-inference-handler.js";
export { shouldEnableMobileLocalInference } from "./mobile-local-inference-gate.js";
