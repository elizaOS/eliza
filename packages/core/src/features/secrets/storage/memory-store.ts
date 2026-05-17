/**
 * Memory-based Secret Storage
 *
 * In-memory storage backend for secrets. Useful for testing and
 * ephemeral environments where persistence is not required.
 */

import type {
	SecretConfig,
	SecretContext,
	SecretMetadata,
	StorageBackend,
} from "../types.ts";
import { BaseSecretStorage } from "./interface.ts";

/**
 * Internal storage entry combining value and config
 */
interface StorageEntry {
	value: string;
	config: SecretConfig;
}

/**
 * Memory-based secret storage implementation
 */
export class MemorySecretStorage extends BaseSecretStorage {
	readonly storageType: StorageBackend = "memory";

	private store: Map<string, StorageEntry> = new Map();

	async initialize(): Promise<void> {
		// Nothing to initialize for memory storage
	}

	async exists(key: string, context: SecretContext): Promise<boolean> {
		const storageKey = this.generateStorageKey(key, context);
		return this.store.has(storageKey);
	}

	async get(key: string, context: SecretContext): Promise<string | null> {
		const storageKey = this.generateStorageKey(key, context);
		const entry = this.store.get(storageKey);
		if (!entry) {
			return null;
		}

		// Check expiration
		if (entry.config.expiresAt && entry.config.expiresAt < Date.now()) {
			this.store.delete(storageKey);
			return null;
		}

		return entry.value;
	}

	async set(
		key: string,
		value: string,
		context: SecretContext,
		config?: Partial<SecretConfig>,
	): Promise<boolean> {
		const storageKey = this.generateStorageKey(key, context);
		const existingEntry = this.store.get(storageKey);

		const fullConfig = this.createDefaultConfig(key, context, {
			...existingEntry?.config,
			...config,
		});

		this.store.set(storageKey, {
			value,
			config: fullConfig,
		});

		return true;
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		const storageKey = this.generateStorageKey(key, context);
		return this.store.delete(storageKey);
	}

	async list(context: SecretContext): Promise<SecretMetadata> {
		const prefix = this.getContextPrefix(context);
		const metadata: SecretMetadata = {};

		for (const [storageKey, entry] of this.store) {
			if (storageKey.startsWith(prefix)) {
				const originalKey = this.extractOriginalKey(storageKey, context);
				if (originalKey) {
					// Check expiration
					if (entry.config.expiresAt && entry.config.expiresAt < Date.now()) {
						this.store.delete(storageKey);
						continue;
					}
					metadata[originalKey] = { ...entry.config };
				}
			}
		}

		return metadata;
	}

	async getConfig(
		key: string,
		context: SecretContext,
	): Promise<SecretConfig | null> {
		const storageKey = this.generateStorageKey(key, context);
		const entry = this.store.get(storageKey);
		if (!entry) {
			return null;
		}
		return { ...entry.config };
	}

	async updateConfig(
		key: string,
		context: SecretContext,
		config: Partial<SecretConfig>,
	): Promise<boolean> {
		const storageKey = this.generateStorageKey(key, context);
		const entry = this.store.get(storageKey);
		if (!entry) {
			return false;
		}

		entry.config = {
			...entry.config,
			...config,
		};

		this.store.set(storageKey, entry);
		return true;
	}

	/**
	 * Generate a storage key from the secret key and context
	 */
	private generateStorageKey(key: string, context: SecretContext): string {
		switch (context.level) {
			case "global":
				return `global:${context.agentId}:${key}`;
			case "world":
				return `world:${context.worldId}:${key}`;
			case "user":
				return `user:${context.userId}:${key}`;
			default:
				return `unknown:${key}`;
		}
	}

	/**
	 * Get the storage key prefix for a context level
	 */
	private getContextPrefix(context: SecretContext): string {
		switch (context.level) {
			case "global":
				return `global:${context.agentId}:`;
			case "world":
				return `world:${context.worldId}:`;
			case "user":
				return `user:${context.userId}:`;
			default:
				return "";
		}
	}

	/**
	 * Extract the original key from a storage key
	 */
	private extractOriginalKey(
		storageKey: string,
		context: SecretContext,
	): string | null {
		const prefix = this.getContextPrefix(context);
		if (!storageKey.startsWith(prefix)) {
			return null;
		}
		return storageKey.slice(prefix.length);
	}

	/**
	 * Clear all stored secrets (for testing)
	 */
	clear(): void {
		this.store.clear();
	}

	/**
	 * Get the number of stored secrets (for testing)
	 */
	size(): number {
		return this.store.size;
	}
}
