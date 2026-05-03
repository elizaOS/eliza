/**
 * Secrets Service
 *
 * Core service for multi-level secret management in ElizaOS.
 * Provides an API for accessing global, world, and user secrets
 * with encryption, access control, and change notification support.
 */

import {
	resolveSecretKeyAlias,
	SECRET_KEY_ALIASES,
} from "../../../character-utils.ts";
import { logger } from "../../../logger.ts";
import {
	type IAgentRuntime,
	Service,
	type ServiceTypeName,
} from "../../../types/index.ts";
import { KeyManager } from "../crypto/index.ts";
import {
	CharacterSettingsStorage,
	ComponentSecretStorage,
	CompositeSecretStorage,
	WorldMetadataStorage,
} from "../storage/index.ts";
import type {
	PluginSecretRequirement,
	SecretAccessLog,
	SecretChangeCallback,
	SecretChangeEvent,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	SecretsServiceConfig,
	ValidationResult,
} from "../types.ts";
import { MAX_ACCESS_LOG_ENTRIES, SecretsError } from "../types.ts";
import { ValidationStrategies, validateSecret } from "../validation.ts";

/**
 * Service type identifier
 */
export const SECRETS_SERVICE_TYPE = "SECRETS" as ServiceTypeName;

/**
 * Default service configuration
 */
const DEFAULT_CONFIG: SecretsServiceConfig = {
	enableEncryption: true,
	encryptionSalt: undefined,
	enableAccessLogging: true,
	maxAccessLogEntries: MAX_ACCESS_LOG_ENTRIES,
};

/**
 * Secrets Service
 *
 * service for managing secrets at all levels:
 * - Global: Stored in character settings (agent-wide config, API keys)
 * - World: Stored in world metadata (server/channel-specific)
 * - User: Stored as components (per-user secrets)
 */
export class SecretsService extends Service {
	static serviceType: ServiceTypeName = SECRETS_SERVICE_TYPE;
	capabilityDescription =
		"Manage secrets at global, world, and user levels with encryption and access control";

	private secretsConfig: SecretsServiceConfig;
	private keyManager!: KeyManager;
	private storage!: CompositeSecretStorage;
	private globalStorage!: CharacterSettingsStorage;
	private worldStorage!: WorldMetadataStorage;
	private userStorage!: ComponentSecretStorage;

	private accessLogs: SecretAccessLog[] = [];
	private changeCallbacks: Map<string, SecretChangeCallback[]> = new Map();
	private globalChangeCallbacks: SecretChangeCallback[] = [];
	private mirrorSecretsToProcessEnv = false;

	constructor(runtime?: IAgentRuntime, config?: Partial<SecretsServiceConfig>) {
		super(runtime);
		this.secretsConfig = { ...DEFAULT_CONFIG, ...config };

		// Initialize encryption key manager
		this.keyManager = new KeyManager();
		if (runtime) {
			this.keyManager.initializeFromAgentId(
				runtime.agentId,
				this.secretsConfig.encryptionSalt ??
					(runtime.getSetting("ENCRYPTION_SALT") as string),
			);

			// Initialize storage backends
			this.globalStorage = new CharacterSettingsStorage(
				runtime,
				this.keyManager,
			);
			this.worldStorage = new WorldMetadataStorage(runtime, this.keyManager);
			this.userStorage = new ComponentSecretStorage(runtime, this.keyManager);

			// Create composite storage
			this.storage = new CompositeSecretStorage({
				globalStorage: this.globalStorage,
				worldStorage: this.worldStorage,
				userStorage: this.userStorage,
			});
		}
	}

