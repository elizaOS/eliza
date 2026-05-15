// Plugin entry point — handler dispatch, error types, plugin definition.
// For runtime wiring (boot-time handler registration, embedding warm-up)
// import from `@elizaos/plugin-local-inference/runtime`.
// For HTTP compat routes import from `@elizaos/plugin-local-inference/routes`.
// For deep service surfaces (engine, voice, catalog, dflash) import from
// `@elizaos/plugin-local-inference/services`.
export { buildGenerateMediaHandler, detectMediaIntent, generateMediaAction, } from "./actions/generate-media.js";
export { getLocalInferenceActiveModelId, getLocalInferenceActiveSnapshot, getLocalInferenceChatStatus, handleLocalInferenceChatCommand, handleLocalInferenceRoutes, } from "./local-inference-routes.js";
export { createLocalInferenceModelHandlers, isLocalInferenceUnavailableError, LOCAL_INFERENCE_MODEL_TYPES, LOCAL_INFERENCE_PRIORITY, LOCAL_INFERENCE_PROVIDER_ID, LOCAL_INFERENCE_TEXT_MODEL_TYPES, LocalInferenceUnavailableError, localInferencePlugin, localInferencePlugin as default, } from "./provider.js";
//# sourceMappingURL=index.js.map