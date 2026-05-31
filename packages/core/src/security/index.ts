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
	messageHasPromptInjectionFlag,
	registerCoreIncomingMessageSecurityHook,
	scrubIncomingMessageTextForStorage,
	type IncomingMessageSecurityMetadata,
} from "./incoming-message-security.js";

export {
	isBlockedSpawnEnvKey,
	sanitizeSpawnEnv,
} from "./spawn-env-policy.js";

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
