/**
 * Character Settings Storage
 *
 * Stores global secrets for the agent: the encrypted record with its config
 * in memory for this runtime (never in `character.settings`, so no character
 * export, serializer or import carries it), and the live string through
 * `runtime.setSetting(key, value, true)` so `runtime.getSetting` returns it.
 * Keys loaded at boot stay as plain strings in `character.settings.secrets`.
 *
 * Note: This implementation reads character.settings directly for the
 * records because getSetting() only returns primitives, not objects.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, resolveCanonicalOwnerId } from "@elizaos/core";
import { isEncryptedSecret, type KeyManager } from "../crypto/encryption.ts";
import type {
  EncryptedSecret,
  SecretConfig,
  SecretContext,
  SecretMetadata,
  SecretPermissionType,
  StorageBackend,
  StoredSecret,
} from "../types.ts";
import { PermissionDeniedError } from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

const SECRETS_KEY = "secrets";
/**
 * Encrypted records written by this store, per runtime. They are not in
 * `settings.secrets`: the runtime aliases it to `character.secrets` and
 * `getSetting` reads only strings from there, so a record there was unreadable
 * by every plugin and replaced a key loaded at boot. They are not in any other
 * `settings` key either: the agent export strips only the declared secret
 * containers, so a record there would ship in a credential-free bundle.
 */
const RECORDS = new WeakMap<IAgentRuntime, Record<string, StoredSecret>>();
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

  async exists(key: string, context: SecretContext): Promise<boolean> {
    this.assertGlobalAccess(key, "read", context);
    this.ensureSettingsStructure();
    return key in this.getStoreObject() || key in this.getSecretsObject();
  }

  async get(key: string, context: SecretContext): Promise<string | null> {
    this.assertGlobalAccess(key, "read", context);
    this.ensureSettingsStructure();
    const stored = this.getStoreObject()[key] ?? this.getSecretsObject()[key];

    if (stored === undefined || stored === null) {
      return null;
    }

    if (typeof stored === "string") {
      return stored;
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
    this.assertGlobalAccess(key, "write", context);
    this.ensureSettingsStructure();
    const store = this.getStoreObject();
    const existingStored = store[key] ?? this.getSecretsObject()[key];
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

    store[key] = storedSecret;
    // The live string is what `runtime.getSetting` hands to plugins.
    this.runtime.setSetting(key, value, true);

    logger.debug(`[CharacterSettingsStorage] Set secret: ${key}`);
    return true;
  }

  async delete(key: string, context: SecretContext): Promise<boolean> {
    this.assertGlobalAccess(key, "delete", context);
    this.ensureSettingsStructure();
    const store = this.getStoreObject();
    const secrets = this.getSecretsObject();

    if (!(key in store) && !(key in secrets)) {
      return false;
    }

    delete store[key];
    delete secrets[key];
    this.runtime.setSetting(key, null, true);

    logger.debug(`[CharacterSettingsStorage] Deleted secret: ${key}`);
    return true;
  }

  async list(context: SecretContext): Promise<SecretMetadata> {
    this.assertGlobalAccess("*", "read", context);
    const store = this.getStoreObject();
    const metadata: SecretMetadata = {};

    for (const [key, stored] of [
      ...Object.entries(store),
      ...Object.entries(this.getSecretsObject()).filter(
        ([key]) => !(key in store),
      ),
    ]) {
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
    this.assertGlobalAccess(key, "read", context);
    const stored = this.getStoreObject()[key] ?? this.getSecretsObject()[key];

    if (!stored) {
      return null;
    }

    if (typeof stored === "object" && "config" in stored) {
      return { ...(stored as StoredSecret).config };
    }

    return this.createDefaultConfig(key, context);
  }

  async updateConfig(
    key: string,
    context: SecretContext,
    config: Partial<SecretConfig>,
  ): Promise<boolean> {
    this.assertGlobalAccess(key, "write", context);
    this.ensureSettingsStructure();
    const store = this.getStoreObject();
    const stored = store[key] ?? this.getSecretsObject()[key];

    if (!stored) {
      return false;
    }

    const storedSecret =
      typeof stored === "object" && "config" in stored
        ? (stored as StoredSecret)
        : ({
            value: stored as string,
            config: this.createDefaultConfig(key, context),
          } satisfies StoredSecret);
    storedSecret.config = {
      ...storedSecret.config,
      ...config,
    };
    store[key] = storedSecret;

    return true;
  }

  /** Encrypted records this store wrote for this runtime (in memory only). */
  private getStoreObject(): Record<string, StoredSecret> {
    let records = RECORDS.get(this.runtime);
    if (!records) {
      records = {};
      RECORDS.set(this.runtime, records);
    }
    return records;
  }

  /**
   * Get the secrets object from character settings: keys loaded at boot
   * (plain strings) and records written there by earlier versions.
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

  private assertGlobalAccess(
    key: string,
    action: SecretPermissionType,
    context: SecretContext,
  ): void {
    const requesterId = context.requesterId;
    if (!requesterId) {
      throw new PermissionDeniedError(key, action, context);
    }

    if (requesterId === this.runtime.agentId) {
      return;
    }

    const ownerId = resolveCanonicalOwnerId(this.runtime);
    if (ownerId && requesterId === ownerId) {
      return;
    }

    throw new PermissionDeniedError(key, action, context);
  }
}
