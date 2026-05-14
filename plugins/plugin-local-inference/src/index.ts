// Plugin entry point — public barrel for handler dispatch, routes, runtime
// wiring, service helpers, error types, and plugin definition.

export {
	getLocalInferenceActiveModelId,
	getLocalInferenceActiveSnapshot,
	getLocalInferenceChatStatus,
	handleLocalInferenceChatCommand,
	handleLocalInferenceRoutes,
	type LocalInferenceChatMetadata,
	type LocalInferenceChatResult,
	type LocalInferenceCommandIntent,
} from "./local-inference-routes.js";
export {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
	LOCAL_INFERENCE_MODEL_TYPES,
	LOCAL_INFERENCE_PRIORITY,
	LOCAL_INFERENCE_PROVIDER_ID,
	LOCAL_INFERENCE_TEXT_MODEL_TYPES,
	LocalInferenceUnavailableError,
	type LocalInferenceUnavailableReason,
	localInferencePlugin,
	localInferencePlugin as default,
} from "./provider.js";
export * from "./routes/index.js";
export * from "./runtime/index.js";
export * from "./services/index.js";
