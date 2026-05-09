/**
 * Component Storage
 *
 * Stores user-level secrets as Components in the ElizaOS database.
 * Each user's secrets are isolated via the component's entityId.
 */

import { createUniqueUuid } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import { isEncryptedSecret, type KeyManager } from "../crypto/index.ts";
import type {
	EncryptedSecret,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	StorageBackend,
} from "../types.ts";
import { PermissionDeniedError, StorageError } from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

const COMPONENT_TYPE = "secret";

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

/**
 * Component-based storage for user-level secrets
 *
 * Each secret is stored as a Component with type='secret' and entityId
 * set to the user's ID, providing natural isolation per user.
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

		const component = await this.findSecretComponent(context.userId, key);
		return component !== null;
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		if (!context.userId) {
			logger.warn("[ComponentSecretStorage] Cannot get secret without userId");
			return null;
		}

		// Check permission - only the user can access their own secrets
		if (context.requesterId && context.requesterId !== context.userId) {
			throw new PermissionDeniedError(key, "read", context);
		}

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return null;
		}

		const data = component.data as SecretComponentData;
		if (!data) {
			return null;
		}

		// Check expiration
		if (data.config?.expiresAt && data.config.expiresAt < Date.now()) {
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

		// Check permission - only the user can set their own secrets
		if (context.requesterId && context.requesterId !== context.userId) {
			throw new PermissionDeniedError(key, "write", context);
		}

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
				type: COMPONENT_TYPE,
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

		// Check permission - only the user can delete their own secrets
		if (context.requesterId && context.requesterId !== context.userId) {
			throw new PermissionDeniedError(key, "delete", context);
		}

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

		// Check permission
		if (context.requesterId && context.requesterId !== context.userId) {
			throw new PermissionDeniedError("*", "read", context);
		}

		const components = await this.runtime.getComponents(context.userId as UUID);
		const metadata: SecretMetadata = {};

		for (const component of components) {
			if (component.type !== COMPONENT_TYPE) {
				continue;
			}

			const data = component.data as SecretComponentData;
			if (!data?.key || !data?.config) {
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

		const component = await this.findSecretComponent(context.userId, key);
		if (!component) {
			return null;
		}

		const data = component.data as SecretComponentData;
		return data?.config ? { ...data.config } : null;
	}

	async updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		if (!context.userId) {
			return false;
		}

		// Check permission
		if (context.requesterId && context.requesterId !== context.userId) {
			throw new PermissionDeniedError(key, "write", context);
		}

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
	 * Find a secret component for a user by key
	 */
	private async findSecretComponent(
		userId: string,
		key: string,
	): Promise<Component | null> {
		const components = await this.runtime.getComponents(userId as UUID);

		for (const component of components) {
			if (component.type !== COMPONENT_TYPE) {
				continue;
			}

			const data = component.data as SecretComponentData | undefined;
			if (data?.key === key) {
				return component;
			}
		}

		return null;
	}

	/**
	 * Get all secret keys for a user
	 */
	async listKeys(userId: string): Promise<string[]> {
		const components = await this.runtime.getComponents(userId as UUID);
		const keys: string[] = [];

		for (const component of components) {
			if (component.type !== COMPONENT_TYPE) {
				continue;
			}

			const data = component.data as SecretComponentData;
			if (data?.key) {
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
			if (component.type !== COMPONENT_TYPE) {
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
			if (component.type === COMPONENT_TYPE) {
				count++;
			}
		}

		return count;
	}
}
