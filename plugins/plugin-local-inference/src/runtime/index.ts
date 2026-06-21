/**
 * Runtime-side exports for plugin-local-inference.
 *
 * Consumers (app-core/runtime/eliza.ts, agent bootstrap) import from
 * `@elizaos/plugin-local-inference/runtime` to wire boot-time handler
 * registration, embedding warm-up policy, and the mobile inference gate.
 */

// The cross-provider prefer-local router. ensureLocalInferenceHandler installs
// it on desktop; the mobile boot path (capacitor-bridge android/bridge) must
// install it too, otherwise cloud providers (registered at priority 50) win
// over the local handlers (priority 0) — the "stuck-cloud" failure where the
// chat hits plugin-elizacloud's generateNativeChatCompletion and 401s.
export { installRouterHandler } from "../services/router-handler.js";
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
export {
	type EmitVoiceTurnObservedArgs,
	emitVoiceTurnObserved,
	getVoiceProfileStore,
	handleVoiceEntityBound,
	setVoiceEntityBindingStore,
} from "./voice-entity-binding.js";
