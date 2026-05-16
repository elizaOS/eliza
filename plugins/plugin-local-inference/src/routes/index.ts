/**
 * Route-side exports for plugin-local-inference.
 *
 * Consumers (app-core/api/server.ts) import from
 * `@elizaos/plugin-local-inference/routes` to mount the HTTP compat routes
 * for model catalog, downloads, status, and chat commands.
 */

export {
	handleVoiceProfileRoutes,
	registerProfileInCatalog,
	resolveDefaultProfileId,
	type VoiceProfileCatalog,
	type VoiceProfileCatalogEntry,
	type VoiceProfileRouteOptions,
} from "../services/voice/voice-profile-routes.js";
export {
	FAMILY_OF_TAG,
	type FamilyMemberEncoderFactory,
	type FamilyMemberResult,
	handleFamilyMemberRoute,
	setFamilyMemberEncoderFactory,
	setFamilyMemberProfileStore,
} from "./family-member-route.js";
export * from "./local-inference-compat-routes.js";
export * from "./local-inference-asr-route.js";
export * from "./local-inference-tts-route.js";
export {
	handleVoiceModelsRoutes,
	resolveInstalledVersions as resolveInstalledVoiceModelVersions,
	setVoiceModelDownloader,
	setVoiceModelsBundleVersionForTest,
	setVoiceModelsUpdater,
	type VoiceModelInstallationView,
} from "./voice-models-routes.js";
export {
	__resetVoiceOnboardingSessions,
	type EncoderFactory as VoiceOnboardingEncoderFactory,
	handleVoiceOnboardingRoutes,
	ONBOARDING_SCRIPT,
	type OnboardingScriptStep,
	setVoiceOnboardingEncoderFactory,
	setVoiceOnboardingProfileStore,
	setVoiceOnboardingSettingsWriter,
} from "./voice-onboarding-routes.js";
