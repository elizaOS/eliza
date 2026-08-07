/**
 * Non-decrypting secret storage backed by a vendor-neutral broker client.
 * Reads expose serialized references only; credential material is resolved at
 * use time outside the runtime. Broker failures always throw so an outage can
 * never be mistaken for a missing secret or an empty metadata set.
 */

import { logger } from "../../../logger.ts";
import type {
	ISecretBrokerClient,
	SecretConfig,
	SecretContext,
	SecretHandle,
	SecretMetadata,
	StorageBackend,
} from "../types.ts";
import { serializeSecretHandle } from "../types.ts";
import type { SecretsBrokerConfig } from "./broker-config.ts";
import { SecretsBrokerUnavailableError } from "./broker-config.ts";
import { BaseSecretStorage } from "./interface.ts";

/**
 * Non-decrypting, broker-backed secret storage.
 *
 * `get` returns a SERIALIZED {@link SecretHandle}, never plaintext. `set`
 * delegates to the broker's optional write path, or REFUSES when the broker is
 * read-only (the runtime is not permitted to hand tenant credentials to the
 * broker). `list`/`getConfig` expose metadata only \u2014 never values.
 */
export class BrokerSecretStorage extends BaseSecretStorage {
	readonly storageType: StorageBackend = "broker";

	private readonly broker: ISecretBrokerClient;
	private readonly config: SecretsBrokerConfig;

	constructor(broker: ISecretBrokerClient, config: SecretsBrokerConfig) {
		super();
		this.broker = broker;
		this.config = config;
	}

	async initialize(): Promise<void> {
		logger.info(
			`[BrokerSecretStorage] Non-decrypting broker backend active (${this.config.url}). ` +
				`Reads return handles, never plaintext.`,
		);
	}

	/**
	 * Whether the broker holds this secret. Fail-closed under strict mode: a
	 * broker error becomes a thrown {@link SecretsBrokerUnavailableError} rather
	 * than a silent `false` that could let a local store answer with plaintext.
	 */
	async exists(key: string, context: SecretContext): Promise<boolean> {
		try {
			return await this.broker.hasSecret(key, context);
		} catch (error) {
			// error-policy:J2 normalize broker failures while preserving the cause
			throw this.brokerError(error);
		}
	}

	/**
	 * NON-DECRYPTING READ. Returns a serialized {@link SecretHandle}, or `null`
	 * when the broker has no such secret. NEVER returns plaintext and NEVER
	 * touches the local decrypt path.
	 */
	async get(key: string, context: SecretContext): Promise<string | null> {
		let handle: SecretHandle | null;
		try {
			handle = await this.broker.issueHandle(key, context);
		} catch (error) {
			// error-policy:J2 normalize broker failures while preserving the cause
			throw this.brokerError(error);
		}
		if (!handle) return null;
		// Defense-in-depth: never let a misbehaving broker smuggle a raw value
		// through the handle path. The handle carries only a reference.
		return serializeSecretHandle({
			marker: handle.marker,
			ref: handle.ref,
			key: handle.key,
			resolveVia: handle.resolveVia,
			brokerUrl: handle.brokerUrl ?? this.config.url,
			expiresAt: handle.expiresAt,
		});
	}

	/**
	 * WRITE path. Delegates to the broker's optional `storeSecret`. When the
	 * broker is read-only (no `storeSecret`), this REFUSES \u2014 returns `false` \u2014
	 * because there is no local encrypted store to silently fall back to, and
	 * writing a plaintext credential anywhere would defeat the invariant.
	 */
	async set(
		key: string,
		value: string,
		context: SecretContext,
		_config?: Partial<SecretConfig>,
	): Promise<boolean> {
		if (!this.broker.storeSecret) {
			logger.warn(
				`[BrokerSecretStorage] Broker is read-only; refusing to write secret '${key}'. ` +
					`No local fallback (the broker backend never holds plaintext).`,
			);
			return false;
		}
		try {
			return await this.broker.storeSecret(key, value, context);
		} catch (error) {
			// error-policy:J2 normalize broker failures while preserving the cause
			throw this.brokerError(error);
		}
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		if (!this.broker.deleteSecret) {
			return false;
		}
		try {
			return await this.broker.deleteSecret(key, context);
		} catch (error) {
			// error-policy:J2 normalize broker failures while preserving the cause
			throw this.brokerError(error);
		}
	}

	/** Metadata only \u2014 never values. */
	async list(context: SecretContext): Promise<SecretMetadata> {
		if (!this.broker.listSecrets) {
			return {};
		}
		try {
			return await this.broker.listSecrets(context);
		} catch (error) {
			// error-policy:J2 normalize broker failures while preserving the cause
			throw this.brokerError(error);
		}
	}

	/**
	 * Broker stores expose no per-key config surface of their own (the broker
	 * owns lifecycle/expiry). Returns `null` rather than fabricating a config.
	 */
	async getConfig(
		_key: string,
		_context: SecretContext,
	): Promise<SecretConfig | null> {
		return null;
	}

	/** Config is broker-owned; updates are a no-op refusal. */
	async updateConfig(
		_key: string,
		_context: SecretContext,
		_config: Partial<SecretConfig>,
	): Promise<boolean> {
		return false;
	}

	private brokerError(error: unknown): SecretsBrokerUnavailableError {
		return error instanceof SecretsBrokerUnavailableError
			? error
			: new SecretsBrokerUnavailableError(this.config.url, error);
	}
}
