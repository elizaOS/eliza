/**
 * Secrets capability — shared type definitions
 *
 * This module defines all core types for the multi-level secrets management system.
 * Designed for ElizaOS native storage: character settings, world metadata, and components.
 */

// ============================================================================
// Constants
// ============================================================================

export const SECRET_KEY_MAX_LENGTH = 256;
export const SECRET_VALUE_MAX_LENGTH = 65536;
export const SECRET_DESCRIPTION_MAX_LENGTH = 1024;
export const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const MAX_ACCESS_LOG_ENTRIES = 1000;

// ============================================================================
// Enums
// ============================================================================

export type SecretLevel = "global" | "world" | "user";

export type SecretType =
	| "api_key"
	| "private_key"
	| "public_key"
	| "url"
	| "credential"
	| "token"
	| "config"
	| "secret";

export type SecretStatus =
	| "missing"
	| "generating"
	| "validating"
	| "invalid"
	| "valid"
	| "expired"
	| "revoked";

export type SecretPermissionType = "read" | "write" | "delete" | "share";

export type ValidationStrategy =
	| "none"
	| "api_key:openai"
	| "api_key:anthropic"
	| "api_key:groq"
	| "api_key:google"
	| "api_key:mistral"
	| "api_key:cohere"
	| "url:valid"
	| "url:reachable"
	| "custom";

export type StorageBackend =
	| "memory"
	| "character"
	| "world"
	| "component"
	/**
	 * External non-decrypting broker backend (issue #11536, phase E4). Unlike
	 * the local AES-GCM backends above, a `"broker"` store NEVER holds or returns
	 * plaintext secret values: its read path yields a {@link SecretHandle} that is
	 * resolved at use-time through the credential-proxy / model-gateway seam.
	 */
	| "broker";

// ============================================================================
// Core Secret Types
// ============================================================================

/**
 * Configuration for a single secret/environment variable
 */
export interface SecretConfig {
	/** Type classification of the secret */
	type: SecretType;
	/** Whether this secret is required for the plugin to function */
	required: boolean;
	/** Human-readable description */
	description: string;
	/** Whether this secret can be auto-generated */
	canGenerate: boolean;
	/** Validation method to use */
	validationMethod?: ValidationStrategy;
	/** Current status of the secret */
	status: SecretStatus;
	/** Last error message if validation failed */
	lastError?: string;
	/** Number of validation attempts */
	attempts: number;
	/** Timestamp when secret was created */
	createdAt?: number;
	/** Timestamp when secret was last validated */
	validatedAt?: number;
	/** Plugin that declared this secret requirement */
	plugin: string;
	/** Storage level (global, world, or user) */
	level: SecretLevel;
	/** Owner entity ID for user-level secrets */
	ownerId?: string;
	/** World ID for world-level secrets */
	worldId?: string;
	/** Whether the value is encrypted */
	encrypted?: boolean;
	/** Explicit permissions granted to other entities */
	permissions?: SecretPermission[];
	/** List of entity IDs with shared access */
	sharedWith?: string[];
	/** Optional expiration timestamp */
	expiresAt?: number;
}

/**
 * Stored secret with value and config
 */
export interface StoredSecret {
	/** The secret value (may be encrypted) */
	value: string | EncryptedSecret;
	/** Secret configuration */
	config: SecretConfig;
}

/**
 * Context for secret operations - determines access level and scope
 */
export interface SecretContext {
	/** Storage level to operate on */
	level: SecretLevel;
	/** World ID (required for world-level operations) */
	worldId?: string;
	/** User ID (required for user-level operations) */
	userId?: string;
	/** Agent ID (always required) */
	agentId: string;
	/** Entity making the request (for permission checks) */
	requesterId?: string;
}

/**
 * Permission grant for a secret
 */
