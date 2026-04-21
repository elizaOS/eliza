/**
 * Storage Interface Definitions
 *
 * Defines the contract that all storage backends must implement.
 * Designed for ElizaOS native storage patterns.
 */

import type {
	ISecretStorage,
	SecretConfig,
	SecretContext,
	SecretMetadata,
	StorageBackend,
} from "../types.ts";

// Re-export interface for convenience
export type { ISecretStorage };

/**
 * Abstract base class for secret storage implementations
 *
 * Provides common functionality and enforces the storage interface.
 */
export abstract class BaseSecretStorage implements ISecretStorage {
	abstract readonly storageType: StorageBackend;

	abstract initialize(): Promise<void>;

	abstract exists(key: string, context: SecretContext): Promise<boolean>;

	abstract get(key: string, context: SecretContext): Promise<string | null>;

	abstract set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean>;

	abstract delete(key: string, context: SecretContext): Promise<boolean>;

	abstract list(context: SecretContext): Promise<SecretMetadata>;

	abstract getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null>;

	abstract updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean>;

	/**
	 * Create a default secret configuration
	 */
	protected createDefaultConfig(
		key: string,
		context: SecretContext,
		partial?: Partial<SecretConfig>,
	): SecretConfig {
		return {
			type: partial?.type ?? "secret",
			required: partial?.required ?? false,
			description: partial?.description ?? `Secret: ${key}`,
			canGenerate: partial?.canGenerate ?? false,
			validationMethod: partial?.validationMethod,
			status: partial?.status ?? "valid",
			lastError: partial?.lastError,
			attempts: partial?.attempts ?? 0,
			createdAt: partial?.createdAt ?? Date.now(),
			validatedAt: partial?.validatedAt ?? Date.now(),
			plugin: partial?.plugin ?? context.level,
			level: context.level,
			ownerId: context.userId,
			worldId: context.worldId,
			encrypted: partial?.encrypted ?? true,
			permissions: partial?.permissions ?? [],
			sharedWith: partial?.sharedWith ?? [],
			expiresAt: partial?.expiresAt,
		};
	}
}

/**
 * Composite storage that delegates to multiple backends based on context
 */
export class CompositeSecretStorage implements ISecretStorage {
	readonly storageType: StorageBackend = "memory";

	private globalStorage: ISecretStorage;
	private worldStorage: ISecretStorage;
	private userStorage: ISecretStorage;

	constructor(options: {
		globalStorage: ISecretStorage;
		worldStorage: ISecretStorage;
		userStorage: ISecretStorage;
	}) {
		this.globalStorage = options.globalStorage;
		this.worldStorage = options.worldStorage;
		this.userStorage = options.userStorage;
	}

	async initialize(): Promise<void> {
		await Promise.all([
			this.globalStorage.initialize(),
			this.worldStorage.initialize(),
			this.userStorage.initialize(),
		]);
	}

	private getStorageForContext(context: SecretContext): ISecretStorage {
		switch (context.level) {
			case "global":
				return this.globalStorage;
			case "world":
				return this.worldStorage;
			case "user":
				return this.userStorage;
			default:
				return this.globalStorage;
		}
	}

	async exists(key: string, context: SecretContext): Promise<boolean> {
		return this.getStorageForContext(context).exists(key, context);
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		return this.getStorageForContext(context).get(key, context);
	}

	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.getStorageForContext(context).set(key, value, context, config);
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		return this.getStorageForContext(context).delete(key, context);
	}

	async list(context: SecretContext): Promise<SecretMetadata> {
		return this.getStorageForContext(context).list(context);
	}

	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		return this.getStorageForContext(context).getConfig(key, context);
	}

	async updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		return this.getStorageForContext(context).updateConfig(
			key,
			context,
			config,
		);
	}
}