	/**
	 * Start the service
	 */
	static async start(
		runtime: IAgentRuntime,
		config?: Partial<SecretsServiceConfig>,
	): Promise<SecretsService> {
		const service = new SecretsService(runtime, config);
		await service.initialize();
		return service;
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		logger.info("[SecretsService] Initializing");

		await this.storage.initialize();

		// Migrate legacy env vars if needed
		const migrated = await this.globalStorage.migrateFromEnvVars();
		if (migrated > 0) {
			logger.info(`[SecretsService] Migrated ${migrated} legacy env vars`);
		}

		// Migrate aliased secret keys to canonical names
		const aliasesMigrated = await this.migrateAliasedKeys();
		if (aliasesMigrated > 0) {
			logger.info(
				`[SecretsService] Migrated ${aliasesMigrated} aliased keys to canonical names`,
			);
		}

		const isSandboxMode = Boolean(
			this.runtime &&
				(this.runtime as unknown as Record<string, unknown>).sandboxMode,
		);
		this.mirrorSecretsToProcessEnv =
			!isSandboxMode &&
			["1", "true", "yes", "on"].includes(
				String(process.env.ELIZA_ALLOW_SECRET_ENV_SYNC ?? "")
					.trim()
					.toLowerCase(),
			);

		if (isSandboxMode && this.mirrorSecretsToProcessEnv) {
			throw new SecretsError(
				"process.env secret mirroring is forbidden in sandbox mode",
				"PROCESS_ENV_SYNC_FORBIDDEN",
			);
		}

		if (this.mirrorSecretsToProcessEnv) {
			const synced = await this.globalStorage.syncAllToEnv();
			logger.warn(
				`[SecretsService] Legacy process.env mirroring enabled; synced ${synced} secrets`,
			);
		} else {
			logger.info(
				"[SecretsService] process.env mirroring disabled; callers must read secrets explicitly",
			);
		}

		logger.info("[SecretsService] Initialized");
	}

	/**
	 * Migrate secrets stored under aliased keys to their canonical names.
	 * This ensures backward compatibility while standardizing key names.
	 */
	private async migrateAliasedKeys(): Promise<number> {
		let migrated = 0;
		const context: SecretContext = {
			level: "global",
			agentId: this.runtime.agentId,
		};

		for (const [alias, canonical] of Object.entries(SECRET_KEY_ALIASES)) {
			// Check if old alias key exists
			const aliasValue = await this.storage.get(alias, context);
			if (aliasValue === null) {
				continue;
			}

			// Check if canonical key already exists
			const canonicalValue = await this.storage.get(canonical, context);
			if (canonicalValue !== null) {
				// Canonical already exists, skip (don't overwrite)
				logger.debug(
					`[SecretsService] Skipping migration of ${alias} - ${canonical} already exists`,
				);
				continue;
			}

			// Migrate: copy value to canonical key
			const success = await this.storage.set(canonical, aliasValue, context);
			if (success) {
				migrated++;
				logger.debug(
					`[SecretsService] Migrated ${alias} to canonical name ${canonical}`,
				);
			}
		}

		return migrated;
	}

	/**
	 * Stop the service
	 */
	async stop(): Promise<void> {
		logger.info("[SecretsService] Stopping");

		// Clear sensitive data
		this.keyManager.clear();
		this.accessLogs = [];
		this.changeCallbacks.clear();
		this.globalChangeCallbacks = [];

		logger.info("[SecretsService] Stopped");
	}

	// ============================================================================
	// Core Secret Operations
	// ============================================================================

	/**
	 * Get a secret value.
	 * Automatically resolves aliases to canonical names.
	 */
	async get(key: string, context: SecretContext): Promise<string | null> {
		// Resolve alias to canonical name
		const canonicalKey = resolveSecretKeyAlias(key);

		this.logAccess(canonicalKey, "read", context, true);

		// Try canonical key first
		let value = await this.storage.get(canonicalKey, context);

		// If not found and original key was different, also try the original (for migration)
		if (value === null && key !== canonicalKey) {
			value = await this.storage.get(key, context);
			// If found under old key, migrate to canonical key
			if (value !== null) {
				logger.debug(
					`[SecretsService] Migrating ${key} to canonical name ${canonicalKey}`,
				);
				await this.storage.set(canonicalKey, value, context);
				// Optionally delete old key (keeping for backward compatibility for now)
			}
		}

		if (value === null) {
			this.logAccess(canonicalKey, "read", context, false, "Secret not found");
		}

		return value;
	}

