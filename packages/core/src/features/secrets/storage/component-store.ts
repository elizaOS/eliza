/**
 * Persists per-user secrets as runtime components.
 * The SQL adapter uniquely keys components by (entityId, type, worldId,
 * sourceEntityId), so the secret name must live in `type` (`secret:${key}`).
 * A type of just `secret` can hold only one row per user and is read as the
 * pre-keying layout. `getComponents(entityId)` is not agent-scoped, so reads
 * and deletes keep only rows whose `agentId` is this runtime.
 */

import { createUniqueUuid } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import { isEncryptedSecret, type KeyManager } from "../crypto/encryption.ts";
import type {
	EncryptedSecret,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	SecretPermissionType,
	StorageBackend,
} from "../types.ts";
import { PermissionDeniedError, StorageError } from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

const LEGACY_USER_SECRET_COMPONENT_TYPE = "secret";
const USER_SECRET_COMPONENT_PREFIX = "secret:";

function userSecretComponentType(key: string): string {
	return `${USER_SECRET_COMPONENT_PREFIX}${key}`;
}

function belongsToRuntimeAgent(component: Component, agentId: UUID): boolean {
	return component.agentId === agentId;
}

/**
 * Component data structure for secret storage
 * Index signature added for Metadata compatibility
 */
interface SecretComponentData {
	key: string;
	value: string | EncryptedSecret;
	config: SecretConfig;
	updatedAt: number;
	[key: string]: string | EncryptedSecret | SecretConfig | number | undefined;
}

function readSecretComponentData(
	component: Component,
): SecretComponentData | undefined {
	const data = component.data;
	if (!data || typeof data !== "object") return undefined;
	const candidate = data as Partial<SecretComponentData>;
	if (
		typeof candidate.key !== "string" ||
		(typeof candidate.value !== "string" &&
			!isEncryptedSecret(candidate.value)) ||
		!candidate.config ||
		typeof candidate.config !== "object" ||
		typeof candidate.updatedAt !== "number"
	) {
		return undefined;
	}
	return candidate as SecretComponentData;
}

function isUserSecretComponent(
	component: Component,
	data: SecretComponentData,
): boolean {
	return (
		component.type === LEGACY_USER_SECRET_COMPONENT_TYPE ||
		component.type === userSecretComponentType(data.key)
	);
}

/**
 * Component-based storage for user-level secrets.
 *
 * Each secret is a component on the user entity. `type` is `secret:${key}` so
 * two keys do not share the SQL natural key. Rows still typed `secret` are
 * the one-key-per-user layout and stay readable.
 */
export class ComponentSecretStorage extends BaseSecretStorage {
	readonly storageType: StorageBackend = "component";

	private runtime: IAgentRuntime;
	private keyManager: KeyManager;

	constructor(runtime: IAgentRuntime, keyManager: KeyManager) {
		super();
		this.runtime = runtime;
		this.keyManager = keyManager;
	}

	async initialize(): Promise<void> {
		logger.debug("[ComponentSecretStorage] Initialized");
	}

	async exists(key: string, context: SecretContext): Promise<boolean> {
		if (!context.userId) {
			return false;
		}
		this.assertUserAccess(key, "read", context);

		const component = await this.findSecretComponent(context.userId, key);
		return component !== null;
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		if (!context.userId) {
			logger.warn("[ComponentSecretStorage] Cannot get secret without userId");
			return null;
		}

		this.assertUserAccess(key, "read", context);

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return null;
		}

		const data = component.data as SecretComponentData;
		if (!data) {
			return null;
		}

		// Check expiration
		if (data.config.expiresAt && data.config.expiresAt < Date.now()) {
			await this.delete(key, context);
			return null;
		}

		// Handle encrypted value
		if (isEncryptedSecret(data.value)) {
			return this.keyManager.decrypt(data.value);
		}

		if (typeof data.value === "string") {
			return data.value;
		}

