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

		if (typeof stored === "object") {
			const storedSecret = stored as StoredSecret;

			// Check expiration
			if (
				storedSecret.config.expiresAt &&
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
		const existingStored = secrets[key];
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
					storedSecret.config.expiresAt &&
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

		return null;
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

		if (!(typeof stored === "object" && "config" in stored)) {
			return false;
		}

		const storedSecret = stored as StoredSecret;
		storedSecret.config = {
			...storedSecret.config,
			...config,
		};
		secrets[key] = storedSecret;

		return true;
	}

	/**
	 * Get the secrets object from character settings
	 *
	 * Accesses character.settings.secrets directly instead of using getSetting()
	 * because getSetting() only returns primitives, not objects.
	 */
	private getSecretsObject(): Record<string, StoredSecret> {
		this.ensureSettingsStructure();
		const settings = this.runtime.character.settings as Record<string, unknown>;
		const secrets = settings[SECRETS_KEY];

		if (!secrets || typeof secrets !== "object") {
			return {};
		}

		return secrets as Record<string, StoredSecret>;
	}

}
