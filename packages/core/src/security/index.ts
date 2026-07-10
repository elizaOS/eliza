/**
 * Security utilities for elizaOS.
 *
 * Provides:
 * - Sensitive text redaction (pattern-based and secrets-based)
 * - External content wrapping for prompt injection protection
 *
 * @module security
 */

export { mnemonicValid } from "./bip39-wordlist.js";
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
	CompositeEntityRecognizer,
	canonicalKind,
	type EntitySpan,
	GazetteerEntityRecognizer,
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	RegexEntityRecognizer,
	type RegexEntityRecognizerOptions,
} from "./entity-recognizer.js";
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
	type GuardedStreamOutput,
	GuardedStreamScanner,
	type GuardedStreamScannerOptions,
} from "./guarded-stream.js";
export {
	hardenIncomingUserMessage,
	type IncomingMessageSecurityMetadata,
	messageHasPromptInjectionFlag,
	registerCoreIncomingMessageSecurityHook,
	scrubIncomingMessageTextForStorage,
} from "./incoming-message-security.js";
export {
	type AssembleContextPackRequest,
	assembleContextPack,
	buildScrubRequestDraft,
	entityResolverFromStore,
	type PiiContextFragment,
	type PiiContextPack,
	type PiiContextSources,
	type PiiEntityResolverStore,
	type PiiResolvedEntity,
	type PiiScrubCandidate,
	type RuntimeContextSourceOptions,
	sourcesFromRuntime,
} from "./pii-context-pack.js";
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
	wifValid,
} from "./pii-detectors.js";
export {
	type AliasSubstitutionResult,
	type AssignClusterInput,
	assertValidSnapshot,
	CorpusPseudonymMap,
	type CorpusPseudonymMapOptions,
	type PseudonymClusterIdentity,
	type PseudonymClusterRecord,
	PseudonymMapIntegrityError,
	type PseudonymMapSnapshot,
} from "./pii-pseudonym-map.js";
export {
	EncryptedCachePseudonymMapStore,
	type EncryptedCachePseudonymMapStoreOptions,
	PII_PSEUDONYM_MAP_AAD,
	PII_PSEUDONYM_MAP_CACHE_KEY,
	type PseudonymMapStore,
	PseudonymMapStoreError,
} from "./pii-pseudonym-map-store.js";
export {
	DEFAULT_PSEUDONYM_BLOCKLIST,
	PII_SWAP_DISABLED_KINDS_SETTING,
	PII_SWAP_ENABLED_SETTING,
	PII_SWAP_EXEMPT_VALUES_SETTING,
	type PseudonymEntry,
	PseudonymSession,
	type PseudonymSessionOptions,
	parsePiiSwapList,
} from "./pii-pseudonymizer.js";
export {
	assertValidScrubResult,
	PiiScrubFabricationError,
	type ScrubEscalationRequest,
	type ScrubEscalationResult,
	type ScrubResultAssertionOptions,
	scrubWithEscalation,
	type Tier0Span,
} from "./pii-scrub-seam.js";
export {
	createSecretsRedactor,
	// Pattern-based redaction
	getDefaultRedactPatterns,
	// Name-based redaction (single source of truth for credential key names)
	isSensitiveKeyName,
	type RedactOptions,
	type RedactSensitiveMode,
	// Log-sink redaction (structural, not opt-in)
	redactLogArgs,
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