export interface SecretPermission {
	/** Entity ID that has this permission */
	entityId: string;
	/** List of allowed operations */
	permissions: SecretPermissionType[];
	/** Entity that granted this permission */
	grantedBy: string;
	/** Timestamp when permission was granted */
	grantedAt: number;
	/** Optional expiration timestamp */
	expiresAt?: number;
}

/**
 * Metadata collection for multiple secrets (without values)
 */
export interface SecretMetadata {
	[key: string]: SecretConfig;
}

/**
 * Access log entry for auditing
 */
export interface SecretAccessLog {
	/** Secret key that was accessed */
	secretKey: string;
	/** Entity that performed the access */
	accessedBy: string;
	/** Type of access operation */
	action: SecretPermissionType;
	/** Timestamp of access */
	timestamp: number;
	/** Context of the access */
	context: SecretContext;
	/** Whether the access succeeded */
	success: boolean;
	/** Error message if access failed */
	error?: string;
}

// ============================================================================
// Encryption Types
// ============================================================================

/**
 * Encrypted secret container
 */
export interface EncryptedSecret {
	/** Encrypted value (base64) */
	value: string;
	/** Initialization vector (base64) */
	iv: string;
	/** Authentication tag for GCM mode (base64) */
	authTag?: string;
	/** Encryption algorithm used */
	algorithm: "aes-256-gcm";
	/** Key identifier for key rotation */
	keyId: string;
}

// ============================================================================
// Broker Federation Types (issue #11536, phase E4)
// ============================================================================

/**
 * Discriminator marking a value returned by a non-decrypting broker backend as
 * a HANDLE (a reference to a secret), never the plaintext. Serialized into the
 * handle's `value` field so a consumer that mistakes a handle for a raw secret
 * gets an obviously-non-credential sentinel rather than something it might send
 * on the wire.
 */
export const SECRET_HANDLE_MARKER = "eliza:secret-handle:v1" as const;

/**
 * A non-decrypting reference to a secret held by an third-party broker.
 *
 * This is the core E4 primitive: the broker backend issues a `SecretHandle`
 * instead of a plaintext value. The handle is resolvable at USE-TIME through
 * the already-shipped seams — the model gateway (E1/E2) for provider keys and
 * the credential proxy (E3) for arbitrary API credentials — where the broker
 * injects the real credential outbound (header-only) and the runtime never
 * sees it. The runtime therefore CANNOT exfiltrate the credential because it
 * never holds the plaintext.
 */
export interface SecretHandle {
	/** Constant discriminator. Always {@link SECRET_HANDLE_MARKER}. */
	readonly marker: typeof SECRET_HANDLE_MARKER;
	/**
	 * Opaque broker-scoped reference for this secret (e.g. a lease id or vault
	 * path). NOT the credential; safe to log/persist. Resolved by the broker at
	 * use-time via the proxy/gateway seam.
	 */
	readonly ref: string;
	/** The secret key this handle stands in for. */
	readonly key: string;
	/**
	 * Which use-time seam resolves this handle:
	 *   - `"model-gateway"` — an OpenAI-compatible provider key (E1/E2).
	 *   - `"credential-proxy"` — an arbitrary API credential injected by the
	 *     credential proxy (E3).
	 */
	readonly resolveVia: "model-gateway" | "credential-proxy";
	/** Optional broker base URL the handle resolves against (informational). */
	readonly brokerUrl?: string;
	/** Optional expiry (epoch ms) if the broker issued a time-bound handle. */
	readonly expiresAt?: number;
}

/**
 * Serialize a {@link SecretHandle} into the opaque string the `ISecretStorage`
 * `get` contract returns. The result is deliberately NOT a credential: it is a
 * prefixed JSON blob a consumer can detect via {@link isSerializedSecretHandle}
 * and hand to the resolve seam instead of sending it as a bearer token.
 */
export function serializeSecretHandle(handle: SecretHandle): string {
	return `${SECRET_HANDLE_MARKER}:${JSON.stringify(handle)}`;
}

