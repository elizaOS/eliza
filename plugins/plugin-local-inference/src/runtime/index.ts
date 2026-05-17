/**
 * Runtime-side exports for plugin-local-inference.
 *
 * Consumers (app-core/runtime/eliza.ts, agent bootstrap) import from
 * `@elizaos/plugin-local-inference/runtime` to wire boot-time handler
 * registration, embedding warm-up policy, and the mobile inference gate.
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
