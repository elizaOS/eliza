/**
 * Broker-backed non-decrypting secret storage (issue #11536, phase E4).
 *
 * ============================================================================
 *  NON-DECRYPTING INVARIANT (the whole point of this file)
 * ----------------------------------------------------------------------------
 *  This store NEVER returns a plaintext secret value and NEVER calls the local
 *  AES-GCM decrypt path (`crypto/encryption.ts`). Its `get`/read path returns a
 *  {@link SecretHandle} \u2014 a reference to the secret \u2014 serialized as an opaque,
 *  detectably-non-credential string. The real credential is resolved only at
 *  USE-TIME, outside the runtime, through the already-shipped seams: the model
 *  gateway (E1/E2) for provider keys and the credential proxy (E3) for
 *  arbitrary API credentials. The broker injects the credential outbound
 *  (header-only) and the runtime never holds it.
 *
 *  This is the "eliza enterprise" guarantee: on shared/cloud infra the operator
 *  can prove the runtime CANNOT exfiltrate tenant credentials, because a broker
 *  store literally has no code path that yields plaintext. There is
 *  deliberately no `KeyManager`, no `decrypt`, no encryption import in this
 *  module \u2014 if plaintext isn't reachable, it can't leak.
 * ============================================================================
 *
 * Vendor-neutral: the store talks to an {@link ISecretBrokerClient}. Steward is
 * the reference broker; this file has no branded import.
 *
 * @module features/secrets/storage/broker-store
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
			return this.onBrokerError(error, false);
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
			return this.onBrokerError(error, null);
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
			return this.onBrokerError(error, false);
		}
	}

	async delete(key: string, context: SecretContext): Promise<boolean> {
		if (!this.broker.deleteSecret) {
			return false;
		}
		try {
			return await this.broker.deleteSecret(key, context);
		} catch (error) {
			return this.onBrokerError(error, false);
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
			return this.onBrokerError(error, {} as SecretMetadata);
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

	/**
	 * Central fail-closed vs fail-soft decision. Under strict mode any broker
	 * error is fatal (throw) so the caller cannot degrade to a plaintext-capable
	 * local store; otherwise the error is logged and the soft default returned.
	 */
	private onBrokerError<T>(error: unknown, soft: T): T {
		if (this.config.strict) {
			if (error instanceof SecretsBrokerUnavailableError) throw error;
			throw new SecretsBrokerUnavailableError(this.config.url, error);
		}
		logger.warn(
			`[BrokerSecretStorage] Broker error (non-strict, returning soft default): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return soft;
	}
}
