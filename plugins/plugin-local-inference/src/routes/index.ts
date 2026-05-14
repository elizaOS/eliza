/**
 * Route-side exports for plugin-local-inference.
 *
 * The package root re-exports these handlers so app consumers can use the
 * public `@elizaos/plugin-local-inference` barrel instead of a route subpath.
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
