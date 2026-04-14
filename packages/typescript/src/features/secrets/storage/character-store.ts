/**
 * Character Settings Storage
 *
 * Stores global secrets in the character's settings.secrets object.
 * This is the primary storage for agent-level configuration and API keys.
 *
 * Note: This implementation directly accesses character.settings rather than
 * using getSetting()/setSetting() because those methods don't support object
 * values - they only return primitives (string | boolean | number | null).
 */

import { logger } from "../../../logger.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import { isEncryptedSecret, type KeyManager } from "../crypto/index.ts";
import type {
	EncryptedSecret,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	StorageBackend,
	StoredSecret,
} from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

const SECRETS_KEY = "secrets";
const METADATA_KEY = "__secrets_metadata";

/**
 * Character settings-based storage for global secrets
 *
 * Secrets are stored in character.settings.secrets with metadata
 * tracked separately for configuration management.
 */
export class CharacterSettingsStorage extends BaseSecretStorage {
	readonly storageType: StorageBackend = "character";

	private runtime: IAgentRuntime;
	private keyManager: KeyManager;
	private initialized: boolean = false;

	constructor(runtime: IAgentRuntime, keyManager: KeyManager) {
		super();
		this.runtime = runtime;
		this.keyManager = keyManager;
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		logger.debug("[CharacterSettingsStorage] Initializing");

		// Ensure settings and secrets objects exist
		this.ensureSettingsStructure();

		this.initialized = true;
		logger.debug("[CharacterSettingsStorage] Initialized");
	}

	/**
	 * Ensure the character.settings.secrets structure exists
	 */
	private ensureSettingsStructure(): void {
		if (!this.runtime.character.settings) {
			this.runtime.character.settings = {};
		}
		if (!this.runtime.character.settings[SECRETS_KEY]) {
			this.runtime.character.settings[SECRETS_KEY] = {};
		}
	}

	async exists(key: string, _context: SecretContext): Promise<boolean> {
		this.ensureSettingsStructure();
		const secrets = this.getSecretsObject();
		return key in secrets;
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		this.ensureSettingsStructure();
		const secrets = this.getSecretsObject();
		const stored = secrets[key];

		if (stored === undefined || stored === null) {
			return null;
		}

		// Handle different storage formats
		if (typeof stored === "string") {
			// Plain string value
			return stored;
		}

		if (typeof stored === "object") {
			const storedSecret = stored as StoredSecret;

			// Check expiration
			if (
				storedSecret.config?.expiresAt &&
				storedSecret.config.expiresAt < Date.now()
			) {
				await this.delete(key, context);
				return null;
			}

			// Handle encrypted value
			if (isEncryptedSecret(storedSecret.value)) {
				return this.keyManager.decrypt(storedSecret.value);
			}

			// Plain value in object form
			if (typeof storedSecret.value === "string") {
				return storedSecret.value;
			}
		}

		return null;
	}

	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		this.ensureSettingsStructure();
		const secrets = this.getSecretsObject();
		const existingStored = secrets[key] as StoredSecret | string | undefined;
		const existingConfig =
			typeof existingStored === "object" ? existingStored.config : undefined;

		const fullConfig = this.createDefaultConfig(key, context, {
			...existingConfig,
			...config,
		});

		// Encrypt value if encryption is enabled
		const shouldEncrypt = fullConfig.encrypted !== false;
		const storedValue: string | EncryptedSecret = shouldEncrypt
			? this.keyManager.encrypt(value)
			: value;

		const storedSecret: StoredSecret = {
			value: storedValue,
			config: fullConfig,
		};

		// Store directly in character.settings.secrets
		secrets[key] = storedSecret;

