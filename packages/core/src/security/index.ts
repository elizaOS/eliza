/**
 * Security utilities for elizaOS.
 *
 * Provides:
 * - Sensitive text redaction (pattern-based and secrets-based)
 * - External content wrapping for prompt injection protection
 *
 * @module security
 */

export {
	applyCapabilityManifest,
	assertHostAllowed,
	assertPathAllowed,
	CapabilityDeadlineError,
	type CapabilityManifest,
	CapabilityViolationError,
	frozenEnv,
	isHostAllowed,
	isPathAllowed,
	withCapabilityGovernance,
} from "./capability-manifest.js";
export {
	buildSafeExternalPrompt,
	detectSuspiciousPatterns,
	type ExternalContentSource,
	getHookType,
	isExternalHookSession,
	type WrapExternalContentOptions,
	wrapExternalContent,
	wrapWebContent,
} from "./external-content.js";

export {
	hardenIncomingUserMessage,
	type IncomingMessageSecurityMetadata,
	messageHasPromptInjectionFlag,
	registerCoreIncomingMessageSecurityHook,
	scrubIncomingMessageTextForStorage,
} from "./incoming-message-security.js";
export {
	cardBrand,
	detectPii,
	ibanValid,
	ipv4Valid,
	luhnValid,
	PII_DETECTOR_BY_KIND,
	PII_DETECTORS,
	type PiiDetector,
	type PiiMatch,
	ssnValid,
} from "./pii-detectors.js";
export {
	createSecretsRedactor,
	// Pattern-based redaction
	getDefaultRedactPatterns,
	type RedactOptions,
	type RedactSensitiveMode,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
	redactToolDetail,
	redactWithSecrets,
	// Secrets-based redaction
	type SecretsRedactOptions,
} from "./redact.js";
export {
	parseSecretSwapExemptValues,
	SECRET_SWAP_ENABLED_SETTING,
	SECRET_SWAP_EXEMPT_VALUES_SETTING,
	type SecretSwapEntry,
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./secret-swap.js";
export {
	BLOCKED_SPAWN_ENV_KEYS,
	BLOCKED_SPAWN_ENV_PREFIXES,
	isBlockedSpawnEnvKey,
	sanitizeSpawnEnv,
} from "./spawn-env-policy.js";
