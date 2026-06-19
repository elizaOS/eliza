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
	BLOCKED_SPAWN_ENV_KEYS,
	BLOCKED_SPAWN_ENV_PREFIXES,
	isBlockedSpawnEnvKey,
	sanitizeSpawnEnv,
} from "./spawn-env-policy.js";