		return null;
	}

	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		if (!context.userId) {
			throw new StorageError("Cannot set user secret without userId");
		}

		this.assertUserAccess(key, "write", context);

		const existingComponent = await this.findSecretComponent(
			context.userId,
			key,
		);
		const existingData = existingComponent?.data as
			| SecretComponentData
			| undefined;
		const existingConfig = existingData?.config;

		const fullConfig = this.createDefaultConfig(key, context, {
			...existingConfig,
			...config,
			ownerId: context.userId,
		});

		// Encrypt value if encryption is enabled
		const shouldEncrypt = fullConfig.encrypted !== false;
		const storedValue: string | EncryptedSecret = shouldEncrypt
			? this.keyManager.encrypt(value)
			: value;

		const componentData: SecretComponentData = {
			key,
			value: storedValue,
			config: fullConfig,
			updatedAt: Date.now(),
		};

		if (existingComponent) {
			// Update existing component
			await this.runtime.updateComponent({
				...existingComponent,
				data: componentData as Component["data"],
			});
			logger.debug(
				`[ComponentSecretStorage] Updated secret: ${key} for user: ${context.userId}`,
			);
		} else {
			// Create new component
			const newComponent: Component = {
				id: createUniqueUuid(this.runtime, `${context.userId}-secret-${key}`),
				createdAt: Date.now(),
				entityId: context.userId as UUID,
				agentId: this.runtime.agentId,
				roomId: this.runtime.agentId,
				worldId: this.runtime.agentId,
				sourceEntityId: context.userId as UUID,
				type: userSecretComponentType(key),
				data: componentData as Component["data"],
			};

			await this.runtime.createComponent(newComponent);
			logger.debug(
				`[ComponentSecretStorage] Created secret: ${key} for user: ${context.userId}`,
			);
		}

		return true;
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		if (!context.userId) {
			return false;
		}

		this.assertUserAccess(key, "delete", context);

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return false;
		}

		await this.runtime.deleteComponent(component.id);
		logger.debug(
			`[ComponentSecretStorage] Deleted secret: ${key} for user: ${context.userId}`,
		);
		return true;
	}

	async list(context: SecretContext): Promise<SecretMetadata> {
		if (!context.userId) {
			return {};
		}

		this.assertUserAccess("*", "read", context);

		const components = await this.runtime.getComponents(context.userId as UUID);
		const metadata: SecretMetadata = {};

		for (const component of components) {
			const data = this.readOwnUserSecretComponent(component);
			if (!data) {
				continue;
			}

			// Check expiration
			if (data.config.expiresAt && data.config.expiresAt < Date.now()) {
				continue;
			}

			metadata[data.key] = { ...data.config };
		}

		return metadata;
	}

	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		if (!context.userId) {
			return null;
		}
		this.assertUserAccess(key, "read", context);

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return null;
		}

		const data = component.data as SecretComponentData;
		return data.config ? { ...data.config } : null;
	}

	async updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		if (!context.userId) {
			return false;
		}

		this.assertUserAccess(key, "write", context);

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return false;
		}

		const data = component.data as SecretComponentData;
		if (!data) {
			return false;
		}

		data.config = {
			...data.config,
			...config,
		};
		data.updatedAt = Date.now();

		await this.runtime.updateComponent({
			...component,
			data: data as Component["data"],
		});

		return true;
	}

	/**
	 * Find a secret component for a user by key.
	 * Prefer the keyed type so a same-name legacy `secret` row is not chosen
	 * over `secret:${key}` after a mixed-layout upgrade.
	 */
	private async findSecretComponent(
		userId: string,
		key: string,
	): Promise<Component | null> {
		const components = await this.runtime.getComponents(userId as UUID);
		const keyedType = userSecretComponentType(key);
		let legacy: Component | null = null;

		for (const component of components) {
			if (!belongsToRuntimeAgent(component, this.runtime.agentId)) {
				continue;
			}
			const data = readSecretComponentData(component);
			if (data?.key !== key) continue;
			if (component.type === keyedType) {
				return component;
			}
			if (
				component.type === LEGACY_USER_SECRET_COMPONENT_TYPE &&
				data?.key === key
			) {
				legacy = component;
			}
		}

		return legacy;
	}

	private readOwnUserSecretComponent(
		component: Component,
	): SecretComponentData | undefined {
		if (!belongsToRuntimeAgent(component, this.runtime.agentId)) {
			return undefined;
		}
		const data = readSecretComponentData(component);
		return data && isUserSecretComponent(component, data) ? data : undefined;
	}

	private assertUserAccess(
		key: string,
		action: SecretPermissionType,
		context: SecretContext,
	): void {
		if (!context.requesterId || context.requesterId !== context.userId) {
			throw new PermissionDeniedError(key, action, context);
		}
	}

	/**
	 * Get all secret keys for a user
	 */
	async listKeys(userId: string): Promise<string[]> {
		const components = await this.runtime.getComponents(userId as UUID);
		const keys: string[] = [];

		for (const component of components) {
			const data = this.readOwnUserSecretComponent(component);
			if (!data) {
				continue;
			}
			if (data.key) {
				keys.push(data.key);
			}
		}

		return keys;
	}

	/**
	 * Delete all secrets for a user
	 */
	async deleteAllForUser(userId: string): Promise<number> {
		const components = await this.runtime.getComponents(userId as UUID);
		let deleted = 0;

		for (const component of components) {
			if (!this.readOwnUserSecretComponent(component)) {
				continue;
			}

			await this.runtime.deleteComponent(component.id);
			deleted++;
		}

		logger.info(
			`[ComponentSecretStorage] Deleted ${deleted} secrets for user: ${userId}`,
		);
		return deleted;
	}

	/**
	 * Count secrets for a user
	 */
	async countForUser(userId: string): Promise<number> {
		const components = await this.runtime.getComponents(userId as UUID);
		let count = 0;

		for (const component of components) {
			if (this.readOwnUserSecretComponent(component)) {
				count++;
			}
		}

		return count;
	}
}