		logger.debug(`[CharacterSettingsStorage] Set secret: ${key}`);
		return true;
	}

	async delete(key: string, _context: SecretContext): Promise<boolean> {
		this.ensureSettingsStructure();
		const secrets = this.getSecretsObject();

		if (!(key in secrets)) {
			return false;
		}

		delete secrets[key];

		logger.debug(`[CharacterSettingsStorage] Deleted secret: ${key}`);
		return true;
	}

	async list(_context: SecretContext): Promise<SecretMetadata> {
		const secrets = this.getSecretsObject();
		const metadata: SecretMetadata = {};

		for (const [key, stored] of Object.entries(secrets)) {
			if (key === METADATA_KEY) {
				continue;
			}

			if (typeof stored === "object" && stored !== null) {
				const storedSecret = stored as StoredSecret;

				// Check expiration
				if (
					storedSecret.config?.expiresAt &&
					storedSecret.config.expiresAt < Date.now()
				) {
					continue;
				}

				if (storedSecret.config) {
					metadata[key] = { ...storedSecret.config };
				}
			} else {
				// Legacy string-only format
				metadata[key] = this.createDefaultConfig(key, {
					level: "global",
					agentId: this.runtime.agentId,
				});
			}
		}

		return metadata;
	}

	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		const secrets = this.getSecretsObject();
		const stored = secrets[key];

		if (!stored) {
			return null;
		}

		if (typeof stored === "object" && "config" in stored) {
			return { ...(stored as StoredSecret).config };
		}

		// Legacy format - create default config
		return this.createDefaultConfig(key, context);
	}

	async updateConfig(
		key: string,
		_context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		this.ensureSettingsStructure();
		const secrets = this.getSecretsObject();
		const stored = secrets[key];

		if (!stored) {
			return false;
		}

		if (typeof stored === "object" && "config" in stored) {
			const storedSecret = stored as StoredSecret;
			storedSecret.config = {
				...storedSecret.config,
				...config,
			};
			secrets[key] = storedSecret;
		} else {
			// Upgrade legacy format
			const defaultConfig = this.createDefaultConfig(key, {
				level: "global",
				agentId: this.runtime.agentId,
			});
			const storedSecret: StoredSecret = {
				value: stored as string,
				config: { ...defaultConfig, ...config },
			};
			secrets[key] = storedSecret;
		}

		return true;
	}

	/**
	 * Get the secrets object from character settings
	 *
	 * Accesses character.settings.secrets directly instead of using getSetting()
	 * because getSetting() only returns primitives, not objects.
	 */
	private getSecretsObject(): Record<string, StoredSecret | string> {
		this.ensureSettingsStructure();
		const settings = this.runtime.character.settings as Record<string, unknown>;
		const secrets = settings[SECRETS_KEY];

		if (!secrets || typeof secrets !== "object") {
			return {};
		}

		return secrets as Record<string, StoredSecret | string>;
	}

	/**
	 * Migrate legacy environment variable format to new format
	 */
	async migrateFromEnvVars(envVarPrefix: string = "ENV_"): Promise<number> {
		let migrated = 0;
		const settings = this.runtime.character?.settings ?? {};

		for (const [key, value] of Object.entries(settings)) {
			if (key.startsWith(envVarPrefix) && typeof value === "string") {
				const secretKey = key.slice(envVarPrefix.length);
				const exists = await this.exists(secretKey, {
					level: "global",
					agentId: this.runtime.agentId,
				});

				if (!exists) {
					await this.set(
						secretKey,
						value,
						{ level: "global", agentId: this.runtime.agentId },
						{
							description: `Migrated from ${key}`,
							encrypted: true,
						},
					);
					migrated++;
				}
			}
		}

		logger.info(
			`[CharacterSettingsStorage] Migrated ${migrated} env vars to secrets`,
		);
		return migrated;
	}

	/**
	 * Get a secret as an environment variable (for backward compatibility)
	 */
	async getAsEnvVar(key: string): Promise<string | null> {
		return this.get(key, { level: "global", agentId: this.runtime.agentId });
	}

	/**
	 * Sync a secret to process.env (for plugins that read env vars directly)
	 */
	async syncToEnv(key: string, envVarName?: string): Promise<boolean> {
		const value = await this.getAsEnvVar(key);
		if (value === null) {
			return false;
		}

		const envKey = envVarName ?? key;
		process.env[envKey] = value;
		return true;
	}

	/**
	 * Sync all secrets to process.env
	 */
	async syncAllToEnv(): Promise<number> {
		const metadata = await this.list({
			level: "global",
			agentId: this.runtime.agentId,
		});
		let synced = 0;

		for (const key of Object.keys(metadata)) {
			if (await this.syncToEnv(key)) {
				synced++;
			}
		}

		return synced;
	}
}
