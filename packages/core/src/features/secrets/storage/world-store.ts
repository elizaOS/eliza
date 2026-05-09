/**
 * World Metadata Storage
 *
 * Stores world-level secrets in the world's metadata.secrets object.
 * This is used for server/channel-specific configuration like Discord tokens.
 */

import { logger } from "../../../logger.ts";
import type { IAgentRuntime, UUID, World } from "../../../types/index.ts";
import { Role } from "../../../types/index.ts";
import { isEncryptedSecret, type KeyManager } from "../crypto/index.ts";
import type {
	EncryptedSecret,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	StorageBackend,
	StoredSecret,
} from "../types.ts";
import { PermissionDeniedError, StorageError } from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

/**
 * Extended metadata with secrets support
 * Using index signature for compatibility with World.metadata
 */
interface WorldMetadataWithSecrets {
	[key: string]: unknown;
	secrets?: Record<string, StoredSecret | string>;
}

/**
 * World metadata-based storage for world-level secrets
 *
 * Secrets are stored in world.metadata.secrets with access control
 * based on world roles (OWNER/ADMIN can write, all members can read).
 */
export class WorldMetadataStorage extends BaseSecretStorage {
	readonly storageType: StorageBackend = "world";

	private runtime: IAgentRuntime;
	private keyManager: KeyManager;
	private worldCache: Map<string, World> = new Map();

	constructor(runtime: IAgentRuntime, keyManager: KeyManager) {
		super();
		this.runtime = runtime;
		this.keyManager = keyManager;
	}

	async initialize(): Promise<void> {
		logger.debug("[WorldMetadataStorage] Initialized");
	}

	async exists(key: string, context: SecretContext): Promise<boolean> {
		if (!context.worldId) {
			return false;
		}

		const secrets = await this.getWorldSecrets(context.worldId);
		return key in secrets;
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		if (!context.worldId) {
			logger.warn("[WorldMetadataStorage] Cannot get secret without worldId");
			return null;
		}

		const secrets = await this.getWorldSecrets(context.worldId);
		const stored = secrets[key];

		if (stored === undefined || stored === null) {
			return null;
		}

		// Handle different storage formats
		if (typeof stored === "string") {
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
		if (!context.worldId) {
			throw new StorageError("Cannot set world secret without worldId");
		}

		// Check write permission
		if (context.requesterId) {
			const hasPermission = await this.checkWritePermission(
				context.worldId,
				context.requesterId,
			);
			if (!hasPermission) {
				throw new PermissionDeniedError(key, "write", context);
			}
		}

		const world = await this.getWorld(context.worldId);
		if (!world) {
			throw new StorageError(`World not found: ${context.worldId}`);
		}

		// Ensure metadata structure exists
		if (!world.metadata) {
			(world as { metadata?: unknown }).metadata = {};
		}
		// Use type assertion to access secrets (stored in world metadata)
		const worldMeta = world.metadata as WorldMetadataWithSecrets;
		if (!worldMeta.secrets) {
			worldMeta.secrets = {};
		}

		const secrets = worldMeta.secrets;
		const existingStored = secrets[key] as StoredSecret | string | undefined;
		const existingConfig =
			typeof existingStored === "object" ? existingStored.config : undefined;

		const fullConfig = this.createDefaultConfig(key, context, {
			...existingConfig,
			...config,
			worldId: context.worldId,
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

		secrets[key] = storedSecret;
		worldMeta.secrets = secrets;

		await this.runtime.updateWorld(world);
		this.worldCache.set(context.worldId, world);

		logger.debug(
			`[WorldMetadataStorage] Set secret: ${key} for world: ${context.worldId}`,
		);
		return true;
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		if (!context.worldId) {
			return false;
		}

		// Check write permission
		if (context.requesterId) {
			const hasPermission = await this.checkWritePermission(
				context.worldId,
				context.requesterId,
			);
			if (!hasPermission) {
				throw new PermissionDeniedError(key, "delete", context);
			}
		}

		const world = await this.getWorld(context.worldId);
		if (!world) {
			return false;
		}
		const metadata = world.metadata as WorldMetadataWithSecrets | undefined;
		if (!metadata?.secrets) {
			return false;
		}

		const secrets = metadata.secrets;
		if (!(key in secrets)) {
			return false;
		}

		delete secrets[key];
		metadata.secrets = secrets;

		await this.runtime.updateWorld(world);
		this.worldCache.set(context.worldId, world);

		logger.debug(
			`[WorldMetadataStorage] Deleted secret: ${key} from world: ${context.worldId}`,
		);
		return true;
	}

	async list(context: SecretContext): Promise<SecretMetadata> {
		if (!context.worldId) {
			return {};
		}

		const secrets = await this.getWorldSecrets(context.worldId);
		const metadata: SecretMetadata = {};

		for (const [key, stored] of Object.entries(secrets)) {
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
				// Legacy string format
				metadata[key] = this.createDefaultConfig(key, context);
			}
		}

		return metadata;
	}

	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		if (!context.worldId) {
			return null;
		}

		const secrets = await this.getWorldSecrets(context.worldId);
		const stored = secrets[key];

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
		if (!context.worldId) {
			return false;
		}

		// Check write permission
		if (context.requesterId) {
			const hasPermission = await this.checkWritePermission(
				context.worldId,
				context.requesterId,
			);
			if (!hasPermission) {
				throw new PermissionDeniedError(key, "write", context);
			}
		}

		const world = await this.getWorld(context.worldId);
		if (!world) {
			return false;
		}
		const metadata = world.metadata as WorldMetadataWithSecrets | undefined;
		if (!metadata?.secrets) {
			return false;
		}

		const secrets = metadata.secrets;
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
			const defaultConfig = this.createDefaultConfig(key, context);
			const storedSecret: StoredSecret = {
				value: stored as string,
				config: { ...defaultConfig, ...config },
			};
			secrets[key] = storedSecret;
		}

		metadata.secrets = secrets;
		await this.runtime.updateWorld(world);
		this.worldCache.set(context.worldId, world);

		return true;
	}

	/**
	 * Get a world from cache or database
	 */
	private async getWorld(worldId: string): Promise<World | null> {
		// Check cache first
		const cached = this.worldCache.get(worldId);
		if (cached) {
			return cached;
		}

		// Load from database
		const world = await this.runtime.getWorld(worldId as UUID);
		if (world) {
			this.worldCache.set(worldId, world);
		}

		return world;
	}

	/**
	 * Get secrets object from world metadata
	 */
	private async getWorldSecrets(
		worldId: string,
	): Promise<Record<string, StoredSecret | string>> {
		const world = await this.getWorld(worldId);
		const metadata = world?.metadata as WorldMetadataWithSecrets | undefined;
		if (!metadata?.secrets) {
			return {};
		}
		return metadata.secrets;
	}

	/**
	 * Check if a user has write permission in a world
	 */
	private async checkWritePermission(
		worldId: string,
		userId: string,
	): Promise<boolean> {
		const world = await this.getWorld(worldId);
		if (!world) {
			return false;
		}

		// Agent always has permission
		if (userId === this.runtime.agentId) {
			return true;
		}

		// Check world roles
		const roles = world.metadata?.roles as Record<string, Role> | undefined;
		if (!roles) {
			return false;
		}

		const userRole = roles[userId];
		return userRole === Role.OWNER || userRole === Role.ADMIN;
	}

	/**
	 * Clear the world cache
	 */
	clearCache(): void {
		this.worldCache.clear();
	}

	/**
	 * Invalidate a specific world in the cache
	 */
	invalidateWorld(worldId: string): void {
		this.worldCache.delete(worldId);
	}
}
