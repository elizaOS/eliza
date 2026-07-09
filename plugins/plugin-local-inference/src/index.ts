/// <reference path="../../../packages/agent/src/external-modules.d.ts" />
// Plugin entry point — handler dispatch, error types, plugin definition.
// For runtime wiring (boot-time handler registration, embedding warm-up)
// import from `@elizaos/plugin-local-inference/runtime`.
// For HTTP compat routes import from `@elizaos/plugin-local-inference/routes`.
// For deep service surfaces (engine, voice, catalog, mtp) import from
// `@elizaos/plugin-local-inference/services`.

export {
	buildGenerateMediaHandler,
	detectMediaIntent,
	generateMediaAction,
	type MediaKind,
} from "./actions/generate-media.js";
export {
	extractSpeakerName,
	identifySpeakerAction,
} from "./actions/identify-speaker.js";
export {
	type RoleAccessCheck,
	redactTranscriptAction,
	resetTranscriptPermissioningRoleAccessForTests,
	setTranscriptPermissioningRoleAccessForTests,
	shareTranscriptAction,
} from "./actions/transcript-permissioning.js";
export {
	emitVoiceControl,
	startTranscriptionAction,
	stopTranscriptionAction,
	VOICE_CONTROL_STREAM,
	type VoiceControlCommand,
	type VoiceControlEvent,
} from "./actions/transcription-control.js";
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
export {
	handleLocalInferenceTtsRoute,
	normalizeAudioBytes,
	sanitizeLocalInferenceSpeechText,
	sniffAudioContentType,
} from "./routes/local-inference-tts-route.js";
// Embedding preset detection exported for runtime boot wiring.
export {
	detectEmbeddingPreset,
	detectEmbeddingTier,
	EMBEDDING_PRESETS,
	type EmbeddingPreset,
	type EmbeddingTier,
	selectEmbeddingPresetFromHardware,
	selectEmbeddingTierFromHardware,
} from "./runtime/embedding-presets.js";
