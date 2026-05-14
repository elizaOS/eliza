/**
 * Route-side exports for plugin-local-inference.
 *
 * Consumers (app-core/api/server.ts) import from
 * `@elizaos/plugin-local-inference/routes` to mount the HTTP compat routes
 * for model catalog, downloads, status, and chat commands.
 */

export * from "./local-inference-compat-routes.js";
export * from "./local-inference-tts-route.js";
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