	/**
	 * Resolve a secret key alias to its canonical name.
	 * Convenience method that delegates to the shared utility.
	 */
	resolveSecretKey(key: string): string {
		return resolveSecretKeyAlias(key);
	}

	/**
	 * Set a secret value.
	 * Automatically resolves aliases to canonical names.
	 */
	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		// Resolve alias to canonical name
		const canonicalKey = resolveSecretKeyAlias(key);

		this.logAccess(canonicalKey, "write", context, true);

		// Validate if validation method specified
		if (config?.validationMethod && config.validationMethod !== "none") {
			const validation = await this.validate(
				canonicalKey,
				value,
				config.validationMethod,
			);
			if (!validation.isValid) {
				this.logAccess(
					canonicalKey,
					"write",
					context,
					false,
					`Validation failed: ${validation.error}`,
				);
				throw new SecretsError(
					`Validation failed for ${canonicalKey}: ${validation.error}`,
					"VALIDATION_FAILED",
					{ key: canonicalKey, error: validation.error },
				);
			}
		}

		// Get previous value for change event
		const previousValue = await this.storage.get(canonicalKey, context);

		const success = await this.storage.set(
			canonicalKey,
			value,
			context,
			config,
		);

		if (success) {
			// Sync to process.env if global (using canonical key)
			if (context.level === "global" && this.mirrorSecretsToProcessEnv) {
				await this.globalStorage.syncToEnv(canonicalKey);
			}

			// Emit change event
			await this.emitChangeEvent({
				type: previousValue === null ? "created" : "updated",
				key: canonicalKey,
				value,
				previousValue: previousValue ?? undefined,
				context,
				timestamp: Date.now(),
			});
		} else {
			this.logAccess(
				canonicalKey,
				"write",
				context,
				false,
				"Storage operation failed",
			);
		}

