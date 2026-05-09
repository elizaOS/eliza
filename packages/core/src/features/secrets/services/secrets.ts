/**
 * Secrets Service
 *
 * Core service for multi-level secret management in ElizaOS.
 * Provides an API for accessing global, world, and user secrets
 * with encryption, access control, and change notification support.
 */

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

		const isSandboxMode = Boolean(
			this.runtime && "sandboxMode" in this.runtime && this.runtime.sandboxMode,
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
		this.logAccess(key, "read", context, true);

		const value = await this.storage.get(key, context);

		if (value === null) {
			this.logAccess(key, "read", context, false, "Secret not found");
		}

		return value;
	}

	/**
	 * Set a secret value.
	 */
	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		this.logAccess(key, "write", context, true);

		if (config?.validationMethod && config.validationMethod !== "none") {
			const validation = await this.validate(
				key,
				value,
				config.validationMethod,
			);
			if (!validation.isValid) {
				this.logAccess(
					key,
					"write",
					context,
					false,
					`Validation failed: ${validation.error}`,
				);
				throw new SecretsError(
					`Validation failed for ${key}: ${validation.error}`,
					"VALIDATION_FAILED",
					{ key, error: validation.error },
				);
			}
		}

		const previousValue = await this.storage.get(key, context);

		const success = await this.storage.set(key, value, context, config);

		if (success) {
			if (context.level === "global" && this.mirrorSecretsToProcessEnv) {
				await this.globalStorage.syncToEnv(key);
			}

			await this.emitChangeEvent({
				type: previousValue === null ? "created" : "updated",
				key,
				value,
				previousValue: previousValue ?? undefined,
				context,
				timestamp: Date.now(),
			});
		} else {
			this.logAccess(key, "write", context, false, "Storage operation failed");
		}

		return success;
	}

	/**
	 * Delete a secret.
	 */
	async delete(key: string, context: SecretContext): Promise<boolean> {
		this.logAccess(key, "delete", context, true);

		const previousValue = await this.storage.get(key, context);
		const success = await this.storage.delete(key, context);

		if (success) {
			if (context.level === "global" && this.mirrorSecretsToProcessEnv) {
				delete process.env[key];
			}

			await this.emitChangeEvent({
				type: "deleted",
				key,
				value: null,
				previousValue: previousValue ?? undefined,
				context,
				timestamp: Date.now(),
			});
		} else {
			this.logAccess(key, "delete", context, false, "Secret not found");
		}

		return success;
	}

	/**
	 * Check if a secret exists.
	 */
	async exists(key: string, context: SecretContext): Promise<boolean> {
		return this.storage.exists(key, context);
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