/** Type guard: is a stored string a serialized {@link SecretHandle}? */
export function isSerializedSecretHandle(value: string | null): boolean {
	return (
		typeof value === "string" && value.startsWith(`${SECRET_HANDLE_MARKER}:`)
	);
}

/**
 * Parse a serialized handle back into a {@link SecretHandle}, or `null` if the
 * string is not a serialized handle / is malformed.
 */
export function parseSecretHandle(value: string | null): SecretHandle | null {
	if (!isSerializedSecretHandle(value)) return null;
	const json = (value as string).slice(`${SECRET_HANDLE_MARKER}:`.length);
	try {
		const parsed = JSON.parse(json) as SecretHandle;
		if (parsed?.marker !== SECRET_HANDLE_MARKER) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * The minimal contract a `"broker"` backend calls out to. Deliberately
 * vendor-neutral: any broker that can (a) confirm a secret exists, (b) issue a
 * non-decrypting handle for it, and optionally (c) store a secret write-only
 * satisfies it. Steward is the REFERENCE implementation, not a hard dependency
 * — this interface is defined in core with no branded import.
 */
export interface ISecretBrokerClient {
	/** Does the broker hold a secret for this key? Never returns the value. */
	hasSecret(key: string, context: SecretContext): Promise<boolean>;
	/**
	 * Issue a non-decrypting handle for a secret. MUST NOT return plaintext.
	 * Returns `null` when the broker has no such secret.
	 */
	issueHandle(
		key: string,
		context: SecretContext,
	): Promise<SecretHandle | null>;
	/**
	 * Optionally store a secret INTO the broker (write path). Brokers that are
	 * read-only (the runtime is not permitted to write tenant credentials)
	 * should omit this or return `false`; the store then refuses writes.
	 */
	storeSecret?(
		key: string,
		value: string,
		context: SecretContext,
	): Promise<boolean>;
	/** Optionally remove a secret handle mapping from the broker. */
	deleteSecret?(key: string, context: SecretContext): Promise<boolean>;
	/** Optional metadata listing (never values). */
	listSecrets?(context: SecretContext): Promise<SecretMetadata>;
}

/**
 * Key derivation parameters
 */
export interface KeyDerivationParams {
	/** Salt for key derivation (base64) */
	salt: string;
	/** Number of iterations for PBKDF2 */
	iterations: number;
	/** Algorithm used for derivation */
	algorithm: "pbkdf2-sha256" | "argon2id";
	/** Key length in bytes */
	keyLength: number;
}

// ============================================================================
// Plugin Activation Types
// ============================================================================

/**
 * Secret requirement declared by a plugin
 */
export interface PluginSecretRequirement {
	/** Human-readable description */
	description: string;
	/** Type of secret */
	type: SecretType;
	/** Whether the secret is required for plugin to function */
	required: boolean;
	/** Validation method to use */
	validationMethod?: ValidationStrategy;
	/** Environment variable name shown in setup guidance */
	envVar?: string;
	/** Whether this secret can be auto-generated */
	canGenerate?: boolean;
	/** Generation script if auto-generatable */
	generationScript?: string;
}

/**
 * Status of plugin requirements
 */
export interface PluginRequirementStatus {
	/** Plugin identifier */
	pluginId: string;
	/** Whether all required secrets are available */
	ready: boolean;
	/** List of missing required secrets */
	missingRequired: string[];
	/** List of missing optional secrets */
	missingOptional: string[];
	/** List of invalid secrets */
	invalid: string[];
	/** Overall status message */
	message: string;
}

/**
 * Callback for secret changes
 */
export type SecretChangeCallback = (
	key: string,
	value: string | null,
	context: SecretContext,
) => Promise<void>;

/**
 * Plugin activation registration
 */
export interface PendingPluginActivation {
	/** Plugin identifier */
	pluginId: string;
	/** Required secrets for activation */
	requiredSecrets: string[];
	/** Callback to invoke when ready */
	callback: () => Promise<void>;
	/** Registration timestamp */
	registeredAt: number;
}

// ============================================================================
// Storage Interface Types
// ============================================================================

/**
 * Storage backend interface
 */
export interface ISecretStorage {
	/** Storage backend type */
	readonly storageType: StorageBackend;

	/** Initialize the storage backend */
	initialize(): Promise<void>;

	/** Check if a secret exists */
	exists(key: string, context: SecretContext): Promise<boolean>;

	/** Get a secret value */
	get(key: string, context: SecretContext): Promise<string | null>;

	/** Set a secret value */
	set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean>;

	/** Delete a secret */
	delete(key: string, context: SecretContext): Promise<boolean>;

	/** List all secrets in a context */
	list(context: SecretContext): Promise<SecretMetadata>;

	/** Get secret configuration without value */
	getConfig(key: string, context: SecretContext): Promise<SecretConfig | null>;

	/** Update secret configuration */
	updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean>;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result of secret validation
 */
export interface ValidationResult {
	/** Whether the value is valid */
	isValid: boolean;
	/** Error message if invalid */
	error?: string;
	/** Additional details */
	details?: string;
	/** Validation timestamp */
	validatedAt: number;
}

/**
 * Custom validation function signature
 */
export type CustomValidator = (
	key: string,
	value: string,
) => Promise<ValidationResult>;

/**
 * Validation strategy registry entry
 */
export interface ValidationStrategyEntry {
	/** Strategy identifier */
	id: ValidationStrategy;
	/** Human-readable name */
	name: string;
	/** Description of validation */
	description: string;
	/** Validator function */
	validate: CustomValidator;
}

// ============================================================================
// Generation Types
// ============================================================================

/**
 * Script for auto-generating secrets
 */
export interface GenerationScript {
	/** Variable name to generate */
	variableName: string;
	/** Plugin that owns this script */
	pluginName: string;
	/** Script content (shell/node) */
	script: string;
	/** Required dependencies */
	dependencies: string[];
	/** Number of generation attempts */
	attempts: number;
	/** Last output */
	output?: string;
	/** Last error */
	error?: string;
	/** Current status */
	status: "pending" | "running" | "success" | "failed";
	/** Creation timestamp */
	createdAt: number;
}

// ============================================================================
// Service Types
// ============================================================================

/**
 * Secrets service configuration
 */
export interface SecretsServiceConfig {
	/** Whether to enable encryption */
	enableEncryption: boolean;
	/** Salt for key derivation */
	encryptionSalt?: string;
	/** Whether to enable access logging */
	enableAccessLogging: boolean;
	/** Maximum access log entries to keep */
	maxAccessLogEntries: number;
	/**
	 * Optional non-decrypting broker client (issue #11536, phase E4). Vendor-
	 * neutral: core defines the {@link ISecretBrokerClient} contract but ships no
	 * concrete broker. A deployment that wants the "eliza enterprise"
	 * never-holds-plaintext guarantee supplies its client here AND sets the
	 * `ELIZA_SECRETS_BROKER_URL`/`_TOKEN` env; both are required to activate the
	 * broker backend. When unset, the service uses the local composite default
	 * unchanged.
	 */
	brokerClient?: ISecretBrokerClient;
}

/**
 * Plugin activator service configuration
 */
export interface PluginActivatorConfig {
	/** Whether to enable auto-activation */
	enableAutoActivation: boolean;
	/** Polling interval for checking requirements (ms) */
	pollingIntervalMs: number;
	/** Maximum time to wait for secrets (ms, 0 = forever) */
	maxWaitMs: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Secret change event
 */
export interface SecretChangeEvent {
	/** Event type */
	type: "created" | "updated" | "deleted" | "expired";
	/** Secret key */
	key: string;
	/** New value (null for deleted) */
	value: string | null;
	/** Previous value (if updated) */
	previousValue?: string;
	/** Context of the change */
	context: SecretContext;
	/** Timestamp */
	timestamp: number;
}

/**
 * Plugin activation event
 */
export interface PluginActivationEvent {
	/** Event type */
	type: "queued" | "activated" | "failed" | "timeout";
	/** Plugin identifier */
	pluginId: string;
	/** Missing secrets (if queued/failed) */
	missingSecrets?: string[];
	/** Error message (if failed) */
	error?: string;
	/** Timestamp */
	timestamp: number;
}

// ============================================================================
// Form Types (for web-based secret collection)
// ============================================================================

export type FormFieldType =
	| "text"
	| "password"
	| "textarea"
	| "select"
	| "checkbox"
	| "radio"
	| "file"
	| "hidden";

export interface FormValidationRule {
	/** Rule type */
	type: "required" | "minLength" | "maxLength" | "pattern" | "custom";
	/** Value for the rule */
	value?: string | number | boolean;
	/** Error message */
	message: string;
}

export interface FormField {
	/** Field name (becomes secret key) */
	name: string;
	/** Field label */
	label: string;
	/** Field type */
	type: FormFieldType;
	/** Placeholder text */
	placeholder?: string;
	/** Default value */
	defaultValue?: string;
	/** Help text */
	helpText?: string;
	/** Options for select/radio */
	options?: Array<{ value: string; label: string }>;
	/** Validation rules */
	validation?: FormValidationRule[];
	/** Whether field is disabled */
	disabled?: boolean;
	/** Custom CSS classes */
	className?: string;
}

export interface FormSchema {
	/** Form title */
	title: string;
	/** Form description */
	description?: string;
	/** Form fields */
	fields: FormField[];
	/** Submit button text */
	submitText?: string;
	/** Cancel button text */
	cancelText?: string;
	/** Success message */
	successMessage?: string;
	/** Redirect URL after success */
	redirectUrl?: string;
}

export interface FormSession {
	/** Session ID */
	id: string;
	/** Form schema */
	schema: FormSchema;
	/** Context for storing secrets */
	context: SecretContext;
	/** Expiration timestamp */
	expiresAt: number;
	/** Created timestamp */
	createdAt: number;
	/** Public URL for form access */
	publicUrl?: string;
	/** Tunnel ID (if using ngrok) */
	tunnelId?: string;
	/** Whether form has been submitted */
	submitted: boolean;
	/** Submission timestamp */
	submittedAt?: number;
}

export interface FormSubmission {
	/** Session ID */
	sessionId: string;
	/** Submitted values */
	values: Record<string, string>;
	/** Submission timestamp */
	submittedAt: number;
	/** Client IP address */
	clientIp?: string;
	/** User agent */
	userAgent?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export class SecretsError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SecretsError";
	}
}

export class PermissionDeniedError extends SecretsError {
	constructor(
		key: string,
		action: SecretPermissionType,
		context: SecretContext,
	) {
		super(
			`Permission denied: cannot ${action} secret '${key}' at level '${context.level}'`,
			"PERMISSION_DENIED",
			{ key, action, context },
		);
		this.name = "PermissionDeniedError";
	}
}

export class SecretNotFoundError extends SecretsError {
	constructor(key: string, context: SecretContext) {
		super(
			`Secret '${key}' not found at level '${context.level}'`,
			"SECRET_NOT_FOUND",
			{ key, context },
		);
		this.name = "SecretNotFoundError";
	}
}

export class ValidationError extends SecretsError {
	constructor(key: string, message: string, details?: Record<string, unknown>) {
		super(
			`Validation failed for secret '${key}': ${message}`,
			"VALIDATION_FAILED",
			{ key, ...details },
		);
		this.name = "ValidationError";
	}
}

export class EncryptionError extends SecretsError {
	constructor(message: string, details?: Record<string, unknown>) {
		super(message, "ENCRYPTION_ERROR", details);
		this.name = "EncryptionError";
	}
}

export class StorageError extends SecretsError {
	constructor(message: string, details?: Record<string, unknown>) {
		super(message, "STORAGE_ERROR", details);
		this.name = "StorageError";
	}
}