		return success;
	}

	/**
	 * Delete a secret.
	 * Automatically resolves aliases to canonical names.
	 */
	async delete(key: string, context: SecretContext): Promise<boolean> {
		// Resolve alias to canonical name
		const canonicalKey = resolveSecretKeyAlias(key);

		this.logAccess(canonicalKey, "delete", context, true);

		const previousValue = await this.storage.get(canonicalKey, context);
		const success = await this.storage.delete(canonicalKey, context);

		if (success) {
			// Remove from process.env if global (both canonical and original key)
			if (context.level === "global" && this.mirrorSecretsToProcessEnv) {
				delete process.env[canonicalKey];
				if (key !== canonicalKey) {
					delete process.env[key];
				}
			}

			// Emit change event
			await this.emitChangeEvent({
				type: "deleted",
				key: canonicalKey,
				value: null,
				previousValue: previousValue ?? undefined,
				context,
				timestamp: Date.now(),
			});
		} else {
			this.logAccess(
				canonicalKey,
				"delete",
				context,
				false,
				"Secret not found",
			);
		}

		return success;
	}

	/**
	 * Check if a secret exists.
	 * Automatically resolves aliases to canonical names.
	 */
	async exists(key: string, context: SecretContext): Promise<boolean> {
		const canonicalKey = resolveSecretKeyAlias(key);
		const exists = await this.storage.exists(canonicalKey, context);

		// Also check original key for backward compatibility
		if (!exists && key !== canonicalKey) {
			return this.storage.exists(key, context);
		}

		return exists;
	}

	/**
	 * List secrets (metadata only, no values)
	 */
	async list(context: SecretContext): Promise<SecretMetadata> {
		return this.storage.list(context);
	}

	/**
	 * Get secret configuration
	 */
	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		return this.storage.getConfig(key, context);
	}

	/**
	 * Update secret configuration
	 */
	async updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.storage.updateConfig(key, context, config);
	}

	// ============================================================================
	// Convenience Methods
	// ============================================================================

	/**
	 * Get a global secret (agent-level)
	 */
	async getGlobal(key: string): Promise<string | null> {
		return this.get(key, { level: "global", agentId: this.runtime.agentId });
	}

	/**
	 * Set a global secret (agent-level)
	 */
	async setGlobal(
		key: string,
		value: string,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.set(
			key,
			value,
			{ level: "global", agentId: this.runtime.agentId },
			config,
		);
	}

	/**
	 * Get a world secret
	 */
	async getWorld(key: string, worldId: string): Promise<string | null> {
		return this.get(key, {
			level: "world",
			worldId,
			agentId: this.runtime.agentId,
		});
	}

	/**
	 * Set a world secret
	 */
	async setWorld(
		key: string,
		value: string,
		worldId: string,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.set(
			key,
			value,
			{ level: "world", worldId, agentId: this.runtime.agentId },
			config,
		);
	}

	/**
	 * Get a user secret
	 */
	async getUser(key: string, userId: string): Promise<string | null> {
		return this.get(key, {
			level: "user",
			userId,
			agentId: this.runtime.agentId,
			requesterId: userId,
		});
	}

	/**
	 * Set a user secret
	 */
	async setUser(
		key: string,
		value: string,
		userId: string,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.set(
			key,
			value,
			{
				level: "user",
				userId,
				agentId: this.runtime.agentId,
				requesterId: userId,
			},
			config,
		);
	}

	// ============================================================================
	// Validation
	// ============================================================================

	/**
	 * Validate a secret value
	 */
	async validate(
		key: string,
		value: string,
		strategy?: string,
	): Promise<ValidationResult> {
		return validateSecret(key, value, strategy);
	}

	/**
	 * Get available validation strategies
	 */
	getValidationStrategies(): string[] {
		return Object.keys(ValidationStrategies);
	}

	// ============================================================================
	// Plugin Requirements
	// ============================================================================

	/**
	 * Check which secrets are missing for a plugin
	 */
	async checkPluginRequirements(
		_pluginId: string,
		requirements: Record<string, PluginSecretRequirement>,
	): Promise<{
		ready: boolean;
		missingRequired: string[];
		missingOptional: string[];
		invalid: string[];
	}> {
		const missingRequired: string[] = [];
		const missingOptional: string[] = [];
		const invalid: string[] = [];

		for (const [key, requirement] of Object.entries(requirements)) {
			const value = await this.getGlobal(key);

			if (value === null) {
				if (requirement.required) {
					missingRequired.push(key);
				} else {
					missingOptional.push(key);
				}
				continue;
			}

			// Validate if validation method specified
			if (
				requirement.validationMethod &&
				requirement.validationMethod !== "none"
			) {
				const validation = await this.validate(
					key,
					value,
					requirement.validationMethod,
				);
				if (!validation.isValid) {
					invalid.push(key);
				}
			}
		}

		return {
			ready: missingRequired.length === 0 && invalid.length === 0,
			missingRequired,
			missingOptional,
			invalid,
		};
	}

	/**
	 * Get missing secrets for a set of keys
	 */
	async getMissingSecrets(
		keys: string[],
		level: "global" | "world" | "user" = "global",
	): Promise<string[]> {
		const missing: string[] = [];

		for (const key of keys) {
			let exists: boolean;

			switch (level) {
				case "global":
					exists = await this.exists(key, {
						level: "global",
						agentId: this.runtime.agentId,
					});
					break;
				case "world":
				case "user":
					// Would need worldId/userId for these
					exists = false;
					break;
				default:
					exists = false;
			}

			if (!exists) {
				missing.push(key);
			}
		}

		return missing;
	}

	// ============================================================================
	// Change Notifications
	// ============================================================================

	/**
	 * Register a callback for changes to a specific secret
	 */
	onSecretChanged(key: string, callback: SecretChangeCallback): () => void {
		const callbacks = this.changeCallbacks.get(key) ?? [];
		callbacks.push(callback);
		this.changeCallbacks.set(key, callbacks);

		// Return unsubscribe function
		return () => {
			const cbs = this.changeCallbacks.get(key);
			if (cbs) {
				const index = cbs.indexOf(callback);
				if (index !== -1) {
					cbs.splice(index, 1);
				}
			}
		};
	}

	/**
	 * Register a callback for all secret changes
	 */
	onAnySecretChanged(callback: SecretChangeCallback): () => void {
		this.globalChangeCallbacks.push(callback);

		return () => {
			const index = this.globalChangeCallbacks.indexOf(callback);
			if (index !== -1) {
				this.globalChangeCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Emit a change event to registered callbacks
	 */
	private async emitChangeEvent(event: SecretChangeEvent): Promise<void> {
		// Notify key-specific callbacks
		const keyCallbacks = this.changeCallbacks.get(event.key) ?? [];
		for (const callback of keyCallbacks) {
			await callback(event.key, event.value, event.context);
		}

		// Notify global callbacks
		for (const callback of this.globalChangeCallbacks) {
			await callback(event.key, event.value, event.context);
		}

		logger.debug(
			`[SecretsService] Emitted ${event.type} event for ${event.key}`,
		);
	}

	// ============================================================================
	// Access Logging
	// ============================================================================

	/**
	 * Log a secret access attempt
	 */
	private logAccess(
		key: string,
		action: "read" | "write" | "delete" | "share",
		context: SecretContext,
		success: boolean,
		error?: string,
	): void {
		if (!this.secretsConfig.enableAccessLogging) {
			return;
		}

		const log: SecretAccessLog = {
			secretKey: key,
			accessedBy: context.requesterId ?? context.userId ?? context.agentId,
			action,
			timestamp: Date.now(),
			context,
			success,
			error,
		};

		this.accessLogs.push(log);

		// Trim logs if over limit
		if (this.accessLogs.length > this.secretsConfig.maxAccessLogEntries) {
			this.accessLogs = this.accessLogs.slice(
				-this.secretsConfig.maxAccessLogEntries,
			);
		}

		if (!success && error) {
			logger.debug(
				`[SecretsService] Access denied: ${action} ${key} - ${error}`,
			);
		}
	}

	/**
	 * Get access logs
	 */
	getAccessLogs(filter?: {
		key?: string;
		action?: string;
		context?: Partial<SecretContext>;
		since?: number;
	}): SecretAccessLog[] {
		let logs = [...this.accessLogs];

		if (filter?.key) {
			logs = logs.filter((l) => l.secretKey === filter.key);
		}

		if (filter?.action) {
			logs = logs.filter((l) => l.action === filter.action);
		}

		if (filter?.since) {
			const since = filter.since;
			logs = logs.filter((l) => l.timestamp >= since);
		}

		if (filter?.context) {
			logs = logs.filter((l) => {
				if (filter.context?.level && l.context.level !== filter.context?.level)
					return false;
				if (
					filter.context?.worldId &&
					l.context.worldId !== filter.context?.worldId
				)
					return false;
				if (
					filter.context?.userId &&
					l.context.userId !== filter.context?.userId
				)
					return false;
				return true;
			});
		}

		return logs;
	}

	/**
	 * Clear access logs
	 */
	clearAccessLogs(): void {
		this.accessLogs = [];
	}

	// ============================================================================
	// Storage Access
	// ============================================================================

	/**
	 * Get the global storage backend
	 */
	getGlobalStorage(): CharacterSettingsStorage {
		return this.globalStorage;
	}

	/**
	 * Get the world storage backend
	 */
	getWorldStorage(): WorldMetadataStorage {
		return this.worldStorage;
	}

	/**
	 * Get the user storage backend
	 */
	getUserStorage(): ComponentSecretStorage {
		return this.userStorage;
	}

	/**
	 * Get the key manager (for advanced use cases)
	 */
	getKeyManager(): KeyManager {
		return this.keyManager;
	}
}
